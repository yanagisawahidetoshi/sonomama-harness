import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, human, runFixture as runHarness } from './test-fixture.mjs';
import { resumeRun, openPullRequest } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { execute, readJson } from './io.mjs';
const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
const sbiPath = '.harness/state/sample-sbi.json';

describe('Approval and resume states', () => {
  describe('given a completed medium-risk implementation', () => {
    it('when one authenticated human approves the current SHA then resumes to MERGE_ALLOWED', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.status, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(run.risk.level, 2);
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'MERGE_ALLOWED');
      assert.equal(resumed.merge.autoMergeEligible, false);
      assert.equal(resumed.iterations.length, 2);
      for (const name of ['risk-assessment.json', 'approvals.json', 'merge-decision.json', 'changes.json']) {
        assert.ok((await readFile(join(root, run.runDir, name), 'utf8')).length);
      }
      assert.equal((await readJson(join(root, run.runDir, 'risk-assessment.json'))).reasons.includes('default_medium'), true);
      assert.equal(resumed.events.some(e => e.status === 'MERGED'), false);
    }));
    it('when approvals evidence is forged then it grants no approval', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await writeFile(join(root, run.runDir, 'approvals.json'), JSON.stringify({ approvals: [{ reviewer: 'fake', commitSha: run.headSha, kind: 'human' }] }));
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.merge.validApprovals, 0);
      assert.equal(resumed.status, 'WAITING_FOR_HUMAN_REVIEW');
    }));
    it('when the approved workspace is modified then invalidates approval and requires re-verification', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      await writeFile(join(root, run.runDir, 'workspace/greeting.mjs'), 'bad change');
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.merge.autoMergeEligible, false);
      assert.equal(resumed.status, 'ESCALATED');
    }));
    it('when a new commit appears then old checks and approvals cannot permit merge', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      const cwd = join(root, run.runDir, 'workspace');
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      await execute('git', ['-c', 'user.name=Human', '-c', 'user.email=human@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'new HEAD'], { cwd });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'ESCALATED');
      assert.match(resumed.reason, /HEAD|snapshot/);
    }));
    it('when an approval is revoked then MERGE_ALLOWED returns to waiting', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'MERGE_ALLOWED');
      await recordDecision({ root, runId: run.id, purpose: 'merge', decision: 'REVOKE', identityProvider: human('A') });
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
    }));
  });
  // #175: the approved SBI decided RLS, so no implementation gate precedes the agent; the two merge approvals after implementation remain.
  describe('given an approved SBI that declares RLS', () => {
    it('when merge approval is attempted before execution is DONE then refuses it', () => fixture(async root => {
      await update(root, sbiPath, s => s.risks = ['RLS']);
      const run = await runHarness({ root, quiet: true, agent: async () => ({ escalation: 'stop before DONE', files: [] }) });
      assert.equal(run.gate.required, false);
      assert.equal(run.merge.state, 'BLOCKED');
      await assert.rejects(recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') }), /^Error: Execution must be DONE before merge approval$/);
    }));
    it('when it executes then still requires two separate merge approvals', () => fixture(async root => {
      await update(root, '.harness/config/harness.json', c => c.securityVerifiers = [{ id: 'rails-rls-test', directory: 'apps/api', commands: [['node', '-e', 'require("node:assert/strict").ok(true)']] }]);
      await update(root, sbiPath, s => s.risks = ['RLS']);
      let resumed = await runHarness({ root, quiet: true });
      const run = resumed;
      assert.equal(resumed.executionStatus, 'DONE');
      assert.equal(resumed.risk.level, 3);
      assert.equal(resumed.merge.validApprovals, 0);
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'WAITING_FOR_HUMAN_REVIEW');
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('B') });
      resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'MERGE_ALLOWED');
      assert.equal(resumed.merge.autoMergeEligible, false);
    }));
  });
});

