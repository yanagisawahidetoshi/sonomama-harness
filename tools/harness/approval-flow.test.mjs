import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, human } from './test-fixture.mjs';
import { runHarness, resumeRun } from './index.mjs';
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
  describe('given RLS work requires an implementation gate', () => {
    it('when merge approval is attempted before the gate then refuses it', () => fixture(async root => {
      await update(root, sbiPath, s => s.risks = ['RLS']);
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.status, 'WAITING_FOR_HUMAN_GATE');
      assert.equal(run.gate.state, 'WAITING_FOR_HUMAN_GATE');
      assert.equal(run.merge.state, 'NOT_ASSESSED');
      assert.equal(run.iterations.length, 0);
      await assert.rejects(recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') }), /execution|gate/i);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).iterations.length, 0);
    }));
    it('when the gate is approved then executes but still requires two separate merge approvals', () => fixture(async root => {
      await update(root, '.harness/config/harness.json', c => c.securityVerifiers = [{ id: 'rails-rls-test', directory: 'apps/api', commands: [[process.execPath, '-e', 'require("node:assert/strict").ok(true)']] }]);
      await update(root, sbiPath, s => s.risks = ['RLS']);
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'implementation-gate', identityProvider: human('Designer') });
      let resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.gate.state, 'APPROVED');
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
    it('when a gate is rejected then never invokes the agent', () => fixture(async root => {
      await update(root, sbiPath, s => s.risks = ['RLS']);
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'implementation-gate', decision: 'REQUEST_CHANGES', identityProvider: human('A') });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'REJECTED');
      assert.equal(resumed.iterations.length, 0);
    }));
  });
});

describe('Workspace and verifier registry', () => {
  describe('given root app contents differ from generated code', () => {
    it('when a command verifier runs then validates the same workspace the agent wrote', () => fixture(async root => {
      await writeFile(join(root, 'apps/admin/package.json'), '{"private":true}');
      await writeFile(join(root, 'apps/admin/message.txt'), 'root');
      await update(root, sbiPath, s => s.allowedFiles.push('apps/admin/message.txt'));
      await update(root, '.harness/config/harness.json', c => c.verifiers.find(v => v.id === 'admin').commands = [[process.execPath, '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("message.txt", "utf8"), "workspace")']]);
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
      await update(root, '.harness/config/harness.json', c => c.verifiers.push({ id: 'docs-bdd', directory: 'docs/product', planned: ['BDD'], acceptanceIds: ['DOC-1'], commands: [[process.execPath, '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("intro.md","utf8"),"Welcome.")']] }));
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
    it('when SBI changes after a gate approval then requires a new run', () => fixture(async root => {
      await update(root, sbiPath, s => s.risks = ['RLS']);
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'implementation-gate', identityProvider: human('A') });
      await update(root, sbiPath, s => s.description += ' changed scope');
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'ESCALATED');
      assert.equal(resumed.iterations.length, 0);
    }));
    it('when semantic review is enabled without an adapter then never marks completion', () => fixture(async root => {
      await update(root, '.harness/config/harness.json', c => c.semanticReview.enabled = true);
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.iterations.at(-1).semanticReview.status, 'FAIL');
    }));
    it('when security check finds a private key after gate approval then fails and stops', () => fixture(async root => {
      await update(root, sbiPath, s => s.risks = ['secret']);
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'implementation-gate', identityProvider: human('A') });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true, agent: async () => ({ files: [{ path: 'greeting.mjs', content: good + '\n// -----BEGIN PRIVATE KEY-----' }] }) });
      assert.equal(resumed.status, 'ESCALATED');
      assert.equal(resumed.iterations.length, 1);
      assert.equal(resumed.iterations[0].security.status, 'FAIL');
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
