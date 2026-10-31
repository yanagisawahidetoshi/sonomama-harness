import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, human, prototype, runFixture as runHarness } from './test-fixture.mjs';
import { resumeRun, cleanupRun } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { readJson } from './io.mjs';
import { healthMetrics } from './health-metrics.mjs';
import { classifyEscalation, escalationCodes } from './escalation.mjs';
const sbiPath = '.harness/state/sample-sbi.json';
const metricsOf = (root, run) => readJson(join(root, run.runDir, 'health-metrics.json'));
const wrong = async () => ({ files: [{ path: 'greeting.mjs', content: 'export const greet = () => "wrong";' }] });

describe('Health metrics signal collection', () => {
  describe('given a completed medium-risk run waiting for human review', () => {
    it('when the run finishes then writes versioned run, iteration, verifier and approval metrics', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.status, 'WAITING_FOR_HUMAN_REVIEW');
      const metrics = await metricsOf(root, run);
      assert.equal(metrics.version, 1);
      assert.equal(metrics.runId, run.id);
      assert.equal(metrics.sbiId, 'SBI-001');
      assert.equal(metrics.lane, 'production');
      assert.equal(metrics.provider, 'fake');
      assert.equal(metrics.startedAt, run.startedAt);
      assert.equal(metrics.finishedAt, run.events.at(-1).at);
      assert.equal(metrics.durationMs, Date.parse(metrics.finishedAt) - Date.parse(metrics.startedAt));
      const execution = run.events.filter(e => e.phase === 'execution');
      assert.equal(metrics.executionDurationMs, Date.parse(execution.at(-1).at) - Date.parse(execution.find(e => e.status === 'IMPLEMENTING').at));
      assert.ok(metrics.executionDurationMs <= metrics.durationMs);
      assert.equal(metrics.executionStatus, 'DONE');
      assert.equal(metrics.mergeStatus, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(metrics.riskLevel, 2);
      assert.equal(metrics.riskPhase, 'post-execution');
      assert.equal(metrics.autoMergeEligible, false);
      assert.equal(metrics.cleaned, false);
      assert.deepEqual(metrics.iterations, { total: 2, failed: 1, done: true, limitReached: false, consecutiveFailure: false });
      assert.deepEqual(metrics.verifiers.summary, { pass: 1, fail: 0, skip: 14, notConfigured: 0 });
      assert.deepEqual(metrics.verifiers.checks.find(c => c.id === 'sample-bdd'), { id: 'sample-bdd', status: 'PASS', required: true });
      assert.equal(metrics.security.securitySensitive, false);
      assert.deepEqual(metrics.security.matchedRules, []);
      assert.equal(metrics.security.requiredVerifierCount, run.securityAssessment.requiredVerifiers.length);
      assert.equal(metrics.security.preImplementationGateRequired, false);
      assert.equal(metrics.security.verification.pass, run.securityAssessment.requiredVerifiers.length);
      assert.equal(metrics.security.verification.notConfigured, 0);
      assert.equal(metrics.approvals.design, undefined);
      assert.deepEqual(metrics.approvals.implementationGate, { required: false, state: 'NOT_REQUIRED' });
      assert.deepEqual(metrics.approvals.merge, { required: 1, valid: 0, requestedChanges: false });
      assert.deepEqual(metrics.review, { policyReview: 'PASS', semanticReview: { enabled: true, status: 'PASS' }, humanReviewRequired: true });
      assert.equal(metrics.escalation, null);
    }));
    it('when one human approves and the run resumes then records MERGE_ALLOWED without reviewer identities', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('alice-reviewer') });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'MERGE_ALLOWED');
      const text = await readFile(join(root, run.runDir, 'health-metrics.json'), 'utf8');
      const metrics = JSON.parse(text);
      assert.equal(metrics.mergeStatus, 'MERGE_ALLOWED');
      assert.deepEqual(metrics.approvals.merge, { required: 1, valid: 1, requestedChanges: false });
      assert.doesNotMatch(text, /alice-reviewer|reviewer/i);
    }));
    it('when the run resumes for approval then lifecycle duration grows while execution duration stays fixed', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      const before = await metricsOf(root, run);
      await new Promise(resolve => setTimeout(resolve, 20));
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      await resumeRun({ root, runId: run.id, quiet: true });
      const after = await metricsOf(root, run);
      assert.ok(after.durationMs > before.durationMs);
      assert.equal(after.executionDurationMs, before.executionDurationMs);
    }));
    it('when a human requests changes then records the rejection as a flag', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'merge', decision: 'REQUEST_CHANGES', identityProvider: human('A') });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'REJECTED');
      const metrics = await metricsOf(root, run);
      assert.equal(metrics.mergeStatus, 'REJECTED');
      assert.equal(metrics.approvals.merge.requestedChanges, true);
    }));
    it('when health-metrics.json is corrupted before resume then the merge decision is unchanged and the file is regenerated', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await writeFile(join(root, run.runDir, 'health-metrics.json'), '{"version":999,"mergeStatus":"MERGE_ALLOWED",broken');
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(resumed.merge.autoMergeEligible, false);
      const metrics = await metricsOf(root, run);
      assert.equal(metrics.version, 1);
      assert.equal(metrics.mergeStatus, 'WAITING_FOR_HUMAN_REVIEW');
    }));
    it('when the workspace is cleaned then marks the metrics as cleaned instead of a real block', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await cleanupRun({ root, runId: run.id });
      const metrics = await metricsOf(root, run);
      assert.equal(metrics.cleaned, true);
      assert.equal(metrics.mergeStatus, 'BLOCKED');
      assert.equal(metrics.executionStatus, 'DONE');
    }));
  });
  describe('given an approved SBI with a Human Gate risk', () => {
    // #175: the SBI approval covered AuthN, so the metrics show no implementation gate and the run starts implementing at once.
    it('when the run starts then records no implementation gate, the preflight risk and the reason it stopped later', () => fixture(async root => {
      await update(root, sbiPath, s => s.risks = ['AuthN']);
      const run = await runHarness({ root, quiet: true, agent: async () => ({ escalation: 'API契約とDesignが矛盾しています', files: [] }) });
      const metrics = await metricsOf(root, run);
      assert.equal(metrics.executionStatus, 'ESCALATED');
      assert.equal(metrics.riskLevel, 3);
      assert.equal(metrics.riskPhase, 'preflight');
      assert.deepEqual(metrics.approvals.implementationGate, { required: false, state: 'NOT_REQUIRED' });
      assert.deepEqual(metrics.escalation, { code: 'AGENT_ESCALATION' });
      assert.equal(metrics.iterations.total, 1);
    }));
    it('when a prototype is promoted then the metrics have no Design Approval and the run reaches merge review', () => fixture(async root => {
      const { agent } = await prototype(root, { promotion: true });
      const run = await runHarness({ root, quiet: true, agent });
      const metrics = await metricsOf(root, run);
      assert.equal(metrics.lane, 'production');
      assert.equal(metrics.approvals.design, undefined);
      assert.deepEqual(metrics.approvals.implementationGate, { required: false, state: 'NOT_REQUIRED' });
      assert.equal(metrics.mergeStatus, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(metrics.escalation, null);
    }));
    it('when the SBI is ambiguous then records SPEC_AMBIGUOUS with no lane', () => fixture(async root => {
      await update(root, sbiPath, s => s.ambiguous = true);
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.status, 'ESCALATED');
      const metrics = await metricsOf(root, run);
      assert.equal(metrics.lane, null);
      assert.equal(metrics.riskLevel, null);
      assert.deepEqual(metrics.escalation, { code: 'SPEC_AMBIGUOUS' });
    }));
  });
  describe('given an escalated run', () => {
    it('when three consecutive verifications fail then records CONSECUTIVE_FAILURE and the failed iterations', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: wrong });
      assert.equal(run.status, 'ESCALATED');
      assert.match(run.reason, /3/);
      const metrics = await metricsOf(root, run);
      assert.equal(metrics.executionStatus, 'ESCALATED');
      assert.equal(metrics.mergeStatus, 'BLOCKED');
      assert.deepEqual(metrics.iterations, { total: 3, failed: 3, done: false, limitReached: false, consecutiveFailure: true });
      assert.equal(metrics.verifiers.summary.fail, 1);
      assert.deepEqual(metrics.escalation, { code: 'CONSECUTIVE_FAILURE' });
      assert.equal(JSON.parse(await readFile(join(root, run.runDir, 'escalation.json'), 'utf8')).code, 'CONSECUTIVE_FAILURE');
    }));
    it('when a selected application verifier has no commands then records VERIFIER_NOT_CONFIGURED and counts it', () => fixture(async root => {
      await writeFile(join(root, 'apps/api/Gemfile'), '# Rails');
      await update(root, '.harness/config/harness.json', c => { c.verifiers.find(v => v.id === 'rails').commands = []; });
      await update(root, sbiPath, s => s.allowedFiles = ['greeting.mjs', 'apps/api/note.txt']);
      const run = await runHarness({ root, quiet: true, agent: async () => ({ files: [{ path: 'greeting.mjs', content: 'export const greet = () => "wrong";' }, { path: 'apps/api/note.txt', content: 'note' }] }) });
      assert.equal(run.status, 'ESCALATED');
      const metrics = await metricsOf(root, run);
      assert.equal(metrics.escalation.code, 'VERIFIER_NOT_CONFIGURED');
      assert.ok(metrics.verifiers.summary.notConfigured >= 1);
      assert.equal(metrics.iterations.consecutiveFailure, false);
    }));
    it('when the iteration limit is reached then records ITERATION_LIMIT', () => fixture(async root => {
      await update(root, '.harness/config/harness.json', c => { c.maxIterations = 2; c.maxConsecutiveFailures = 3; });
      const run = await runHarness({ root, quiet: true, agent: wrong });
      assert.equal(run.status, 'ESCALATED');
      const metrics = await metricsOf(root, run);
      assert.deepEqual(metrics.iterations, { total: 2, failed: 2, done: false, limitReached: true, consecutiveFailure: false });
      assert.equal(metrics.escalation.code, 'ITERATION_LIMIT');
    }));
    it('when the approved workspace changes before resume then records WORKSPACE_CHANGED', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await writeFile(join(root, run.runDir, 'workspace/greeting.mjs'), 'bad change');
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'ESCALATED');
      assert.equal((await metricsOf(root, run)).escalation.code, 'WORKSPACE_CHANGED');
    }));
    it('when an agent escalation carries PII or a credential then the metrics keep only the reason code', () => fixture(async root => {
      const message = 'ask taro.yamada@example.com or 090-1234-5678; token=abc123secretvalue';
      const run = await runHarness({ root, quiet: true, agent: async () => ({ escalation: message, files: [] }) });
      assert.equal(run.status, 'ESCALATED');
      const text = await readFile(join(root, run.runDir, 'health-metrics.json'), 'utf8');
      assert.doesNotMatch(text, /example\.com|yamada|090-1234-5678|abc123secretvalue|detail/);
      const metrics = JSON.parse(text);
      assert.deepEqual(metrics.escalation, { code: 'AGENT_ESCALATION' });
      assert.doesNotMatch(text, /prompt|"files"/i);
      const human = JSON.parse(await readFile(join(root, run.runDir, 'escalation.json'), 'utf8'));
      assert.match(human.reason, /taro\.yamada@example\.com/);
      assert.doesNotMatch(human.reason, /abc123secretvalue/);
    }));
  });
  describe('given a summary written before health metrics existed', () => {
    it('when metrics are derived then every missing field becomes null or zero instead of throwing', () => {
      const metrics = healthMetrics({ id: 'legacy', sbi: 'SBI-001', provider: 'fake', status: 'PENDING', executionStatus: 'PENDING', iterations: [], events: [],
        gate: { required: false, state: 'NOT_REQUIRED' }, merge: { state: 'NOT_ASSESSED', autoMergeEligible: false }, startedAt: '2026-01-01T00:00:00.000Z' });
      assert.equal(metrics.version, 1);
      assert.equal(metrics.lane, null);
      assert.equal(metrics.finishedAt, null);
      assert.equal(metrics.durationMs, null);
      assert.equal(metrics.executionDurationMs, null);
      assert.equal(metrics.riskLevel, null);
      assert.equal(metrics.riskPhase, null);
      assert.equal(metrics.approvals.design, undefined);
      assert.deepEqual(metrics.security, { securitySensitive: null, matchedRules: [], requiredVerifierCount: null, preImplementationGateRequired: null, verification: { pass: 0, fail: 0, skip: 0, notConfigured: 0 } });
      assert.equal(metrics.escalation, null);
    });
  });
  describe('given free-text runtime errors', () => {
    const cases = [
      ['scope/path violation: ../x', 'SCOPE_VIOLATION'], ['scope file size exceeded: a', 'SCOPE_VIOLATION'], ['scope symlink: a', 'SCOPE_VIOLATION'],
      ['scope duplicate path', 'SCOPE_VIOLATION'], ['scope/path is reserved: tools/x', 'SCOPE_VIOLATION'], ['trusted test path is reserved: x.test.mjs', 'SCOPE_VIOLATION'],
      ['Prototype scope escalated; declare production/security scope in a new SBI', 'LANE_ESCALATION'],
      ['HEAD/snapshot changed; checks and approvals must be regenerated in a new run', 'WORKSPACE_CHANGED'], ['workspace snapshot changed', 'WORKSPACE_CHANGED'],
      ['Verifier mutated the source snapshot', 'WORKSPACE_CHANGED'], ['workspace is not an owned Git worktree', 'WORKSPACE_CHANGED'],
      ['Source must be clean; uncommitted inputs or source HEAD changed', 'SOURCE_CHANGED'], ['input snapshot changed', 'SOURCE_CHANGED'],
      ['config snapshot changed; start a new run', 'SOURCE_CHANGED'], ['trusted tool/skill snapshot changed', 'SOURCE_CHANGED'],
      ['something nobody anticipated', 'UNKNOWN'],
    ];
    for (const [message, code] of cases) it(`when the message is "${message}" then classifies as ${code}`, () => assert.equal(classifyEscalation(message), code));
    it('when a code is produced then it belongs to the published list', () => {
      for (const [message] of cases) assert.ok(escalationCodes.includes(classifyEscalation(message)));
      for (const code of ['SPEC_AMBIGUOUS', 'DESIGN_DECISION_REQUIRED', 'AGENT_ESCALATION', 'SECRET_PROPOSAL', 'NEW_SECURITY_SCOPE', 'NEW_HIGH_RISK',
        'VERIFIER_NOT_CONFIGURED', 'SECURITY_VERIFIER_NOT_CONFIGURED', 'ITERATION_LIMIT', 'CONSECUTIVE_FAILURE']) assert.ok(escalationCodes.includes(code), code);
    });
  });
});