describe('Workspace and verifier registry', () => {
  describe('given root app contents differ from generated code', () => {
    it('when a command verifier runs then validates the same workspace the agent wrote', () => fixture(async root => {
      await writeFile(join(root, 'apps/admin/package.json'), '{"private":true}');
      await writeFile(join(root, 'apps/admin/message.txt'), 'root');
      await update(root, sbiPath, s => s.allowedFiles.push('apps/admin/message.txt'));
      await update(root, '.harness/config/harness.json', c => c.verifiers.find(v => v.id === 'admin').commands = [['node', '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("message.txt", "utf8"), "workspace")']]);
      const run = await runHarness({ root, quiet: true, agent: async () => ({ files: [{ path: 'greeting.mjs', content: good }, { path: 'apps/admin/message.txt', content: 'workspace' }] }) });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.iterations[0].verification.checks.find(c => c.id === 'admin').status, 'PASS');
      assert.equal(await readFile(join(root, 'apps/admin/message.txt'), 'utf8'), 'root');
    }));
    it('when a registered docs verifier validates safe docs then becomes auto merge eligible without merging', () => fixture(async root => {
      await update(root, sbiPath, s => {
        s.allowedFiles = ['docs/product/intro.md'];
        s.title = 'Write an introduction'; s.description = 'Explain the project';
        s.acceptanceCriteria = [{ id: 'DOC-1', description: 'Introduction exists', verifier: 'docs-bdd' }];
      });
      await mkdir(join(root, '.harness/verification'), { recursive: true });
      await writeFile(join(root, '.harness/verification/docs.mjs'), 'import { readFileSync } from "node:fs"; import { join } from "node:path"; import assert from "node:assert/strict"; assert.equal(readFileSync(join(process.argv[2], "docs/product/intro.md"), "utf8"), "Welcome."); console.log(JSON.stringify({acceptance:["DOC-1"]}));');
      await update(root, '.harness/config/harness.json', c => c.verifiers.push({ trust: 'acceptance', trustedScript: '.harness/verification/docs.mjs', id: 'docs-bdd', directory: 'docs/product', planned: ['BDD'], acceptanceIds: ['DOC-1'], commands: [['node', '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("intro.md","utf8"),"Welcome.")']] }));
      const run = await runHarness({ root, quiet: true, agent: async () => ({ files: [{ path: 'docs/product/intro.md', content: 'Welcome.' }] }) });
      assert.equal(run.status, 'MERGE_ALLOWED');
      assert.equal(run.risk.level, 1);
      assert.equal(run.merge.autoMergeEligible, true);
    }));
  });
});

describe('Trusted approval boundary', () => {
  describe('given an isolated agent workspace', () => {
    it('when the authenticated ledger is altered then refuses all approvals', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      const path = join(root, '.harness/state/human', `${run.id}.json`);
      const ledger = await readJson(path);
      ledger.records[0].reviewer = 'forged-human';
      await writeFile(path, JSON.stringify(ledger));
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'ESCALATED');
      assert.match(resumed.reason, /signature/);
    }));
    it('when an AI identity tries to approve then refuses the record', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await assert.rejects(recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: () => ({ id: 'bot', kind: 'ai', source: 'agent' }) }), /human/);
    }));
    it('when security check finds a private key in an approved secret SBI then fails and stops', () => fixture(async root => {
      await update(root, sbiPath, s => s.risks = ['secret']);
      // Split so this test file's own added lines do not trip the CI secret-scan.
      const run = await runHarness({ root, quiet: true, agent: async () => ({ files: [{ path: 'greeting.mjs', content: good + `\n// -----BEGIN ${'PRIVATE KEY'}-----` }] }) });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.iterations.length, 1);
      assert.equal(run.iterations[0].security.status, 'FAIL');
    }));
    it('when the required app is missing then does not accept a placeholder SKIP', () => fixture(async root => {
      await update(root, '.harness/config/harness.json', c => c.verifiers[0].allowMissing = false);
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.iterations[0].verification.checks.find(c => c.id === 'rails').status, 'FAIL');
    }));
  });
});

describe('Snapshot includes ignored runtime inputs', () => {
  describe('given an app input hidden by gitignore', () => {
    it('when that input changes after approval then invalidates the snapshot', () => fixture(async root => {
      await writeFile(join(root, 'apps/admin/.gitignore'), 'runtime.input\n');
      await writeFile(join(root, 'apps/admin/runtime.input'), 'before');
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      await writeFile(join(root, run.runDir, 'workspace/apps/admin/runtime.input'), 'after');
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'ESCALATED');
      assert.match(resumed.reason, /snapshot/);
    }));
  });
});

