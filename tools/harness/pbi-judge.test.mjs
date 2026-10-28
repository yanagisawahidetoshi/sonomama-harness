import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sbiSchema, plannedSbiSchema } from './schemas.mjs';
import { canStart, judgePbi, e2eApi } from './pbi-judge.mjs';
import { judge } from './completion-judge.mjs';
import { fixture, update, runFixture as runHarness } from './test-fixture.mjs';

const pbiUrl = 'https://github.com/acme/app/issues/8';
const evidenceDigest = 'a'.repeat(64);
const sbis = [
  { id: 'SBI-001', kind: 'implementation', dependsOn: [] },
  { id: 'SBI-002', kind: 'implementation', dependsOn: ['SBI-001'] },
  { id: 'SBI-003', kind: 'validation', dependsOn: ['SBI-001', 'SBI-002'] },
  { id: 'SBI-004', kind: 'acceptance', dependsOn: ['SBI-003'] },
];
const implemented = { merged: true, requiredVerifiers: 'PASS', e2e: { status: 'PASS', api: 'mock' } };
const validated = { e2e: { status: 'PASS', api: 'real' }, evidenceDigest };
const approval = (overrides = {}) => ({
  id: 'rec-1', purpose: 'pbi-acceptance', pbiUrl, sbiId: 'SBI-004', reviewer: 'os:501:reviewer', kind: 'human', identitySource: 'local-os-user',
  decision: 'APPROVE', decidedAt: '2026-10-28T00:00:00.000Z', validationDigest: evidenceDigest, signature: 's'.repeat(64), ...overrides,
});
const done = (overrides = {}) => ({
  pbiUrl, sbis,
  results: { 'SBI-001': implemented, 'SBI-002': { ...implemented, e2e: null }, 'SBI-003': validated },
  acceptanceRecords: [approval()], blockingBugs: [], ...overrides,
});

describe('SBI kind', () => {
  describe('given an SBI JSON for the Execution Harness', () => {
    it('when the kind is omitted then it is an implementation SBI so existing SBI JSON keeps working', async () => {
      const sample = JSON.parse(await readFile(new URL('../../.harness/state/sample-sbi.json', import.meta.url), 'utf8'));
      assert.equal(sbiSchema.parse(sample).kind, 'implementation');
    });
    for (const kind of ['implementation', 'validation', 'acceptance']) {
      it(`when the kind is ${kind} then it is accepted`, async () => {
        const sample = JSON.parse(await readFile(new URL('../../.harness/state/sample-sbi.json', import.meta.url), 'utf8'));
        assert.equal(sbiSchema.parse({ ...sample, kind }).kind, kind);
      });
    }
    it('when the kind is unknown then it is rejected', async () => {
      const sample = JSON.parse(await readFile(new URL('../../.harness/state/sample-sbi.json', import.meta.url), 'utf8'));
      assert.equal(sbiSchema.safeParse({ ...sample, kind: 'release' }).success, false);
    });
  });
  describe('given an SBI candidate from the Planner provider', () => {
    it('when the candidate has no kind then it is rejected so every generated SBI states its kind', () => {
      const candidate = { id: 'SBI-001', title: 't', purpose: 'p', scope: { included: ['x'], excluded: [] }, acceptanceCriteria: [], scenarios: [], dependsOn: [], changeAreas: [], layers: [], estimatedFiles: 0, oversizeReason: null, riskCandidate: 'L2', securityImpact: [], verification: { applicationTest: 'a', acceptance: 'b', e2e: 'c' } };
      assert.equal(plannedSbiSchema.safeParse(candidate).success, false);
      assert.equal(plannedSbiSchema.safeParse({ ...candidate, kind: 'validation' }).success, true);
    });
  });
  describe('given the kind of an SBI', () => {
    it('when choosing the API for Maestro E2E then implementation uses the mock, validation the real API and acceptance none', () => {
      assert.deepEqual(['implementation', 'validation', 'acceptance'].map(e2eApi), ['mock', 'real', null]);
    });
  });
});

