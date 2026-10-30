import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { fixture } from './test-fixture.mjs';
import { readJson } from './io.mjs';
import { runCompletionJudge, runVerifier } from './impact.mjs';
import { renderSbiBody } from './planner.mjs';
import { sbiFromIssue } from './sbi-issue.mjs';
import { snapshotFromIssue, snapshotPath } from './sbi-source.mjs';
import { specApprovalLine, specDigest } from './spec-approval.mjs';
import { generateAcceptance } from './acceptance-generation.mjs';
import { generatedVerifierId } from './acceptance-registry.mjs';
import { writeAcceptanceResult } from './acceptance-run.mjs';
import { git } from './workspace.mjs';

// #147: the PR of a spec-approved SBI carries the generated Trusted Acceptance. CI runs the generated specs in the verifier matrix (I)
// and the Completion Judge reads that result, the registration and the current SBI Issue with its spec approval.
const workflow = parse(await readFile(new URL('../../.github/workflows/harness.yml', import.meta.url), 'utf8'));
const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
const pbi = { number: 3, url: 'https://github.com/acme/app/issues/3', title: '講座' };
const planned = (then = '403になる') => ({
  id: 'SBI-001', kind: 'implementation', title: '担当講師だけが講座を閲覧できる', purpose: '担当外の講師は拒否される。',
  scope: { included: ['apps/api 講座の閲覧'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: '担当講師は閲覧できる' }, { id: 'AC-2', description: '担当外の講師は403になる' }],
  scenarios: [
    { name: '担当講師が閲覧する', given: ['担当講師である'], when: ['講座を開く'], then: ['200になる'], acceptanceIds: ['AC-1'], test: 'RSpec' },
    { name: '担当外の講師が閲覧する', given: ['担当外の講師である'], when: ['講座を開く'], then: [then], acceptanceIds: ['AC-2'], test: 'RSpec' },
  ],
  dependsOn: [], changeAreas: ['apps/api'], layers: ['Rails Controller'], estimatedFiles: 2, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'RSpec', acceptance: 'Trusted Acceptance（生成）', e2e: '不要' },
});
const issueOf = (body, labels = ['sbi']) => ({ number: 7, title: 'SBI-001 担当講師だけが講座を閲覧できる', body, html_url: ref.url, state: 'open', labels: labels.map(name => ({ name })) });
const approved = issueOf(renderSbiBody(planned(), pbi));
const at = '2026-10-30T00:00:00Z';
const approvalOf = issue => ({ id: 1, issue: 7, body: specApprovalLine(specDigest(issue.body)), html_url: `${ref.url}#issuecomment-1`, user: { login: 'alice', type: 'User' }, created_at: at, updated_at: at });
const githubOf = (issue, comments = [approvalOf(issue)]) => ({ fetchIssue: async () => issue, listComments: async () => comments, permission: async () => 'admin' });

