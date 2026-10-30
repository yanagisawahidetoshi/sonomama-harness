import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSbiBody } from './planner.mjs';
import { loadSbiIssue } from './sbi-issue.mjs';
import { specDigest, specApprovals, specApprovalLine, postSpecApproval } from './spec-approval.mjs';

const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
const pbi = { owner: 'acme', repo: 'app', number: 3, url: 'https://github.com/acme/app/issues/3', title: '講座' };
const planned = (overrides = {}) => ({
  id: 'SBI-001', kind: 'implementation', title: '担当講師だけが講座を閲覧できる', purpose: '担当講師は自分の講座を閲覧でき、担当外の講師は拒否される。',
  scope: { included: ['apps/api 講座の閲覧'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: '担当講師は閲覧できる' }, { id: 'AC-2', description: '担当外の講師は403になる' }],
  scenarios: [{ name: '担当講師が閲覧する', given: ['担当講師である'], when: ['講座を開く'], then: ['200になる'], acceptanceIds: ['AC-1', 'AC-2'], test: 'RSpec: apps/api/spec/acceptance/courses_spec.rb' }],
  dependsOn: [], changeAreas: ['apps/api'], layers: ['Rails Controller'], estimatedFiles: 3, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'RSpec', acceptance: 'Trusted Acceptance（生成）', e2e: '不要' }, ...overrides,
});
const labels = (...names) => names.map(name => ({ name }));
const body = (overrides = {}) => renderSbiBody(planned(overrides), pbi);
const issue = (overrides = {}) => ({ number: 7, title: 'SBI-001 担当講師だけが講座を閲覧できる', body: body(), html_url: ref.url, state: 'open', labels: labels('sbi'), ...overrides });
const at = '2026-10-30T00:00:00Z';
const comment = (id, login, text, overrides = {}) => ({ id, body: text, html_url: `${ref.url}#issuecomment-${id}`, user: { login, type: 'User' }, created_at: at, updated_at: at, ...overrides });
const permissions = { alice: 'admin', bob: 'write', carol: 'read', 'planner[bot]': 'write' };

describe('Spec digest of an SBI Issue', () => {
  it('when the Issue is unchanged then the digest is the same', () => assert.equal(specDigest(body()), specDigest(body())));
  for (const [name, overrides] of [
    ['an acceptance criterion', { acceptanceCriteria: [{ id: 'AC-1', description: '担当講師は閲覧できる' }, { id: 'AC-2', description: '担当外の講師は404になる' }] }],
    ['a Gherkin step', { scenarios: [{ ...planned().scenarios[0], then: ['201になる'] }] }],
    ['the change scope', { changeAreas: ['apps/api', 'apps/admin'] }],
    ['the security impact', { securityImpact: ['AuthZ'] }],
  ]) {
    it(`when ${name} changes then the digest changes, so an earlier approval no longer matches`, () => assert.notEqual(specDigest(body(overrides)), specDigest(body())));
  }
  it('when only a checkbox is ticked or line endings change then the digest stays, since the specification did not change', () => {
    const ticked = body().replace('- [ ] AC-1:', '- [x] AC-1:').replaceAll('\n', '\r\n');
    assert.equal(specDigest(ticked), specDigest(body()));
  });
  it('when the Issue has no Gherkin section then it has no digest', () => assert.equal(specDigest('## 目的\n\nなし\n'), null));
});

describe('Spec approval records on the SBI Issue', () => {
  const digest = specDigest(body());
  const approvals = comments => specApprovals({ comments, permissions, digest });
  it('when a person with write access posts the approval line for the current digest then the spec is approved', () => {
    assert.deepEqual(approvals([comment(1, 'alice', `仕様を確認しました\n${specApprovalLine(digest)}\n`)]), { approved: true, approvers: ['alice'] });
  });
  it('when the planner operator approves the Issue the Planner created then it counts, since the Issue author is not the reviewer of code', () => {
    assert.equal(approvals([comment(1, 'alice', specApprovalLine(digest))]).approved, true);
  });
  for (const [name, comments] of [
    ['no one approved', []],
    ['the approval names another digest', [comment(1, 'alice', specApprovalLine('e'.repeat(64)))]],
    ['the approval comment was edited afterwards', [comment(1, 'alice', specApprovalLine(digest), { updated_at: '2026-10-30T01:00:00Z' })]],
    ['the approver is a bot', [comment(1, 'planner[bot]', specApprovalLine(digest), { user: { login: 'planner[bot]', type: 'Bot' } })]],
    ['the approver has only read access', [comment(1, 'carol', specApprovalLine(digest))]],
    ['the approver has no readable permission', [comment(1, 'dave', specApprovalLine(digest))]],
    ['the approver revoked it later', [comment(1, 'alice', specApprovalLine(digest)), comment(2, 'alice', `harness-spec-revoke: ${digest}`)]],
    ['only a label says spec-approved', []],
  ]) {
    it(`when ${name} then the spec is not approved`, () => assert.equal(approvals(comments).approved, false));
  }
  it('when the approver revoked and approved again then the latest approval counts', () => {
    assert.equal(approvals([comment(1, 'alice', specApprovalLine(digest)), comment(2, 'alice', `harness-spec-revoke: ${digest}`), comment(3, 'alice', specApprovalLine(digest))]).approved, true);
  });
});

