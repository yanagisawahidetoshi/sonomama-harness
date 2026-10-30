import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordPbiAcceptance, pbiAcceptanceRecords, pbiAcceptanceLedgerPath, recordEvidenceManifest, evidenceManifests } from './pbi-acceptance.mjs';
import { parseIssueUrl } from './planner.mjs';

const pbiUrl = 'https://github.com/acme/app/issues/8';
const digest = 'a'.repeat(64);
const human = (id = 'os:501:reviewer') => async () => ({ id, kind: 'human', source: 'local-os-user' });
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'harness-pbi-acceptance-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe('PBI Human Acceptance ledger', () => {
  describe('given a human at the trusted CLI', () => {
    for (const decision of ['APPROVE', 'REQUEST_CHANGES', 'REVOKE']) {
      it(`when ${decision} is recorded then the signed ledger returns a pbi-acceptance record bound to the PBI, the reviewer and the evidence digest`, () => withRoot(async root => {
        const record = await recordPbiAcceptance({ root, pbiUrl, evidenceDigest: digest, decision, identityProvider: human() });
        assert.equal(record.purpose, 'pbi-acceptance');
        const [read] = await pbiAcceptanceRecords(root, pbiUrl);
        assert.deepEqual(read, record);
        assert.equal(read.pbiUrl, pbiUrl);
        assert.equal(read.reviewer, 'os:501:reviewer');
        assert.equal(read.decision, decision);
        assert.equal(read.evidenceDigest, digest);
        assert.match(read.signature, /^[0-9a-f]{64}$/);
      }));
    }
    it('when nothing was recorded for the PBI then the ledger is empty', () => withRoot(async root => {
      assert.deepEqual(await pbiAcceptanceRecords(root, pbiUrl), []);
    }));
    it('when a later decision is recorded then the earlier one is kept in order', () => withRoot(async root => {
      await recordPbiAcceptance({ root, pbiUrl, evidenceDigest: digest, decision: 'APPROVE', identityProvider: human() });
      await recordPbiAcceptance({ root, pbiUrl, evidenceDigest: digest, decision: 'REVOKE', identityProvider: human() });
      assert.deepEqual((await pbiAcceptanceRecords(root, pbiUrl)).map(r => r.decision), ['APPROVE', 'REVOKE']);
    }));
    it('when another PBI is recorded then its decision never appears in this PBI', () => withRoot(async root => {
      await recordPbiAcceptance({ root, pbiUrl: 'https://github.com/acme/app/issues/9', evidenceDigest: digest, decision: 'APPROVE', identityProvider: human() });
      assert.deepEqual(await pbiAcceptanceRecords(root, pbiUrl), []);
    }));
  });

  describe('given input that is not a decision of an authenticated human', () => {
    for (const [name, options, pattern] of [
      ['an AI identity', { identityProvider: async () => ({ id: 'agent', kind: 'ai', source: 'agent' }) }, /human identity/],
      ['no identity', { identityProvider: async () => null }, /human identity/],
      ['an unknown decision', { decision: 'MERGE' }, /decision/],
      ['an evidence digest that is not sha256', { evidenceDigest: 'abc' }, /digest/],
      ['a pull request URL instead of the PBI Issue', { pbiUrl: 'https://github.com/acme/app/pull/8' }, /Issue URL/],
    ]) {
      it(`when it comes with ${name} then nothing is recorded`, () => withRoot(async root => {
        await assert.rejects(recordPbiAcceptance({ root, pbiUrl, evidenceDigest: digest, decision: 'APPROVE', identityProvider: human(), ...options }), pattern);
        assert.deepEqual(await pbiAcceptanceRecords(root, pbiUrl), []);
      }));
    }
  });

  describe('given a ledger edited outside the CLI', () => {
    it('when a record is changed then reading fails closed instead of trusting it', () => withRoot(async root => {
      await recordPbiAcceptance({ root, pbiUrl, evidenceDigest: digest, decision: 'REQUEST_CHANGES', identityProvider: human() });
      const path = pbiAcceptanceLedgerPath(root, parseIssueUrl(pbiUrl));
      await writeFile(path, (await readFile(path, 'utf8')).replace('REQUEST_CHANGES', 'APPROVE'));
      await assert.rejects(pbiAcceptanceRecords(root, pbiUrl), /signature invalid/);
    }));
    it('when a signed record of another PBI is copied into this ledger then reading fails closed', () => withRoot(async root => {
      await recordPbiAcceptance({ root, pbiUrl: 'https://github.com/acme/app/issues/9', evidenceDigest: digest, decision: 'APPROVE', identityProvider: human() });
      await writeFile(pbiAcceptanceLedgerPath(root, parseIssueUrl(pbiUrl)), await readFile(pbiAcceptanceLedgerPath(root, parseIssueUrl('https://github.com/acme/app/issues/9')), 'utf8'));
      await assert.rejects(pbiAcceptanceRecords(root, pbiUrl), /signature invalid/);
    }));
  });
});

describe('PBI Evidence manifest ledger', () => {
  const manifest = (overrides = {}) => ({ evidenceDigest: digest, plan: { digest: 'c'.repeat(64), revision: 1, approvalKey: 'd'.repeat(64) }, sbis: [{
    id: 'SBI-001', number: 11, kind: 'implementation', pullRequest: 21, headSha: 'a'.repeat(40), mergeCommitSha: 'b'.repeat(40), requiredChecks: [{ name: 'harness', status: 'SUCCESS' }],
    e2e: { status: 'PASS', api: 'mock' }, lane: 'mock', resultDigest: 'e'.repeat(64), workflowRunId: 900, artifactId: 1,
  }], ...overrides });
  describe('given the trusted CLI after a verified APPROVE', () => {
    it('when a manifest is recorded then it is read back signed and bound to the PBI', () => withRoot(async root => {
      const recorded = await recordEvidenceManifest({ root, pbiUrl, manifest: manifest() });
      const [read] = await evidenceManifests(root, pbiUrl);
      assert.deepEqual(read, recorded);
      assert.equal(read.pbiUrl, pbiUrl);
      assert.match(read.signature, /^[0-9a-f]{64}$/);
    }));
    it('when the manifest misses a field then nothing is recorded', () => withRoot(async root => {
      const { lane, ...partial } = manifest().sbis[0];
      await assert.rejects(recordEvidenceManifest({ root, pbiUrl, manifest: manifest({ sbis: [partial] }) }));
      assert.deepEqual(await evidenceManifests(root, pbiUrl), []);
    }));
  });
});