const testPath = 'apps/api/spec/acceptance/sbi_7/courses_spec.rb';
const testContent = 'require "rails_helper"\n\nRSpec.describe "講座の閲覧", type: :request do\n  it "担当講師が閲覧する: 200を返す" do\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:ok)\n  end\n\n  it "担当外の講師が閲覧する: 403を返す" do\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:forbidden)\n  end\nend\n';
const answer = async () => ({ files: [{ path: testPath, content: testContent }], escalation: null, mapping: [
  { scenario: '担当講師が閲覧する', acceptanceIds: ['AC-1'], examples: [{ path: testPath, description: '担当講師が閲覧する: 200を返す' }] },
  { scenario: '担当外の講師が閲覧する', acceptanceIds: ['AC-2'], examples: [{ path: testPath, description: '担当外の講師が閲覧する: 403を返す' }] },
] });
const reportOf = status => ({ examples: ['担当講師が閲覧する: 200を返す', '担当外の講師が閲覧する: 403を返す'].map(description => ({ description, status, exceptionClass: status === 'failed' ? 'RSpec::Expectations::ExpectationNotMetError' : null, message: null })), errorsOutsideOfExamples: 0 });
const runId = '2026-10-30T00-00-00-000Z-1a2b3c4d';
const id = generatedVerifierId(7);
const results = '.acceptance-ci/results';
const needs = (verifiers = 'success') => ({ impact: { result: 'success' }, verifiers: { result: verifiers }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' }, maestro: { result: 'skipped' } });

// What a Harness Run of a spec-approved Issue pushes: the snapshot, the generated tests with their registration, then the implementation.
async function branch(root, { issue = approved, change } = {}) {
  await git(root, ['switch', '-c', 'feature']);
  const sbi = sbiFromIssue({ ref, issue, config: await readJson(join(root, '.harness/config/harness.json')), generate: true });
  const snapshot = snapshotFromIssue({ ref, issue, runId, sbi });
  await writeFile(join(root, snapshotPath(snapshot)), JSON.stringify(snapshot));
  const generated = await generateAcceptance({ workspace: root, issue, provider: 'codex', runId, agent: answer });
  assert.equal(generated.status, 'REGISTERED');
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', `SBI ISSUE-7: register generated Trusted Acceptance\n\nHarness-Run: ${runId}\nSBI-Issue: ${ref.url}`]);
  await mkdir(join(root, 'apps/api/app/controllers'), { recursive: true });
  await writeFile(join(root, 'apps/api/app/controllers/courses_controller.rb'), 'class CoursesController < ApplicationController; end\n');
  await change?.(root);
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', `feat: courses\n\nHarness-Run: ${runId}\nSBI-Issue: ${ref.url}`]);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
}
const matrixLeg = (root, status = 'passed') => runVerifier({ root, base: 'main', id, acceptanceResults: join(root, results), acceptanceRunner: async () => reportOf(status) });
const judge = (root, { issue = approved, github = githubOf(issue), verifiers = 'success' } = {}) =>
  runCompletionJudge({ root, base: 'main', needs: needs(verifiers), repository: 'acme/app', github, acceptanceResults: join(root, results) });
const generatedCheck = judged => judged.checks.find(c => c.id === id);

describe('CI for a PR whose Trusted Acceptance was generated from a spec-approved SBI Issue', () => {
  describe('given Impact Analysis', () => {
    it('when the snapshot names the generated acceptance verifier then the verifier matrix runs it as a mandatory verifier', () => fixture(async root => {
      await branch(root);
      const { impact } = await matrixLeg(root);
      assert.ok(impact.requiredVerifiers.includes(id));
      assert.equal(impact.verifiers.find(v => v.id === id).mandatory, true);
    }));
  });

  describe('given the verifier matrix leg of the generated acceptance', () => {
    it('when the generated specs pass then the leg passes and leaves the report for the Completion Judge bound to the head commit', () => fixture(async root => {
      const head = await branch(root);
      const { passed } = await matrixLeg(root);
      assert.equal(passed, true);
      const stored = await readJson(join(root, results, 'sbi-7.json'));
      assert.deepEqual([stored.sbiIssue, stored.headSha, stored.report.examples.length], [7, head, 2]);
    }));
    it('when a generated spec fails then the leg fails and still leaves the report', () => fixture(async root => {
      await branch(root);
      const { passed } = await matrixLeg(root, 'failed');
      assert.equal(passed, false);
      assert.equal((await readJson(join(root, results, 'sbi-7.json'))).report.examples[0].status, 'failed');
    }));
  });

  describe('given the Completion Judge', () => {
    it('when the spec is approved, the registration is intact and the generated specs passed on the head commit then every AC is met and the judge passes', () => fixture(async root => {
      await branch(root);
      await matrixLeg(root);
      const judged = await judge(root);
      assert.equal(generatedCheck(judged).status, 'PASS', generatedCheck(judged).reason);
      assert.deepEqual([judged.acceptance.status, judged.source.status], ['PASS', 'PASS'], judged.reasons.join('; '));
      assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
    }));
    it('when the generated tests and their registration are counted then they do not count against the expected number of changed files', () => fixture(async root => {
      await branch(root);
      await matrixLeg(root);
      const judged = await judge(root);
      assert.deepEqual(judged.granularity.map(g => [g.status, g.changedFiles]), [['PASS', 1]]);
    }));
    it('when the Issue has no spec approval then the SBI source fails even though the generated specs passed', () => fixture(async root => {
      await branch(root);
      await matrixLeg(root);
      const judged = await judge(root, { github: githubOf(approved, []) });
      assert.equal(judged.source.status, 'FAIL');
      assert.match(judged.source.reasons.join('\n'), /harness-spec/);
      assert.equal(judged.status, 'FAIL');
    }));
    it('when the Issue is ready but has no spec approval then generated tests are still not trusted', () => fixture(async root => {
      await branch(root);
      await matrixLeg(root);
      const ready = { ...approved, labels: [{ name: 'sbi' }, { name: 'ready' }] };
      const judged = await judge(root, { issue: ready, github: githubOf(ready, []) });
      assert.equal(judged.source.status, 'FAIL');
      assert.match(judged.source.reasons.join('\n'), /harness-spec/);
    }));
    it('when the spec was edited and re-approved after the tests were generated then the generated acceptance fails on the spec digest', () => fixture(async root => {
      await branch(root);
      await matrixLeg(root);
      const edited = issueOf(renderSbiBody(planned('404になる'), pbi));
      const judged = await judge(root, { issue: edited });
      assert.equal(generatedCheck(judged).status, 'FAIL');
      assert.match(generatedCheck(judged).reason, /spec digest/);
      assert.equal(judged.status, 'FAIL');
    }));
    it('when the SBI Issue cannot be read then the generated acceptance fails and says so', () => fixture(async root => {
      await branch(root);
      await matrixLeg(root);
      const judged = await judge(root, { github: { ...githubOf(approved), fetchIssue: async () => { throw new Error('HTTP 502'); } } });
      assert.equal(generatedCheck(judged).status, 'FAIL');
      assert.match(generatedCheck(judged).reason, /could not be read/);
    }));
    it('when the implementation changed a generated test then the generated acceptance fails without trusting the report', () => fixture(async root => {
      await branch(root, { change: root => writeFile(join(root, testPath), testContent.replace(':forbidden', ':ok')) });
      await matrixLeg(root);
      const judged = await judge(root);
      assert.equal(generatedCheck(judged).status, 'FAIL');
      assert.match(generatedCheck(judged).reason, /changed after registration/);
    }));
    it('when the matrix left no report then the generated acceptance fails instead of being skipped', () => fixture(async root => {
      await branch(root);
      const judged = await judge(root);
      assert.equal(generatedCheck(judged).status, 'FAIL');
      assert.equal(judged.acceptance.status, 'FAIL');
    }));
    it('when the report is for another commit then the generated acceptance fails', () => fixture(async root => {
      await branch(root);
      await writeAcceptanceResult({ dir: join(root, results), sbiIssue: 7, headSha: 'f'.repeat(40), report: reportOf('passed') });
      const judged = await judge(root);
      assert.equal(generatedCheck(judged).status, 'FAIL');
      assert.match(generatedCheck(judged).reason, /ffffffffffff/);
    }));
    it('when the report does not have the expected shape then the generated acceptance fails', () => fixture(async root => {
      await branch(root);
      await mkdir(join(root, results), { recursive: true });
      await writeFile(join(root, results, 'sbi-7.json'), JSON.stringify({ sbiIssue: 7, headSha: (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), report: { examples: 'all passed' } }));
      const judged = await judge(root);
      assert.equal(generatedCheck(judged).status, 'FAIL');
    }));
  });
});

describe('CI workflow for the generated acceptance', () => {
  const steps = job => workflow.jobs[job].steps;
  // Outside the checkout, so a report committed in the PR is never read in place of the one the matrix leg produced.
  const outside = '${{ runner.temp }}/acceptance-results';
  it('when a verifier matrix leg runs the generated acceptance then it uploads its report from outside the checkout under a name unique to the leg, even when the leg fails', () => {
    // The runner context is available in step env only, not in job env.
    assert.equal(steps('verifiers').find(s => s.run?.startsWith('pnpm harness:verify')).env.HARNESS_ACCEPTANCE_RESULTS, outside);
    const upload = steps('verifiers').find(s => s.uses?.startsWith('actions/upload-artifact@') && s.with?.path === outside);
    assert.ok(upload, 'upload step for the generated acceptance report');
    assert.match(upload.if, /always\(\)/);
    assert.match(upload.with.name, /\$\{\{ matrix\.verifier \}\}/);
  });
  it('when the Completion Judge runs then it downloads every report outside the checkout and reads them from there, judging a missing one as a failure', () => {
    const download = steps('harness').find(s => s.uses?.startsWith('actions/download-artifact@') && s.with?.path === outside);
    assert.ok(download, 'download step for the generated acceptance reports');
    assert.equal(download['continue-on-error'], true);
    assert.equal(download.with['merge-multiple'], true);
    assert.ok(download.with.pattern);
    const run = steps('harness').find(s => s.run?.startsWith('pnpm harness:judge'));
    assert.equal(run.env.HARNESS_ACCEPTANCE_RESULTS, outside);
  });
});
