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
const issue = { number: 7, title: 'SBI-001 担当講師だけが講座を閲覧できる', body, html_url: issueUrl, state: 'open', labels: [{ name: 'sbi' }, { name: 'spec-approved' }] };
const mockGitHub = githubMock({ issue });

const testPath = 'apps/api/spec/acceptance/sbi_7/courses_spec.rb';
const testContent = 'require "rails_helper"\n\nRSpec.describe "講座の閲覧", type: :request do\n  it "担当講師が閲覧する: 200を返す" do\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:ok)\n  end\n\n  it "担当外の講師が閲覧する: 403を返す" do\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:forbidden)\n  end\nend\n';
const generation = (overrides = {}) => async () => ({ files: [{ path: testPath, content: testContent }], escalation: null, mapping: [
  { scenario: '担当講師が閲覧する', acceptanceIds: ['AC-1'], examples: [{ path: testPath, description: '担当講師が閲覧する: 200を返す' }] },
  { scenario: '担当外の講師が閲覧する', acceptanceIds: ['AC-2'], examples: [{ path: testPath, description: '担当外の講師が閲覧する: 403を返す' }] },
], ...overrides });
const notMet = 'RSpec::Expectations::ExpectationNotMetError';
const example = (description, status) => ({ description, status, ...(status === 'failed' ? { exception: { class: notMet, message: 'expected 200' } } : {}) });
const reportOf = statuses => ({ examples: Object.entries(statuses).map(([d, s]) => ({ description: d, status: s, exceptionClass: s === 'failed' ? notMet : null, message: s === 'failed' ? 'expected 200' : null })), errorsOutsideOfExamples: 0 });
// Before the implementation commit the specs fail on their expectations (G detects); after it they pass (I).
// A controlled violation run gets the examples of its Scenario and a disposable copy; the copy fails them when it carries the violation marker.
const marker = '# controlled violation';
const runner = ({ before = 'failed', after = 'passed', violated = 'failed' } = {}) => {
  const calls = [];
  return { calls, run: async ({ workspace, examples }) => {
    if (examples) {
      calls.push('V');
      const broken = (await readFile(join(workspace, controllerPath), 'utf8')).includes(marker);
      return reportOf(Object.fromEntries(examples.map(e => [e, broken ? violated : 'passed'])));
    }
    const implemented = (await git(workspace, ['ls-files', 'apps/api/app/controllers/courses_controller.rb'])).stdout.trim() !== '';
    calls.push(implemented ? 'I' : 'G');
    const status = implemented ? after : before;
    return reportOf({ '担当講師が閲覧する: 200を返す': status, '担当外の講師が閲覧する: 403を返す': status });
  } };
};
const controllerPath = 'apps/api/app/controllers/application_controller.rb';
const controllerText = await readFile(new URL(`../../${controllerPath}`, import.meta.url), 'utf8');
// The violation agent answers for the Scenarios it is asked about; path changes where the violation goes.
const violations = ({ path = controllerPath } = {}) => {
  const requests = [];
  return { requests, agent: async request => {
    requests.push(request);
    return { escalation: null, violations: request.scenarios.map(scenario => ({ scenario, files: [{ path, content: `${controllerText}${marker}\n` }] })) };
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
  // The specs could not run at all (no RSpec report): an environment failure says nothing about the tests, so it is not retried as one.
  it('when the specs cannot run because of the environment then the run stops as a run failure before implementing, without regenerating', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    let implemented = false, generated = 0;
    const result = await run(root, { acceptanceAgent: async request => { generated += 1; return generation()(request); }, acceptanceRunner: async () => ({ error: 'no RSpec JSON report in the output', examples: [], errorsOutsideOfExamples: 0 }), agent: async () => { implemented = true; return implementation(); } });
    assert.equal(result.escalation?.code, 'ACCEPTANCE_RUN_FAILED');
    assert.equal(generated, 1);
    assert.equal(implemented, false);
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

// G is proven by a controlled violation, not by a RED baseline (ADR-0005 検証方法: 制御した違反を検出できないテストは登録されない).
// A Scenario that fails on its expectation before the implementation is its own natural violation; one that already passes gets a
// controlled violation proposed by the generation agent, checked and run by the Harness in a disposable copy.
describe('Detection (G) by controlled violation', () => {
  const detection = async (root, result) => readJson(join(root, result.runDir, 'acceptance-detection.json'));
  it('when every Scenario already passes and each controlled violation makes its Scenario fail then the run goes on to DONE', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    const specs = runner({ before: 'passed' }), proposals = violations();
    const prompts = [];
    const result = await run(root, { acceptanceRunner: specs.run, violationAgent: proposals.agent, agent: async request => { prompts.push(request.prompt ?? ''); return implementation(); } });
    assert.equal(result.executionStatus, 'DONE', result.reason);
    assert.deepEqual(proposals.requests.map(r => r.scenarios), [['担当講師が閲覧する', '担当外の講師が閲覧する']]);
    assert.deepEqual(specs.calls.slice(0, 3), ['G', 'V', 'V']);
    const evidence = await detection(root, result);
    assert.equal(evidence.status, 'PASS');
    assert.deepEqual(evidence.attempts.at(-1).scenarios.map(s => [s.baseline, s.outcome]), [['already satisfied', 'detected'], ['already satisfied', 'detected']]);
    assert.ok(evidence.attempts.at(-1).scenarios.every(s => /^[0-9a-f]{64}$/.test(s.violation.patchDigest)));
    // The patch is evidence only: its text is kept nowhere, and neither the workspace nor the implementation agent sees it.
    assert.doesNotMatch(JSON.stringify(evidence), /controlled violation/);
    assert.doesNotMatch(await readFile(join(root, result.runDir, 'workspace', controllerPath), 'utf8'), /controlled violation/);
    assert.ok(prompts.every(p => !p.includes(marker)));
  })));
  it('when a Scenario fails on its expectation before the implementation then that failure is its evidence and no violation is asked for it', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    const proposals = violations();
    const result = await run(root, { acceptanceRunner: runner().run, violationAgent: proposals.agent });
    assert.equal(result.executionStatus, 'DONE', result.reason);
    assert.equal(proposals.requests.length, 0);
    const evidence = await detection(root, result);
    assert.deepEqual(evidence.attempts.at(-1).scenarios.map(s => [s.baseline, s.outcome]), [['detected', 'detected'], ['detected', 'detected']]);
    assert.deepEqual(evidence.attempts.at(-1).scenarios[0].failures, [{ description: '担当講師が閲覧する: 200を返す', message: 'expected 200' }]);
  })));
  it('when a controlled violation still passes in every attempt then the tests are regenerated and the run escalates as DETECTION_FAILED after the limit', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    let generated = 0, implemented = false;
    const result = await run(root, { acceptanceAgent: async request => { generated += 1; return generation()(request); }, acceptanceRunner: runner({ before: 'passed', violated: 'passed' }).run, violationAgent: violations().agent, agent: async () => { implemented = true; return implementation(); } });
    assert.equal(result.escalation?.code, 'DETECTION_FAILED');
    assert.equal(generated, 3);
    assert.equal(implemented, false);
    assert.equal(result.headSha, result.baselineSha);
    const evidence = await detection(root, result);
    assert.equal(evidence.attempts.length, 3);
    for (const attempt of evidence.attempts) {
      assert.ok(attempt.tests.every(t => /^[0-9a-f]{64}$/.test(t.sha256)));
      assert.ok(attempt.scenarios.every(s => s.outcome === 'missed' && s.reason));
    }
  })));
  it('when the first attempt misses and the regenerated attempt detects then the run goes on, and the regeneration is told why without the earlier patch', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    const prompts = [];
    let attempt = 0;
    const specs = { run: async input => (input.examples && attempt === 1 ? runner({ before: 'passed', violated: 'passed' }) : runner({ before: 'passed' })).run(input) };
    const result = await run(root, { acceptanceAgent: async request => { attempt += 1; prompts.push(request.prompt); return generation()(request); }, acceptanceRunner: specs.run, violationAgent: violations().agent });
    assert.equal(result.executionStatus, 'DONE', result.reason);
    assert.equal((await detection(root, result)).attempts.length, 2);
    assert.match(prompts[1], /担当講師が閲覧する/);
    assert.doesNotMatch(prompts[1], /controlled violation/);
  })));
  it('when the proposed violation changes a spec instead of the application then it is undeterminable, and after the limit the run escalates as DETECTION_UNDETERMINABLE', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    const result = await run(root, { acceptanceRunner: runner({ before: 'passed' }).run, violationAgent: violations({ path: 'apps/api/spec/rails_helper.rb' }).agent });
    assert.equal(result.escalation?.code, 'DETECTION_UNDETERMINABLE');
    const evidence = await detection(root, result);
    assert.equal(evidence.attempts.length, 3);
    assert.match(evidence.attempts[0].scenarios[0].reason, /apps\/api\/spec\/rails_helper\.rb/);
  })));
  it('when the generated specs cannot be loaded before the implementation then it is a test failure that counts toward the limit, not a detection', () => fixture(root => mockGitHub({}, async () => {
    await prepared(root);
    let generated = 0;
    const result = await run(root, { acceptanceAgent: async request => { generated += 1; return generation()(request); }, acceptanceRunner: async () => ({ examples: [], errorsOutsideOfExamples: 1 }) });
    assert.equal(result.escalation?.code, 'DETECTION_UNDETERMINABLE');
    assert.equal(generated, 3);
  })));
});