describe('PBI Completion Judge', () => {
  describe('given a PBI with implementation, validation and acceptance SBIs', () => {
    it('when every implementation SBI is done, validation passed against the real API, a human accepted and no bug blocks then the PBI is DONE', () => {
      assert.deepEqual(judgePbi(done()), { status: 'DONE', sbis: { 'SBI-001': 'DONE', 'SBI-002': 'DONE', 'SBI-003': 'DONE', 'SBI-004': 'DONE' }, reasons: [] });
    });
    const notDone = [
      ['an implementation SBI is not merged', { results: { ...done().results, 'SBI-002': { ...implemented, merged: false } } }, /SBI-002/],
      ['a required verifier of an implementation SBI failed', { results: { ...done().results, 'SBI-001': { ...implemented, requiredVerifiers: 'FAIL' } } }, /SBI-001/],
      ['the mock Maestro E2E of an implementation SBI failed', { results: { ...done().results, 'SBI-001': { ...implemented, e2e: { status: 'FAIL', api: 'mock' } } } }, /SBI-001.*E2E/],
      ['the Maestro E2E of an implementation SBI ran against the real API', { results: { ...done().results, 'SBI-001': { ...implemented, e2e: { status: 'PASS', api: 'real' } } } }, /SBI-001.*モック/],
      ['the validation E2E failed', { results: { ...done().results, 'SBI-003': { ...validated, e2e: { status: 'FAIL', api: 'real' } } } }, /SBI-003.*E2E/],
      ['the validation E2E ran against the mock', { results: { ...done().results, 'SBI-003': { ...validated, e2e: { status: 'PASS', api: 'mock' } } } }, /SBI-003.*実API/],
      ['the validation has no result yet', { results: { 'SBI-001': implemented, 'SBI-002': implemented } }, /SBI-003/],
      ['no human approved the acceptance SBI', { acceptanceRecords: [] }, /SBI-004.*承認/],
      ['the only approval was revoked', { acceptanceRecords: [approval(), approval({ id: 'rec-2', decision: 'REVOKE', decidedAt: '2026-10-28T01:00:00.000Z' })] }, /SBI-004.*承認/],
      ['the approval is for a different validation evidence', { acceptanceRecords: [approval({ validationDigest: 'b'.repeat(64) })] }, /SBI-004.*承認/],
      ['the approval is for another PBI', { acceptanceRecords: [approval({ pbiUrl: 'https://github.com/acme/app/issues/9' })] }, /SBI-004.*承認/],
      ['the approval is an agent JSON without a human identity', { acceptanceRecords: [approval({ kind: 'ai' })] }, /SBI-004.*承認/],
      ['the approval comes from the merge approval purpose', { acceptanceRecords: [approval({ purpose: 'merge' })] }, /SBI-004.*承認/],
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
      assert.equal(result.sbis['SBI-004'], 'PENDING');
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
    it('when the validation SBI has not passed then the acceptance SBI cannot start', () => {
      assert.equal(canStart(done({ results: { 'SBI-001': implemented, 'SBI-002': implemented, 'SBI-003': { ...validated, e2e: { status: 'FAIL', api: 'real' } } } }), 'SBI-004').allowed, false);
    });
    it('when the validation SBI passed then the acceptance SBI can start', () => {
      assert.equal(canStart(done(), 'SBI-004').allowed, true);
    });
  });
});

describe('Acceptance SBI and the Execution Harness', () => {
  const passing = {
    verification: { status: 'PASS', acceptance: ['AC-1'], checks: [{ id: 'v', status: 'PASS', trust: 'acceptance', required: true }] },
    review: { status: 'PASS' }, security: { status: 'PASS' }, gateApproved: true,
    securityVerification: { status: 'PASS', violations: [], requiredVerifiers: ['secret'], checks: [{ id: 'secret', required: true, status: 'PASS' }] },
  };
  const criteria = [{ id: 'AC-1', verifier: 'v' }];
  it('when every check of an implementation SBI passes then the Completion Judge accepts it', () => {
    assert.equal(judge(passing, { kind: 'implementation', acceptanceCriteria: criteria }), true);
  });
  it('when every check of an acceptance SBI passes then the Completion Judge still refuses it because only a human completes it', () => {
    assert.equal(judge(passing, { kind: 'acceptance', acceptanceCriteria: criteria }), false);
  });
  it('when the Execution Harness is asked to run an acceptance SBI then it refuses before creating a run', () => fixture(async root => {
    await update(root, '.harness/state/sample-sbi.json', sbi => { sbi.kind = 'acceptance'; });
    await assert.rejects(runHarness({ root, quiet: true }), /人間確認SBI/);
    assert.deepEqual((await readdir(join(root, '.harness/runs'))).filter(name => name !== '.gitkeep'), []);
  }));
});
