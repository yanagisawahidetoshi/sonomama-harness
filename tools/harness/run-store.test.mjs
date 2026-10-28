import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, human, runFixture as runHarness } from './test-fixture.mjs';
import { resumeRun, openPullRequest, cleanupRun } from './index.mjs';
import { recordDecision, signingKey } from './human-approvals.mjs';
import { runStateSignature } from './run-store.mjs';
import { readJson } from './io.mjs';

const summaryPath = (root, run) => join(root, run.runDir, 'summary.json');
async function tamper(root, run, fn) {
  const value = await readJson(summaryPath(root, run));
  fn(value);
  await writeFile(summaryPath(root, run), JSON.stringify(value, null, 2) + '\n');
}
// Simulates a writer that holds the signing key but writes a structure the Harness never produces.
async function resign(root, run, fn) {
  const { integrity, ...body } = await readJson(summaryPath(root, run));
  fn(body);
  await writeFile(summaryPath(root, run), JSON.stringify({ ...body, integrity: { ...integrity, signature: runStateSignature(await signingKey(root), body) } }, null, 2) + '\n');
}

describe('Run state integrity', () => {
  describe('given a completed run whose summary.json was written only by the Harness', () => {
    it('when resumed and approved then reaches the same merge decisions as before', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'MERGE_ALLOWED');
    }));
    it('when only the projection copies are edited then resume ignores them', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await writeFile(join(root, '.harness/state/runs', `${run.id}.json`), JSON.stringify({ ...run, status: 'MERGE_ALLOWED' }));
      await writeFile(join(root, run.runDir, 'merge-decision.json'), JSON.stringify({ state: 'MERGE_ALLOWED' }));
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
    }));
  });
  describe('given a decision-relevant field in summary.json is rewritten outside the Harness', () => {
    const cases = {
      'a failed verification is marked PASS': s => { s.iterations[0].verification.status = 'PASS'; },
      'a failed iteration is marked complete': s => { s.iterations[0].completion = true; },
      'the required security verifiers are removed': s => { s.securityAssessment.requiredVerifiers = []; s.securityAssessment.securitySensitive = false; },
      'the security result is rewritten': s => { s.iterations.at(-1).security.status = 'FAIL'; },
      'the head SHA is replaced': s => { s.headSha = s.baselineSha; },
      'the workspace digest is replaced': s => { s.workspaceDigest = '0'.repeat(64); },
      'the merge state is promoted': s => { s.status = 'MERGE_ALLOWED'; s.merge.state = 'MERGE_ALLOWED'; },
    };
    for (const [name, fn] of Object.entries(cases)) {
      it(`when ${name} then resume stops without rewriting the state`, () => fixture(async root => {
        const run = await runHarness({ root, quiet: true });
        await tamper(root, run, fn);
        const before = await readFile(summaryPath(root, run), 'utf8');
        await assert.rejects(resumeRun({ root, runId: run.id, quiet: true }), /run state integrity/);
        assert.equal(await readFile(summaryPath(root, run), 'utf8'), before);
      }));
    }
    it('when the escalation of a completed run is removed then resume still refuses it', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await writeFile(join(root, run.runDir, 'workspace/greeting.mjs'), 'bad change');
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'ESCALATED');
      await tamper(root, run, s => { s.status = 'WAITING_FOR_HUMAN_REVIEW'; delete s.escalation; });
      await assert.rejects(resumeRun({ root, runId: run.id, quiet: true }), /run state integrity/);
    }));
    it('when the integrity record is missing then resume refuses the run', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await tamper(root, run, s => { delete s.integrity; });
      await assert.rejects(resumeRun({ root, runId: run.id, quiet: true }), /run state integrity/);
    }));
    it('when the state is tampered then pull request, approval and cleanup also refuse it', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await tamper(root, run, s => { s.iterations[0].completion = true; });
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /run state integrity/);
      await assert.rejects(recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') }), /run state integrity/);
      await assert.rejects(cleanupRun({ root, runId: run.id }), /run state integrity/);
    }));
  });
  describe('given a correctly signed summary.json that violates the run state schema', () => {
    const cases = {
      'an unknown execution status': s => { s.executionStatus = 'MERGED'; },
      'a missing head SHA': s => { delete s.headSha; },
      'a malformed workspace digest': s => { s.workspaceDigest = 'not-a-digest'; },
      'an unknown top-level field': s => { s.approvedBy = 'agent'; },
      'a non-boolean completion': s => { s.iterations.at(-1).completion = 'yes'; },
    };
    for (const [name, fn] of Object.entries(cases)) {
      it(`when it has ${name} then resume refuses to load it`, () => fixture(async root => {
        const run = await runHarness({ root, quiet: true });
        await resign(root, run, fn);
        await assert.rejects(resumeRun({ root, runId: run.id, quiet: true }), /run state schema/);
      }));
    }
  });
});
