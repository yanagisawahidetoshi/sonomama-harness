import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sbiSchema, plannedSbiSchema } from './schemas.mjs';
import { canStart, judgePbi, e2eApi } from './pbi-judge.mjs';
import { judge } from './completion-judge.mjs';

const pbiUrl = 'https://github.com/acme/app/issues/8';
const evidenceDigest = 'a'.repeat(64);
const sbis = [
  { id: 'SBI-001', kind: 'implementation', dependsOn: [] },
  { id: 'SBI-002', kind: 'implementation', dependsOn: ['SBI-001'] },
  { id: 'SBI-003', kind: 'validation', dependsOn: ['SBI-001', 'SBI-002'] },
];
const implemented = { merged: true, requiredVerifiers: 'PASS', e2e: { status: 'PASS', api: 'mock' } };
const validated = { e2e: { status: 'PASS', api: 'real' }, evidenceDigest };
const approval = (overrides = {}) => ({
  id: 'rec-1', purpose: 'pbi-acceptance', pbiUrl, reviewer: 'os:501:reviewer', kind: 'human', identitySource: 'local-os-user',
  decision: 'APPROVE', decidedAt: '2026-10-28T00:00:00.000Z', evidenceDigest, signature: 's'.repeat(64), ...overrides,
});
const done = (overrides = {}) => ({
  pbiUrl, sbis,
  results: { 'SBI-001': implemented, 'SBI-002': { ...implemented, e2e: null }, 'SBI-003': validated },
  acceptanceRecords: [approval()], blockingBugs: [], ...overrides,
});
// Without a validation SBI the adapter supplies the digest of the merged implementation evidence the human confirms.
const implementationsOnly = (overrides = {}) => done({
  sbis: sbis.filter(s => s.kind === 'implementation'), results: { 'SBI-001': implemented, 'SBI-002': implemented }, evidenceDigest, ...overrides,
});

describe('SBI kind', () => {
  describe('given an SBI JSON for the Execution Harness', () => {
    it('when the kind is omitted then it is an implementation SBI so existing SBI JSON keeps working', async () => {
      const sample = JSON.parse(await readFile(new URL('../../.harness/state/sample-sbi.json', import.meta.url), 'utf8'));
      assert.equal(sbiSchema.parse(sample).kind, 'implementation');
    });
    for (const kind of ['implementation', 'validation']) {
      it(`when the kind is ${kind} then it is accepted`, async () => {
        const sample = JSON.parse(await readFile(new URL('../../.harness/state/sample-sbi.json', import.meta.url), 'utf8'));
        assert.equal(sbiSchema.parse({ ...sample, kind }).kind, kind);
      });
    }
    for (const kind of ['acceptance', 'release']) {
      it(`when the kind is ${kind} then it is rejected so a human check never becomes an SBI the Execution Harness runs`, async () => {
        const sample = JSON.parse(await readFile(new URL('../../.harness/state/sample-sbi.json', import.meta.url), 'utf8'));
        assert.equal(sbiSchema.safeParse({ ...sample, kind }).success, false);
      });
    }
  });
  describe('given an SBI candidate from the Planner provider', () => {
    it('when the candidate has no kind then it is rejected so every generated SBI states its kind', () => {
      const candidate = { id: 'SBI-001', title: 't', purpose: 'p', scope: { included: ['x'], excluded: [] }, acceptanceCriteria: [], scenarios: [], dependsOn: [], changeAreas: [], layers: [], estimatedFiles: 0, oversizeReason: null, riskCandidate: 'L2', securityImpact: [], verification: { applicationTest: 'a', acceptance: 'b', e2e: 'c' } };
      assert.equal(plannedSbiSchema.safeParse(candidate).success, false);
      assert.equal(plannedSbiSchema.safeParse({ ...candidate, kind: 'validation' }).success, true);
    });
    it('when the candidate is a human acceptance SBI then it is rejected because human acceptance is a PBI Gate', () => {
      const candidate = { id: 'SBI-001', kind: 'acceptance', title: 't', purpose: 'p', scope: { included: ['x'], excluded: [] }, acceptanceCriteria: [], scenarios: [], dependsOn: [], changeAreas: [], layers: [], estimatedFiles: 0, oversizeReason: null, riskCandidate: 'L2', securityImpact: [], verification: { applicationTest: 'a', acceptance: 'b', e2e: 'c' } };
      assert.equal(plannedSbiSchema.safeParse(candidate).success, false);
    });
  });
  describe('given the kind of an SBI', () => {
    it('when choosing the API for Maestro E2E then implementation uses the mock and validation the real API', () => {
      assert.deepEqual(['implementation', 'validation'].map(e2eApi), ['mock', 'real']);
    });
  });
});

