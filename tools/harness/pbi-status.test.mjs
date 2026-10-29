import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { renderSbiBody } from './planner.mjs';
import { githubCli } from './planner-github.mjs';
import { githubMock } from './test-github.mjs';
import { execute } from './io.mjs';
import { collectPbiStatus, renderPbiStatus, acceptPbi, maestroEvidenceNotConnected } from './pbi-status.mjs';
import { pbiAcceptanceRecords } from './pbi-acceptance.mjs';

const pbi = { owner: 'acme', repo: 'app', number: 8, url: 'https://github.com/acme/app/issues/8', title: '受講生ログイン' };
const issueUrl = number => `https://github.com/acme/app/issues/${number}`;
const sha = char => char.repeat(40);
const validationDigest = 'b'.repeat(64);
const planned = (overrides = {}) => ({
  id: 'SBI-001', kind: 'implementation', title: 'ログイン画面', purpose: '受講生がログインできる。',
  scope: { included: ['apps/mobile ログイン画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: 'ログインできる' }],
  scenarios: [{ name: 'ログイン', given: ['受講生が登録済み'], when: ['ログインする'], then: ['ホームが表示される'], acceptanceIds: ['AC-1'], test: 'Jest: apps/mobile/src/features/login/index.test.tsx' }],
  dependsOn: [], changeAreas: ['apps/mobile'], layers: ['画面Component'], estimatedFiles: 2, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'Jest', acceptance: 'Trusted Acceptance', e2e: 'Maestro（モックAPI）' },
  ...overrides,
});
const plannedSbis = [
  planned(),
  planned({ id: 'SBI-002', title: 'ログイン失敗の表示', dependsOn: ['SBI-001'] }),
  planned({ id: 'SBI-003', kind: 'validation', title: '実APIでログインを確認する', dependsOn: ['SBI-001', 'SBI-002'], layers: [], verification: { applicationTest: 'なし', acceptance: 'Trusted Acceptance', e2e: 'Maestro（実API + Rails + DB）' } }),
];
const numbers = { 'SBI-001': 11, 'SBI-002': 12, 'SBI-003': 13 };
const sbiIssue = (sbi, overrides = {}) => ({
  number: numbers[sbi.id], title: `${sbi.id} ${sbi.title}`, body: renderSbiBody(sbi, pbi, numbers), html_url: issueUrl(numbers[sbi.id]),
  state: 'open', labels: [{ name: 'sbi' }, { name: 'ready' }], ...overrides,
});
// A Harness PR that merged into main: Closes #N in the body and the SBI-Issue trailer on a commit.
const mergedPull = (issue, number, head, overrides = {}) => ({
  number, merged_at: '2026-10-28T00:00:00Z', base: { ref: 'main' }, body: `Closes #${issue}`, head: { sha: head, repo: { full_name: 'acme/app' } },
  merge_commit_sha: sha(String(number % 10)), user: { login: 'harness-operator', type: 'User' }, ...overrides,
});
const passing = [{ id: 1, name: 'harness', status: 'completed', conclusion: 'success' }];

function world(overrides = {}) {
  const state = {
    pbi: { number: 8, title: pbi.title, body: 'PBI', html_url: pbi.url, state: 'open', labels: [] },
    issues: plannedSbis.map(s => sbiIssue(s)),
    pulls: { 21: mergedPull(11, 21, sha('1')), 22: mergedPull(12, 22, sha('2')) },
    timeline: { 11: [21], 12: [22], 13: [] },
    commits: { 21: ['feat: login\n\nSBI-Issue: https://github.com/acme/app/issues/11'], 22: ['feat: error\n\nSBI-Issue: https://github.com/acme/app/issues/12'] },
    checkRuns: { [sha('1')]: passing, [sha('2')]: passing },
    rulesetChecks: [],
    blockedBy: [],
    fail: {},
    ...overrides,
  };
  const guard = name => { if (state.fail[name]) throw new Error(`gh api GET ${name}: HTTP 502`); };
  const github = {
    async fetchIssue(ref) { guard('issue'); if (ref.number !== 8) throw new Error('HTTP 404'); return state.pbi; },
    async listIssues(_ref, label) { guard('list'); return state.issues.filter(i => i.labels.some(l => l.name === label)); },
    async issueTimeline(ref) { guard('timeline'); return (state.timeline[ref.number] ?? []).map(n => ({ event: 'cross-referenced', source: { issue: { number: n, html_url: `https://github.com/acme/app/pull/${n}`, pull_request: {} } } })); },
    async fetchPull(_ref, number) { guard('pull'); return state.pulls[number]; },
    async pullCommitMessages(_ref, number) { guard('commits'); return state.commits[number] ?? []; },
    async blockedBy() { guard('blockedBy'); return state.blockedBy; },
  };
  const githubPr = {
    async checkRuns(_repo, head) { guard('checkRuns'); return state.checkRuns[head] ?? []; },
    async rulesetChecks() { guard('rules'); return state.rulesetChecks; },
  };
  return { state, github, githubPr };
}
// What #68's Maestro Evidence will provide once connected: the mock lane for implementation SBIs, the real lane plus a digest for the validation SBI.
const connected = (byId = {}) => ({
  async read({ sbi }) {
    if (byId[sbi.id]) return byId[sbi.id];
    return sbi.kind === 'validation' ? { connected: true, e2e: { status: 'PASS', api: 'real' }, evidenceDigest: validationDigest } : { connected: true, e2e: { status: 'PASS', api: 'mock' } };
  },
});
const approval = (overrides = {}) => ({
  id: 'rec-1', purpose: 'pbi-acceptance', pbiUrl: pbi.url, reviewer: 'os:501:reviewer', kind: 'human', identitySource: 'local-os-user',
  decision: 'APPROVE', decidedAt: '2026-10-28T00:00:00.000Z', evidenceDigest: validationDigest, signature: 's'.repeat(64), ...overrides,
});
const config = { github: { remote: 'origin', base: 'main', requiredChecks: ['harness'] } };
async function status({ state: stateOverrides, evidence = connected(), records = [approval()], options = {} } = {}) {
  const { github, githubPr } = world(stateOverrides);
  return collectPbiStatus({ root: '/nonexistent', pbiUrl: pbi.url, config, github, githubPr, evidence, acceptanceRecords: async () => records, ...options });
}
const implementationOnlyIssues = plannedSbis.slice(0, 2).map(s => sbiIssue(s));

describe('PBI Status: collecting the PBI from GitHub', () => {
  describe('given a PBI whose SBIs merged, passed every required check and E2E, with an approved Human Acceptance and no open blocker', () => {
    it('when the status is collected then the PBI is DONE and every SBI is listed with its kind, Issue, PR and results', async () => {
      const result = await status();
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
      assert.deepEqual(result.reasons, []);
      assert.deepEqual(result.pbi, { url: pbi.url, number: 8, title: pbi.title });
      assert.deepEqual(result.sbis.map(s => [s.id, s.kind, s.issueUrl, s.status]), [
        ['SBI-001', 'implementation', issueUrl(11), 'DONE'], ['SBI-002', 'implementation', issueUrl(12), 'DONE'], ['SBI-003', 'validation', issueUrl(13), 'DONE'],
      ]);
      assert.deepEqual(result.sbis[0].pullRequest, { number: 21, url: 'https://github.com/acme/app/pull/21', headSha: sha('1') });
      assert.equal(result.sbis[0].merged, true);
      assert.equal(result.sbis[0].requiredVerifiers, 'PASS');
      assert.deepEqual(result.sbis[0].e2e, { status: 'PASS', api: 'mock' });
      assert.deepEqual(result.sbis[2].dependsOn, ['SBI-001', 'SBI-002']);
      assert.equal(result.acceptance, 'APPROVED');
      assert.equal(result.evidenceDigest, validationDigest);
      assert.deepEqual(result.blockers, []);
    });
    it('when the Issues of another PBI or Issues without the Planner marker carry the sbi label then they are not SBIs of this PBI', async () => {
      const other = sbiIssue(planned({ id: 'SBI-001' }), { number: 30, html_url: issueUrl(30), body: renderSbiBody(planned(), { ...pbi, number: 9, url: issueUrl(9) }, {}) });
      const handwritten = { number: 31, title: 'SBI-004 手書き', body: '## 目的\n\n手書き', html_url: issueUrl(31), state: 'open', labels: [{ name: 'sbi' }] };
      const result = await status({ state: { issues: [...plannedSbis.map(s => sbiIssue(s)), other, handwritten] } });
      assert.deepEqual(result.sbis.map(s => s.issueUrl), [issueUrl(11), issueUrl(12), issueUrl(13)]);
      assert.equal(result.status, 'DONE');
    });
  });

  describe('given implementation SBIs whose merge GitHub does not confirm', () => {
    for (const [name, change] of [
      ['the PR is still open', s => { s.pulls[22].merged_at = null; }],
      ['the PR merged into another branch', s => { s.pulls[22].base.ref = 'develop'; }],
      ['the PR does not close the SBI Issue', s => { s.pulls[22].body = 'Refs #12'; }],
      ['no commit carries the SBI-Issue trailer, even if the PR body claims it is done', s => { s.commits[22] = ['feat: error']; s.pulls[22].body = 'Closes #12\n\nstatus: DONE\nSBI-Issue: https://github.com/acme/app/issues/12'; }],
      ['no PR references the SBI Issue, even though the Issue was closed by hand', s => { s.timeline[12] = []; s.issues[1].state = 'closed'; }],
    ]) {
      it(`when ${name} then the SBI is not merged and the PBI is NOT_DONE`, async () => {
        const { state } = world();
        change(state);
        const result = await status({ state });
        assert.equal(result.status, 'NOT_DONE');
        assert.equal(result.sbis[1].merged, false);
        assert.notEqual(result.sbis[1].status, 'DONE');
        assert.match(result.reasons.join('\n'), /SBI-002/);
      });
    }
  });

  describe('given required checks on the merged head of an implementation SBI', () => {
    for (const [name, change, pattern] of [
      ['the harness check failed', s => { s.checkRuns[sha('2')] = [{ id: 2, name: 'harness', status: 'completed', conclusion: 'failure' }]; }, /SBI-002.*必須Verifier.*FAIL/],
      ['the harness check was skipped', s => { s.checkRuns[sha('2')] = [{ id: 2, name: 'harness', status: 'completed', conclusion: 'skipped' }]; }, /SBI-002.*必須Verifier.*FAIL/],
      ['the harness check never ran', s => { s.checkRuns[sha('2')] = []; }, /SBI-002.*必須Verifier.*FAIL/],
      ['a ruleset check is missing', s => { s.rulesetChecks = [{ context: 'e2e', integrationId: null }]; }, /SBI-00[12].*必須Verifier.*FAIL/],
    ]) {
      it(`when ${name} then the PBI is NOT_DONE`, async () => {
        const { state } = world();
        change(state);
        const result = await status({ state });
        assert.equal(result.status, 'NOT_DONE');
        assert.match(result.reasons.join('\n'), pattern);
      });
    }
    it('when no required check is configured anywhere then the verifiers are NOT_CONFIGURED and the PBI is NOT_DONE', async () => {
      const result = await status({ options: { config: { github: { remote: 'origin', base: 'main', requiredChecks: [] } } } });
      assert.equal(result.status, 'NOT_DONE');
      assert.equal(result.sbis[0].requiredVerifiers, 'NOT_CONFIGURED');
    });
  });

  describe('given the SBIs of the PBI', () => {
    it('when the PBI has no SBI Issue then it is NOT_DONE', async () => {
      const result = await status({ state: { issues: [] } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI/);
    });
    it('when two open SBI Issues claim the same SBI ID then the PBI is NOT_DONE instead of choosing one', async () => {
      const copy = sbiIssue(plannedSbis[0], { number: 14, html_url: issueUrl(14) });
      const result = await status({ state: { issues: [...plannedSbis.map(s => sbiIssue(s)), copy] } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI-001.*#11.*#14|SBI-001.*#14.*#11/);
    });
  });
});

describe('PBI Status: Maestro E2E Evidence', () => {
  describe('given the evidence of each SBI', () => {
    it('when an implementation SBI ran its E2E against the real API then only mock results count and the PBI is NOT_DONE', async () => {
      const result = await status({ evidence: connected({ 'SBI-001': { connected: true, e2e: { status: 'PASS', api: 'real' } } }) });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI-001.*モック以外/);
    });
    it('when the validation SBI ran its E2E against the mock API then only real API + Rails + DB results count and the PBI is NOT_DONE', async () => {
      const result = await status({ evidence: connected({ 'SBI-003': { connected: true, e2e: { status: 'PASS', api: 'mock' }, evidenceDigest: validationDigest } }) });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /SBI-003.*実API以外/);
    });
    it('when the validation E2E failed then the PBI is NOT_DONE', async () => {
      const result = await status({ evidence: connected({ 'SBI-003': { connected: true, e2e: { status: 'FAIL', api: 'real' }, evidenceDigest: validationDigest } }) });
      assert.equal(result.status, 'NOT_DONE');
    });
    it('when an implementation SBI has no E2E target then it needs no E2E result', async () => {
      const result = await status({ evidence: connected({ 'SBI-002': { connected: true, e2e: null } }) });
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
    });
  });

  describe('given the Maestro Evidence adapter of this repository before #142 is merged', () => {
    it('when the status is collected then every SBI is NOT_DONE for missing evidence instead of treating it as no E2E target', async () => {
      const result = await status({ evidence: maestroEvidenceNotConnected });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /Maestro E2E Evidence.*未接続/);
      for (const sbi of result.sbis) assert.equal(sbi.e2e, null);
      assert.equal(result.ready, false);
    });
    it('when no evidence adapter is given then the not-connected adapter is used', async () => {
      const { github, githubPr } = world();
      const result = await collectPbiStatus({ root: '/nonexistent', pbiUrl: pbi.url, config, github, githubPr, acceptanceRecords: async () => [approval()] });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /未接続/);
    });
  });
  describe('given an evidence adapter that fails', () => {
    it('when reading the evidence throws then the PBI is NOT_DONE with the reason', async () => {
      const result = await status({ evidence: { async read() { throw new Error('artifact expired'); } } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /artifact expired/);
    });
  });
});

describe('PBI Status: Human Acceptance and the evidence digest', () => {
  describe('given a PBI with a validation SBI', () => {
    it('when nobody approved yet then the gate is PENDING, the PBI is ready for acceptance and the digest to approve is shown', async () => {
      const result = await status({ records: [] });
      assert.equal(result.status, 'NOT_DONE');
      assert.equal(result.acceptance, 'PENDING');
      assert.equal(result.ready, true);
      assert.equal(result.evidenceDigest, validationDigest);
    });
    for (const [name, records] of [
      ['the approval is for older evidence', [approval({ evidenceDigest: 'c'.repeat(64) })]],
      ['the approver revoked it', [approval(), approval({ id: 'rec-2', decision: 'REVOKE' })]],
      ['the approver requested changes', [approval(), approval({ id: 'rec-2', decision: 'REQUEST_CHANGES' })]],
      ['the record is an agent JSON without a human identity', [approval({ kind: 'ai' })]],
      ['the record is a merge approval', [approval({ purpose: 'merge' })]],
    ]) {
      it(`when ${name} then the PBI is NOT_DONE`, async () => {
        const result = await status({ records });
        assert.equal(result.status, 'NOT_DONE');
        assert.equal(result.acceptance, 'PENDING');
      });
    }
    it('when the acceptance ledger cannot be read then the PBI is NOT_DONE with the reason', async () => {
      const { github, githubPr } = world();
      const result = await collectPbiStatus({ root: '/nonexistent', pbiUrl: pbi.url, config, github, githubPr, evidence: connected(), acceptanceRecords: async () => { throw new Error('pbi-acceptance ledger signature invalid'); } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /signature invalid/);
    });
  });

  describe('given a PBI without a validation SBI', () => {
    const merged = [
      { sbi: 'SBI-001', issueUrl: issueUrl(11), pullRequest: 21, headSha: sha('1'), mergeCommitSha: sha('1'), e2e: { status: 'PASS', api: 'mock' } },
      { sbi: 'SBI-002', issueUrl: issueUrl(12), pullRequest: 22, headSha: sha('2'), mergeCommitSha: sha('2'), e2e: { status: 'PASS', api: 'mock' } },
    ];
    const expected = createHash('sha256').update(JSON.stringify(merged)).digest('hex');
    it('when every implementation SBI merged then the digest covers each SBI, its PR, the tested head, the merge commit and the E2E result', async () => {
      const result = await status({ state: { issues: implementationOnlyIssues }, records: [] });
      assert.equal(result.evidenceDigest, expected);
      assert.equal(result.ready, true);
    });
    it('when the human approved that digest then the PBI is DONE', async () => {
      const result = await status({ state: { issues: implementationOnlyIssues }, records: [approval({ evidenceDigest: expected })] });
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
    });
    it('when a merge commit differs from the approved evidence then the digest changes and the PBI is NOT_DONE', async () => {
      const { state } = world({ issues: implementationOnlyIssues });
      state.pulls[22].merge_commit_sha = sha('9');
      const result = await status({ state, records: [approval({ evidenceDigest: expected })] });
      assert.notEqual(result.evidenceDigest, expected);
      assert.equal(result.status, 'NOT_DONE');
    });
    it('when an implementation SBI is not merged then no digest is offered for approval', async () => {
      const { state } = world({ issues: implementationOnlyIssues });
      state.pulls[22].merged_at = null;
      const result = await status({ state, records: [] });
      assert.equal(result.evidenceDigest, null);
      assert.equal(result.ready, false);
    });
  });
});

describe('PBI Status: blockers', () => {
  describe('given Issues registered on GitHub as blocking the PBI (blocked by)', () => {
    it('when one is open then the PBI is NOT_DONE and names it', async () => {
      const result = await status({ state: { blockedBy: [{ number: 40, title: 'ログインできない', body: null, html_url: issueUrl(40), state: 'open', labels: [{ name: 'bug' }] }] } });
      assert.equal(result.status, 'NOT_DONE');
      assert.deepEqual(result.blockers, [{ url: issueUrl(40), title: 'ログインできない', state: 'open' }]);
      assert.match(result.reasons.join('\n'), /blocker.*issues\/40/);
      assert.equal(result.ready, false);
    });
    it('when every one is closed then it does not block the PBI', async () => {
      const result = await status({ state: { blockedBy: [{ number: 40, title: 'ログインできない', body: null, html_url: issueUrl(40), state: 'closed', labels: [{ name: 'bug' }] }] } });
      assert.equal(result.status, 'DONE', result.reasons.join('\n'));
    });
  });
});

describe('PBI Status: GitHub failures fail closed', () => {
  for (const name of ['issue', 'list', 'timeline', 'pull', 'commits', 'checkRuns', 'rules', 'blockedBy']) {
    it(`when reading ${name} from GitHub fails then the PBI is NOT_DONE with the reason instead of throwing`, async () => {
      const result = await status({ state: { fail: { [name]: true } } });
      assert.equal(result.status, 'NOT_DONE');
      assert.match(result.reasons.join('\n'), /HTTP 502/);
    });
  }
  it('when the PBI URL is a pull request then the PBI is NOT_DONE', async () => {
    const { state } = world();
    state.pbi.pull_request = { url: 'x' };
    const result = await status({ state });
    assert.equal(result.status, 'NOT_DONE');
    assert.match(result.reasons.join('\n'), /pull request/);
  });
  it('when the PBI URL is not a GitHub Issue URL then collecting is rejected', async () => {
    const { github, githubPr } = world();
    await assert.rejects(collectPbiStatus({ root: '/nonexistent', pbiUrl: 'https://example.com/8', config, github, githubPr }), /Issue URL/);
  });
});

describe('PBI Status: display', () => {
  describe('given a collected status', () => {
    it('when it is rendered then the PBI, its status, each SBI, Human Acceptance, blockers and the reasons are shown', async () => {
      const text = renderPbiStatus(await status({ records: [] })).join('\n');
      assert.match(text, /^PBI: #8 受講生ログイン$/m);
      assert.match(text, /^Status: NOT_DONE$/m);
      assert.match(text, /SBI-001 implementation .*#11.*merged.*verifier PASS.*E2E mock PASS/);
      assert.match(text, /SBI-003 validation .*#13.*E2E real PASS/);
      assert.match(text, /Human Acceptance\n.*PENDING/);
      assert.match(text, new RegExp(`Evidence digest: ${validationDigest}`));
      assert.match(text, new RegExp(`pnpm harness:pbi-accept ${pbi.url} --evidence ${validationDigest}`));
      assert.match(text, /Blockers\n.*none/);
      assert.doesNotMatch(text, /[Bb]ug/);
      assert.match(text, /Reason:\n- PBI Human Acceptance Gate/);
    });
    it('when the Maestro E2E Evidence is not connected then each SBI line says so instead of showing no E2E target', async () => {
      const text = renderPbiStatus(await status({ evidence: maestroEvidenceNotConnected })).join('\n');
      assert.match(text, /SBI-001 implementation .*E2E 未接続/);
      assert.match(text, /SBI-003 validation .*E2E 未接続/);
      assert.doesNotMatch(text, /E2E none/);
    });
    it('when the evidence of an SBI cannot be read then its line says it is unreadable', async () => {
      const text = renderPbiStatus(await status({ evidence: { async read() { throw new Error('artifact expired'); } } })).join('\n');
      assert.match(text, /SBI-001 implementation .*E2E unreadable/);
    });
    it('when the PBI is DONE then no reason is listed', async () => {
      const text = renderPbiStatus(await status()).join('\n');
      assert.match(text, /^Status: DONE$/m);
      assert.doesNotMatch(text, /Reason:/);
    });
  });
});

describe('PBI Acceptance from the trusted CLI', () => {
  const human = async () => ({ id: 'os:501:reviewer', kind: 'human', source: 'local-os-user' });
  async function withRoot(fn) {
    const root = await mkdtemp(join(tmpdir(), 'harness-pbi-accept-'));
    try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
  }
  const accept = (root, options = {}, stateOverrides) => {
    const { github, githubPr } = world(stateOverrides);
    return acceptPbi({ root, pbiUrl: pbi.url, evidenceDigest: validationDigest, decision: 'APPROVE', identityProvider: human, config, github, githubPr, evidence: connected(), ...options });
  };
  describe('given a PBI whose SBIs are all done', () => {
    it('when the human approves the shown evidence digest then the signed record makes the PBI DONE', () => withRoot(async root => {
      const result = await accept(root);
      assert.equal(result.record.decision, 'APPROVE');
      assert.equal(result.status.status, 'DONE', result.status.reasons.join('\n'));
      assert.equal((await pbiAcceptanceRecords(root, pbi.url)).length, 1);
    }));
    it('when the human approves a digest other than the current evidence then nothing is recorded', () => withRoot(async root => {
      await assert.rejects(accept(root, { evidenceDigest: 'c'.repeat(64) }), /Evidence digest/);
      assert.deepEqual(await pbiAcceptanceRecords(root, pbi.url), []);
    }));
    it('when the human revokes an approval then the PBI is NOT_DONE again', () => withRoot(async root => {
      await accept(root);
      const result = await accept(root, { decision: 'REVOKE' });
      assert.equal(result.record.decision, 'REVOKE');
      assert.equal(result.status.status, 'NOT_DONE');
    }));
  });
  describe('given a PBI that is not ready for acceptance', () => {
    it('when an SBI is not merged then APPROVE is not recorded', () => withRoot(async root => {
      const { state } = world();
      state.pulls[22].merged_at = null;
      await assert.rejects(accept(root, {}, state), /まだ受け入れ確認できません/);
      assert.deepEqual(await pbiAcceptanceRecords(root, pbi.url), []);
    }));
    it('when an Issue blocking the PBI (blocked by) is still open then APPROVE is not recorded even though every SBI is done', () => withRoot(async root => {
      await assert.rejects(accept(root, {}, { blockedBy: [{ number: 40, title: 'ログインできない', body: null, html_url: issueUrl(40), state: 'open', labels: [] }] }), /まだ受け入れ確認できません[\s\S]*issues\/40/);
      assert.deepEqual(await pbiAcceptanceRecords(root, pbi.url), []);
    }));
    it('when the blockers of the PBI cannot be read then APPROVE is not recorded', () => withRoot(async root => {
      await assert.rejects(accept(root, {}, { fail: { blockedBy: true } }), /まだ受け入れ確認できません/);
      assert.deepEqual(await pbiAcceptanceRecords(root, pbi.url), []);
    }));
    it('when every blocker is closed then APPROVE is recorded', () => withRoot(async root => {
      const result = await accept(root, {}, { blockedBy: [{ number: 40, title: 'ログインできない', body: null, html_url: issueUrl(40), state: 'closed', labels: [] }] });
      assert.equal(result.record.decision, 'APPROVE');
      assert.equal(result.status.status, 'DONE', result.status.reasons.join('\n'));
    }));
    it('when GitHub cannot be read then APPROVE is not recorded', () => withRoot(async root => {
      await assert.rejects(accept(root, {}, { fail: { list: true } }), /まだ受け入れ確認できません/);
      assert.deepEqual(await pbiAcceptanceRecords(root, pbi.url), []);
    }));
    for (const decision of ['REQUEST_CHANGES', 'REVOKE']) {
      it(`when the human records ${decision} then it is recorded so a withdrawal never waits for GitHub`, () => withRoot(async root => {
        const result = await accept(root, { decision }, { fail: { list: true } });
        assert.equal(result.record.decision, decision);
        assert.equal(result.status.status, 'NOT_DONE');
      }));
      it(`when the human records ${decision} while a blocker is open then it is recorded`, () => withRoot(async root => {
        const result = await accept(root, { decision }, { blockedBy: [{ number: 40, title: 'ログインできない', body: null, html_url: issueUrl(40), state: 'open', labels: [] }] });
        assert.equal(result.record.decision, decision);
      }));
    }
  });
});

describe('GitHub adapter for blocking Issues', () => {
  describe('given the gh CLI', () => {
    it('when the Issues blocking the PBI are read then the GitHub issue dependencies (blocked by) endpoint is used', () => githubMock({})({ blockedBy: { 8: [{ number: 40, title: 'bug', body: null, html_url: issueUrl(40), state: 'open', labels: [] }] } }, async github => {
      const issues = await githubCli.blockedBy(pbi);
      assert.deepEqual(issues.map(i => i.html_url), [issueUrl(40)]);
      assert.ok((await github.calls()).some(c => c.args[1].startsWith('repos/acme/app/issues/8/dependencies/blocked_by')));
    }));
  });
});

describe('PBI Status CLI', () => {
  const cli = new URL('./cli.mjs', import.meta.url).pathname;
  describe('given the commands offered to developers', () => {
    it('when the package scripts are read then harness:pbi-status and harness:pbi-accept exist', async () => {
      const { scripts } = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../package.json', import.meta.url), 'utf8'));
      assert.equal(scripts['harness:pbi-status'], 'node tools/harness/cli.mjs pbi-status');
      assert.equal(scripts['harness:pbi-accept'], 'node tools/harness/cli.mjs pbi-accept');
    });
    it('when the usage is printed then both are user-facing commands', async () => {
      const { stderr } = await execute(process.execPath, [cli, 'unknown']);
      const userFacing = stderr.indexOf('User-facing'), internal = stderr.indexOf('Internal/Maintenance');
      for (const command of ['harness:pbi-status PBI_URL', 'harness:pbi-accept PBI_URL']) {
        const at = stderr.indexOf(`pnpm ${command}`);
        assert.ok(at > userFacing && at < internal, `${command} is user-facing`);
      }
    });
    it('when pbi-accept has no --evidence then it exits 1 without recording', async () => {
      const result = await execute(process.execPath, [cli, 'pbi-accept', pbi.url, '--decision', 'approve']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /--evidence/);
    });
    it('when pbi-status has no PBI URL then it exits 1', async () => {
      const result = await execute(process.execPath, [cli, 'pbi-status', '--json']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /PBI URL/);
    });
  });
});