describe('Merge assessment failure after Execution DONE', () => {
  const unrelatedEdit = root => writeFile(join(root, 'notes.txt'), 'uncommitted');
  describe('given a completed run whose source checkout has an uncommitted unrelated file', () => {
    it('when resumed then keeps Execution DONE and records a retryable merge failure instead of escalating', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await unrelatedEdit(root);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.executionStatus, 'DONE');
      assert.equal(resumed.status, 'RETRYABLE');
      assert.equal(resumed.merge.state, 'RETRYABLE');
      assert.equal(resumed.merge.autoMergeEligible, false);
      assert.deepEqual({ code: resumed.merge.failure.code, retryable: resumed.merge.failure.retryable }, { code: 'SOURCE_DIRTY', retryable: true });
      assert.deepEqual({ status: resumed.events.at(-1).status, phase: resumed.events.at(-1).phase }, { status: 'RETRYABLE', phase: 'merge' });
      assert.equal(resumed.events.some(e => e.status === 'ESCALATED'), false);
      await assert.rejects(readFile(join(root, run.runDir, 'escalation.json')), /ENOENT/);
      assert.equal((await readJson(join(root, run.runDir, 'summary.json'))).executionStatus, 'DONE');
    }));
    it('when the file is removed and resumed again then the merge decision returns to waiting and then to MERGE_ALLOWED', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await unrelatedEdit(root);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'RETRYABLE');
      await rm(join(root, 'notes.txt'));
      const waiting = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(waiting.status, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(waiting.merge.failure, undefined);
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      const allowed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(allowed.status, 'MERGE_ALLOWED');
      assert.equal(allowed.executionStatus, 'DONE');
    }));
  });
  describe('given the source checkout becomes dirty while the first run executes', () => {
    it('when the run finishes then Execution stays DONE and only the merge assessment is retryable', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: async () => { await unrelatedEdit(root); return { files: [{ path: 'greeting.mjs', content: good }] }; } });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.status, 'RETRYABLE');
      assert.equal(run.merge.failure.code, 'SOURCE_DIRTY');
    }));
  });
  describe('given a dirty change to a trusted input', () => {
    it('when resumed then still requires a new run instead of retrying', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await writeFile(join(root, 'tools/harness/sample-bdd.mjs'), '// changed');
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'ESCALATED');
      assert.deepEqual({ code: resumed.merge.failure.code, retryable: resumed.merge.failure.retryable }, { code: 'SOURCE_CHANGED', retryable: false });
    }));
  });
  describe('given the verified workspace changes after Execution DONE', () => {
    it('when resumed then escalates the merge assessment but keeps Execution DONE', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await writeFile(join(root, run.runDir, 'workspace/greeting.mjs'), 'bad change');
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'ESCALATED');
      assert.equal(resumed.executionStatus, 'DONE');
      assert.equal(resumed.merge.state, 'BLOCKED');
      assert.deepEqual({ code: resumed.merge.failure.code, retryable: resumed.merge.failure.retryable }, { code: 'WORKSPACE_CHANGED', retryable: false });
      assert.deepEqual({ status: resumed.events.at(-1).status, phase: resumed.events.at(-1).phase }, { status: 'ESCALATED', phase: 'merge' });
      assert.equal((await readJson(join(root, run.runDir, 'escalation.json'))).code, 'WORKSPACE_CHANGED');
    }));
    it('when the change is reverted then the escalated run neither resumes to a merge decision nor opens a pull request', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      const path = join(root, run.runDir, 'workspace/greeting.mjs');
      const original = await readFile(path, 'utf8');
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      await writeFile(path, 'bad change');
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'ESCALATED');
      await writeFile(path, original);
      const again = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(again.status, 'ESCALATED');
      assert.equal(again.merge.state, 'BLOCKED');
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /ESCALATED/);
    }));
  });
  describe('given the execution itself escalates', () => {
    it('when the run stops then the escalation is an execution event and no merge failure is recorded', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: async () => ({ escalation: 'cannot decide', files: [] }) });
      assert.equal(run.executionStatus, 'ESCALATED');
      assert.deepEqual({ status: run.events.at(-1).status, phase: run.events.at(-1).phase }, { status: 'ESCALATED', phase: 'execution' });
      assert.equal(run.merge.failure, undefined);
    }));
  });
});