describe('PBI Completion Judge', () => {
  describe('given a PBI with implementation SBIs and one validation SBI', () => {
    it('when every implementation SBI is done, validation passed against the real API, the PBI Human Acceptance Gate is approved and no bug blocks then the PBI is DONE', () => {
      assert.deepEqual(judgePbi(done()), { status: 'DONE', sbis: { 'SBI-001': 'DONE', 'SBI-002': 'DONE', 'SBI-003': 'DONE' }, acceptance: 'APPROVED', reasons: [] });
    });
    const notDone = [
      ['an implementation SBI is not merged', { results: { ...done().results, 'SBI-002': { ...implemented, merged: false } } }, /SBI-002/],
      ['a required verifier of an implementation SBI failed', { results: { ...done().results, 'SBI-001': { ...implemented, requiredVerifiers: 'FAIL' } } }, /SBI-001/],
      ['the mock Maestro E2E of an implementation SBI failed', { results: { ...done().results, 'SBI-001': { ...implemented, e2e: { status: 'FAIL', api: 'mock' } } } }, /SBI-001.*E2E/],
      ['the Maestro E2E of an implementation SBI ran against the real API', { results: { ...done().results, 'SBI-001': { ...implemented, e2e: { status: 'PASS', api: 'real' } } } }, /SBI-001.*モック/],
      ['the validation E2E failed', { results: { ...done().results, 'SBI-003': { ...validated, e2e: { status: 'FAIL', api: 'real' } } } }, /SBI-003.*E2E/],
      ['the validation E2E ran against the mock', { results: { ...done().results, 'SBI-003': { ...validated, e2e: { status: 'PASS', api: 'mock' } } } }, /SBI-003.*実API/],
      ['the validation has no result yet', { results: { 'SBI-001': implemented, 'SBI-002': implemented } }, /SBI-003/],
      ['no human approved the PBI Human Acceptance Gate', { acceptanceRecords: [] }, /PBI Human Acceptance Gate.*承認/],
      ['the only approval was revoked', { acceptanceRecords: [approval(), approval({ id: 'rec-2', decision: 'REVOKE', decidedAt: '2026-10-28T01:00:00.000Z' })] }, /PBI Human Acceptance Gate.*承認/],
      ['the approval is for a different validation evidence', { acceptanceRecords: [approval({ evidenceDigest: 'b'.repeat(64) })] }, /PBI Human Acceptance Gate.*承認/],
      ['the approval is for another PBI', { acceptanceRecords: [approval({ pbiUrl: 'https://github.com/acme/app/issues/9' })] }, /PBI Human Acceptance Gate.*承認/],
      ['the approval is an agent JSON without a human identity', { acceptanceRecords: [approval({ kind: 'ai' })] }, /PBI Human Acceptance Gate.*承認/],
      ['the approval comes from the merge approval purpose', { acceptanceRecords: [approval({ purpose: 'merge' })] }, /PBI Human Acceptance Gate.*承認/],
      ['the plan has two validation SBIs', { sbis: [...sbis, { id: 'SBI-004', kind: 'validation', dependsOn: ['SBI-001', 'SBI-002'] }], results: { ...done().results, 'SBI-004': validated } }, /最終確認SBI.*2件/],
      ['an unresolved bug blocks the PBI', { blockingBugs: [{ url: 'https://github.com/acme/app/issues/20', state: 'open' }] }, /issues\/20/],
    ];
    for (const [condition, overrides, reason] of notDone) {
      it(`when ${condition} then the PBI is not DONE and the reason names it`, () => {
        const result = judgePbi(done(overrides));
        assert.equal(result.status, 'NOT_DONE');
        assert.ok(result.reasons.some(r => reason.test(r)), JSON.stringify(result.reasons));
      });
    }
    it('when a blocking bug is already closed then it does not block the PBI', () => {
      assert.equal(judgePbi(done({ blockingBugs: [{ url: 'https://github.com/acme/app/issues/20', state: 'closed' }] })).status, 'DONE');
    });
    it('when the validation E2E failed then a human approval does not complete the PBI', () => {
      const result = judgePbi(done({ results: { ...done().results, 'SBI-003': { ...validated, e2e: { status: 'FAIL', api: 'real' } } } }));
      assert.equal(result.status, 'NOT_DONE');
      assert.equal(result.acceptance, 'PENDING');
    });
    it('when an implementation SBI is not merged then a human approval does not complete the PBI', () => {
      const result = judgePbi(done({ results: { ...done().results, 'SBI-002': { ...implemented, merged: false } } }));
      assert.equal(result.status, 'NOT_DONE');
      assert.equal(result.acceptance, 'PENDING');
    });
  });
  describe('given a PBI without a validation SBI because no Integration / E2E is needed', () => {
    it('when every implementation SBI is done and the PBI Human Acceptance Gate is approved for the implementation evidence then the PBI is DONE', () => {
      assert.deepEqual(judgePbi(implementationsOnly()), { status: 'DONE', sbis: { 'SBI-001': 'DONE', 'SBI-002': 'DONE' }, acceptance: 'APPROVED', reasons: [] });
    });
    it('when the adapter supplied no evidence digest then the PBI is not DONE because the approval cannot be bound to evidence', () => {
      const result = judgePbi(implementationsOnly({ evidenceDigest: undefined }));
      assert.equal(result.status, 'NOT_DONE');
      assert.ok(result.reasons.some(r => /Evidence digest/.test(r)), JSON.stringify(result.reasons));
    });
    it('when the approval is for older implementation evidence then the PBI is not DONE', () => {
      const result = judgePbi(implementationsOnly({ evidenceDigest: 'c'.repeat(64) }));
      assert.equal(result.status, 'NOT_DONE');
      assert.equal(result.acceptance, 'PENDING');
    });
    it('when no human approved then the PBI is not DONE even though every implementation SBI is done', () => {
      assert.equal(judgePbi(implementationsOnly({ acceptanceRecords: [] })).status, 'NOT_DONE');
    });
  });
  describe('given the start condition of each kind', () => {
    it('when an implementation SBI is not done then the validation SBI cannot start', () => {
      const result = canStart(done({ results: { 'SBI-001': implemented } }), 'SBI-003');
      assert.equal(result.allowed, false);
      assert.ok(result.reasons.some(r => /SBI-002/.test(r)));
    });
    it('when an implementation SBI is not declared as a dependency then the validation SBI still waits for it', () => {
      const plan = done({ sbis: sbis.map(s => s.id === 'SBI-003' ? { ...s, dependsOn: ['SBI-001'] } : s), results: { 'SBI-001': implemented } });
      assert.equal(canStart(plan, 'SBI-003').allowed, false);
    });
    it('when every implementation SBI is done then the validation SBI can start', () => {
      assert.deepEqual(canStart(done({ results: { 'SBI-001': implemented, 'SBI-002': implemented } }), 'SBI-003'), { allowed: true, reasons: [] });
    });
    it('when the dependency of an implementation SBI is not done then it cannot start', () => {
      assert.equal(canStart(done({ results: {} }), 'SBI-002').allowed, false);
    });
  });
});

describe('Completion Judge for an SBI', () => {
  const passing = {
    verification: { status: 'PASS', acceptance: ['AC-1'], checks: [{ id: 'v', status: 'PASS', trust: 'acceptance', required: true }] },
    review: { status: 'PASS' }, security: { status: 'PASS' }, gateApproved: true,
    securityVerification: { status: 'PASS', violations: [], requiredVerifiers: ['secret'], checks: [{ id: 'secret', required: true, status: 'PASS' }] },
  };
  const criteria = [{ id: 'AC-1', verifier: 'v' }];
  for (const kind of ['implementation', 'validation']) {
    it(`when every check of a ${kind} SBI passes then the Completion Judge accepts it without waiting for the PBI Human Acceptance Gate`, () => {
      assert.equal(judge(passing, { kind, acceptanceCriteria: criteria }), true);
    });
  }
});
