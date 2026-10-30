import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, commitFixture } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { runHarness } from './index.mjs';
import { renderSbiBody } from './planner.mjs';
import { git } from './workspace.mjs';
import { readJson } from './io.mjs';
import { specApprovalLine, specDigest } from './spec-approval.mjs';
import { generatedVerifierId } from './acceptance-registry.mjs';

// #147: a spec-approved SBI Issue runs generation → detection (G) → implementation → acceptance (I) without a hand-written registration.
const issueUrl = 'https://github.com/acme/app/issues/7';
const pbi = { number: 3, url: 'https://github.com/acme/app/issues/3', title: '講座' };
const body = renderSbiBody({
  id: 'SBI-001', kind: 'implementation', title: '担当講師だけが講座を閲覧できる', purpose: '担当外の講師は拒否される。',
  scope: { included: ['apps/api 講座の閲覧'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: '担当講師は閲覧できる' }, { id: 'AC-2', description: '担当外の講師は403になる' }],
  scenarios: [
    { name: '担当講師が閲覧する', given: ['担当講師である'], when: ['講座を開く'], then: ['200になる'], acceptanceIds: ['AC-1'], test: 'RSpec' },
    { name: '担当外の講師が閲覧する', given: ['担当外の講師である'], when: ['講座を開く'], then: ['403になる'], acceptanceIds: ['AC-2'], test: 'RSpec' },
  ],
  dependsOn: [], changeAreas: ['apps/api'], layers: ['Rails Controller'], estimatedFiles: 3, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'RSpec', acceptance: 'Trusted Acceptance（生成）', e2e: '不要' },
}, pbi);
const at = '2026-10-30T00:00:00Z';
const issue = { number: 7, title: 'SBI-001 担当講師だけが講座を閲覧できる', body, html_url: issueUrl, state: 'open', labels: [{ name: 'sbi' }] };
const approval = { id: 1, issue: 7, body: specApprovalLine(specDigest(body)), html_url: `${issueUrl}#issuecomment-1`, user: { login: 'alice', type: 'User' }, created_at: at, updated_at: at };
const mockGitHub = githubMock({ issue, comments: [approval], permissions: { alice: 'admin' } });

const testPath = 'apps/api/spec/acceptance/sbi_7/courses_spec.rb';
const testContent = 'require "rails_helper"\n\nRSpec.describe "講座の閲覧", type: :request do\n  it "担当講師が閲覧する: 200を返す" do\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:ok)\n  end\n\n  it "担当外の講師が閲覧する: 403を返す" do\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:forbidden)\n  end\nend\n';
const generation = (overrides = {}) => async () => ({ files: [{ path: testPath, content: testContent }], escalation: null, mapping: [
  { scenario: '担当講師が閲覧する', acceptanceIds: ['AC-1'], examples: [{ path: testPath, description: '担当講師が閲覧する: 200を返す' }] },
  { scenario: '担当外の講師が閲覧する', acceptanceIds: ['AC-2'], examples: [{ path: testPath, description: '担当外の講師が閲覧する: 403を返す' }] },
], ...overrides });
const notMet = 'RSpec::Expectations::ExpectationNotMetError';
const example = (description, status) => ({ description, status, ...(status === 'failed' ? { exception: { class: notMet, message: 'expected 200' } } : {}) });
const reportOf = statuses => ({ examples: Object.entries(statuses).map(([d, s]) => ({ description: d, status: s, exceptionClass: s === 'failed' ? notMet : null })), errorsOutsideOfExamples: 0 });
// Before the implementation commit the specs fail on their expectations (G detects); after it they pass (I).
const runner = ({ before = 'failed', after = 'passed' } = {}) => {
  const calls = [];
  return { calls, run: async ({ workspace }) => {
    const implemented = (await git(workspace, ['ls-files', 'apps/api/app/controllers/courses_controller.rb'])).stdout.trim() !== '';
    calls.push(implemented ? 'I' : 'G');
    const status = implemented ? after : before;
    return reportOf({ '担当講師が閲覧する: 200を返す': status, '担当外の講師が閲覧する: 403を返す': status });
  } };
};
const implementation = async () => ({ files: [{ path: 'apps/api/app/controllers/courses_controller.rb', content: 'class CoursesController < ApplicationController; end\n' }], escalation: null });
async function prepared(root) {
  // The Rails verifier runs a trivial command; the generated acceptance specs go through the stubbed runner.
  await update(root, '.harness/config/harness.json', c => { const rails = c.verifiers.find(v => v.id === 'rails'); rails.commands = [['node', '-e', 'process.exit(0)']]; rails.isolation = 'container'; });
  await commitFixture(root);
}
const run = (root, extra = {}) => runHarness({ root, quiet: true, provider: 'codex', issueUrl, agent: implementation, acceptanceAgent: generation(), ...extra });