describe('Starting a run from a spec-approved SBI Issue', () => {
  const config = { verifiers: [] };
  const github = ({ own = issue(), comments = [] } = {}) => ({
    fetchIssue: async () => own,
    listComments: async () => comments,
    permission: async (_, login) => { if (!(login in permissions)) throw new Error('gh: Not Found (HTTP 404)'); return permissions[login]; },
    issueTimeline: async () => [],
  });
  const load = gh => loadSbiIssue({ issueUrl: ref.url, config, github: gh });
  it('when the spec is approved for the current digest but no Trusted Acceptance is registered then the run stops and says generation is not available yet', async () => {
    await assert.rejects(load(github({ comments: [comment(1, 'alice', specApprovalLine(specDigest(body())))] })), /仕様は承認済み[\s\S]*生成/);
  });
  it('when neither ready nor a spec approval exists then the run does not start and names both ways to start', async () => {
    await assert.rejects(load(github()), /readyではありません[\s\S]*harness-spec/);
  });
  it('when the spec was approved and then the Gherkin changed then the old approval does not start the run', async () => {
    const edited = issue({ body: body({ scenarios: [{ ...planned().scenarios[0], then: ['201になる'] }] }) });
    await assert.rejects(load(github({ own: edited, comments: [comment(1, 'alice', specApprovalLine(specDigest(body())))] })), /readyではありません/);
  });
  it('when the Issue still needs review then even an approval does not start the run', async () => {
    const reviewing = issue({ labels: labels('sbi', 'needs-review') });
    await assert.rejects(load(github({ own: reviewing, comments: [comment(1, 'alice', specApprovalLine(specDigest(body())))] })), /needs-review/);
  });
  it('when GitHub cannot read the comments then the run does not start', async () => {
    const broken = { ...github(), listComments: async () => { throw new Error('gh: Server Error (HTTP 502)'); } };
    await assert.rejects(load(broken), /HTTP 502/);
  });
});

describe('harness:spec-approve', () => {
  const recorder = (own = issue()) => {
    const calls = [];
    return { calls, github: {
      fetchIssue: async () => own,
      addComment: async (_, text) => { calls.push(['comment', text]); return { id: 9, body: text, html_url: `${ref.url}#issuecomment-9` }; },
      ensureLabels: async (_, names) => { calls.push(['ensure', names]); },
      addLabels: async (_, names) => { calls.push(['add', names]); },
      removeLabel: async (_, name) => { calls.push(['remove', name]); },
    } };
  };
  it('when a human approves then posts the approval line for the current spec digest and shows the spec-approved label', async () => {
    const { calls, github } = recorder();
    const result = await postSpecApproval({ issueUrl: ref.url, decision: 'approve', github });
    assert.equal(result.digest, specDigest(body()));
    assert.ok(calls.some(([kind, text]) => kind === 'comment' && text.split('\n').includes(specApprovalLine(result.digest))));
    assert.ok(calls.some(([kind, names]) => kind === 'add' && names.includes('spec-approved')));
  });
  it('when a human revokes then posts the revoke line and removes the label', async () => {
    const { calls, github } = recorder(issue({ labels: labels('sbi', 'spec-approved') }));
    const result = await postSpecApproval({ issueUrl: ref.url, decision: 'revoke', github });
    assert.ok(calls.some(([kind, text]) => kind === 'comment' && text.split('\n').includes(`harness-spec-revoke: ${result.digest}`)));
    assert.ok(calls.some(([kind, name]) => kind === 'remove' && name === 'spec-approved'));
  });
  it('when the Issue has no Gherkin then nothing is posted', async () => {
    const { calls, github } = recorder(issue({ body: '## 目的\n\nなし\n' }));
    await assert.rejects(postSpecApproval({ issueUrl: ref.url, decision: 'approve', github }), /spec digest/);
    assert.deepEqual(calls, []);
  });
});