describe('A run from a spec-approved SBI Issue', () => {
  it('when the generated tests pass the checks, detect the missing behavior and pass after the implementation then the run is DONE with every AC from the generated acceptance', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    const specs = runner();
    const result = await run(root, { acceptanceRunner: specs.run });
    assert.equal(result.executionStatus, 'DONE', result.reason);
    assert.deepEqual(specs.calls.slice(0, 2), ['G', 'I']);
    const { workspace } = { workspace: join(root, result.runDir, 'workspace') };
    assert.equal(await readFile(join(workspace, testPath), 'utf8'), testContent);
    assert.equal(JSON.parse(await readFile(join(workspace, '.harness/acceptance/sbi-7.json'), 'utf8')).version, 2);
    const detection = await readJson(join(root, result.runDir, 'acceptance-detection.json'));
    assert.deepEqual(detection.scenarios.map(s => s.outcome), ['detected', 'detected']);
    const last = result.iterations.at(-1);
    assert.equal(last.verification.checks.find(c => c.id === generatedVerifierId(7)).status, 'PASS');
    assert.deepEqual(last.verification.acceptance.sort(), ['AC-1', 'AC-2']);
  })));
  it('when the generated tests fail the quality checks then the run escalates before implementing and commits nothing', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    let implemented = false;
    const result = await run(root, { acceptanceAgent: generation({ mapping: [] }), acceptanceRunner: runner().run, agent: async () => { implemented = true; return implementation(); } });
    assert.equal(result.executionStatus, 'ESCALATED');
    assert.equal(result.escalation?.code, 'ACCEPTANCE_REJECTED');
    assert.equal(implemented, false);
    assert.equal(result.headSha, result.baselineSha);
  })));
  it('when the generation agent says the spec is ambiguous then the run escalates as SPEC_AMBIGUOUS', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    const result = await run(root, { acceptanceAgent: async () => ({ files: [], mapping: [], escalation: '担当の定義が仕様にありません' }), acceptanceRunner: runner().run });
    assert.equal(result.executionStatus, 'ESCALATED');
    assert.equal(result.escalation?.code, 'SPEC_AMBIGUOUS');
  })));
  it('when detection is undeterminable because the specs cannot run then the run escalates before implementing', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    let implemented = false;
    const result = await run(root, { acceptanceRunner: async () => ({ error: 'no RSpec JSON report in the output', examples: [], errorsOutsideOfExamples: 0 }), agent: async () => { implemented = true; return implementation(); } });
    assert.equal(result.escalation?.code, 'DETECTION_UNDETERMINABLE');
    assert.equal(implemented, false);
  })));
  it('when every Scenario already passes before the implementation then the run escalates, since the tests detect nothing new', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    const result = await run(root, { acceptanceRunner: runner({ before: 'passed' }).run });
    assert.equal(result.escalation?.code, 'DETECTION_UNDETERMINABLE');
    assert.match(result.reason, /already satisfied|検出/);
  })));
  it('when the implementation agent writes a generated test or a spec support file then the iteration is a scope violation', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    const result = await run(root, { acceptanceRunner: runner().run, agent: async () => ({ files: [{ path: 'apps/api/spec/support/auth.rb', content: 'RSpec.configure { }\n' }], escalation: null }) });
    assert.notEqual(result.executionStatus, 'DONE');
    assert.match(JSON.stringify(result.iterations.map(i => i.error ?? i.agent)), /apps\/api\/spec\/support\/auth\.rb/);
  })));
  it('when the implementation leaves the generated specs failing then the generated acceptance FAILs and the run is not DONE', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    const result = await run(root, { acceptanceRunner: runner({ after: 'failed' }).run });
    assert.notEqual(result.executionStatus, 'DONE');
    assert.equal(result.iterations[0].verification.checks.find(c => c.id === generatedVerifierId(7)).status, 'FAIL');
  })));
});
