import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSbiBody } from './planner.mjs';
import { loadSbiIssue } from './sbi-issue.mjs';
import { readFileSync } from 'node:fs';
import { specDigest, specApproval, postSpecApproval, specDigestItems } from './spec-approval.mjs';

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

describe('Spec digest of an SBI Issue', () => {
  // #194: everything the run gives the Agent or uses for Risk and Security is in the digest, so editing it voids earlier approvals.
  const digest = (overrides = {}, title = issue().title) => specDigest({ title, body: body(overrides) });
  it('when the Issue is unchanged then the digest is the same', () => assert.equal(digest(), digest()));
  for (const [name, overrides] of [
    ['an acceptance criterion', { acceptanceCriteria: [{ id: 'AC-1', description: '担当講師は閲覧できる' }, { id: 'AC-2', description: '担当外の講師は404になる' }] }],
    ['a Gherkin step', { scenarios: [{ ...planned().scenarios[0], then: ['201になる'] }] }],
    ['the change scope', { changeAreas: ['apps/api', 'apps/admin'] }],
    ['the security impact', { securityImpact: ['AuthZ'] }],
    ['the purpose the Agent is told to implement', { purpose: '講師は全ての講座を閲覧できる。' }],
    ['the kind', { kind: 'validation' }],
    ['the expected number of changed files', { estimatedFiles: 9 }],
    ['the verification method', { verification: { ...planned().verification, e2e: 'Maestro: 講座の閲覧' } }],
    ['the dependent SBIs the run waits for', { dependsOn: ['SBI-002'] }],
  ]) {
    it(`when ${name} changes then the digest changes, so an earlier approval no longer matches`, () => assert.notEqual(digest(overrides), digest()));
  }
  it('when the title changes then the digest changes, since the Agent and the Security classification read it', () => {
    assert.notEqual(digest({}, 'SBI-001 講師は全ての講座を閲覧できる'), digest());
  });
  it('when only a checkbox is ticked or line endings change then the digest stays, since the specification did not change', () => {
    const ticked = body().replace('- [ ] AC-1:', '- [x] AC-1:').replaceAll('\n', '\r\n');
    assert.equal(specDigest({ title: issue().title, body: ticked }), digest());
  });
  it('when the Issue has no Gherkin section then it has no digest', () => assert.equal(specDigest({ title: issue().title, body: '## 目的\n\nなし\n' }), null));
  it('when the Issue has no title then it has no digest', () => assert.equal(specDigest({ body: body() }), null));
  it('when the Planner marker points at another PBI then the digest changes, since the run records the PBI it implements', () => {
    assert.notEqual(specDigest({ title: issue().title, body: body().replace(pbi.url, 'https://github.com/acme/app/issues/4') }), digest());
  });
  it('when the dependency number of a dependent SBI changes then the digest changes', () => {
    const dependent = renderSbiBody(planned({ dependsOn: ['SBI-002'] }), pbi, { 'SBI-002': 12 });
    assert.notEqual(specDigest({ title: issue().title, body: dependent }), specDigest({ title: issue().title, body: dependent.replace('(#12)', '(#13)') }));
  });
  // ADR-0005 lists what the spec digest covers; the list and the implementation must not drift apart.
  it('when ADR-0005 is read then it lists exactly the items the spec digest covers', () => {
    const adr = readFileSync(new URL('../../docs/adr/0005-generated-trusted-acceptance.md', import.meta.url), 'utf8');
    const listed = /今は (.+?) を含む/.exec(adr)?.[1].split('・').map(s => s.trim());
    assert.deepEqual(listed, specDigestItems);
  });
});

// ADR-0009: the spec-approved label a human puts on the Issue is the spec approval (MVP). Who added it is not checked; the digest is the
// Issue as it is when the run reads it, and the generated Trusted Acceptance stays bound to that digest.
describe('Spec approval by the spec-approved label', () => {
  it('when the Issue carries spec-approved then the spec is approved for the current spec digest', () => {
    assert.deepEqual(specApproval(issue({ labels: labels('sbi', 'spec-approved') })), { approved: true, digest: specDigest(issue()) });
  });
  it('when the Issue has no spec-approved then the spec is not approved', () => {
    assert.deepEqual(specApproval(issue()), { approved: false, digest: specDigest(issue()) });
  });
  it('when the Issue carries spec-approved but has no Gherkin then the spec is not approved, since nothing can be generated from it', () => {
    assert.equal(specApproval(issue({ body: '## 目的\n\nなし\n', labels: labels('sbi', 'spec-approved') })).approved, false);
  });
});

describe('Starting a run from a spec-approved SBI Issue', () => {
  const config = { verifiers: [] };
  const github = (own = issue({ labels: labels('sbi', 'spec-approved') })) => ({ fetchIssue: async () => own, issueTimeline: async () => [] });
  const load = gh => loadSbiIssue({ issueUrl: ref.url, config, github: gh });
  // #147: the approved spec starts the run in the generate mode; Trusted Acceptance is generated inside the run.
  it('when the Issue carries spec-approved and no Trusted Acceptance is registered then the run starts in the generate mode', async () => {
    const loaded = await load(github());
    assert.equal(loaded.mode, 'generate');
    assert.equal(loaded.spec.digest, specDigest(issue()));
  });
  it('when neither ready nor spec-approved is on the Issue then the run does not start and names both labels', async () => {
    await assert.rejects(load(github(issue())), /readyではありません[\s\S]*spec-approved/);
  });
  it('when the Issue still has needs-review next to spec-approved then the run does not start', async () => {
    await assert.rejects(load(github(issue({ labels: labels('sbi', 'needs-review', 'spec-approved') }))), /needs-review/);
  });
  it('when only a harness-spec comment approves the spec then the run does not start, since the label is the approval', async () => {
    const commented = { ...github(issue()), listComments: async () => [comment(1, 'alice', `harness-spec: ${specDigest(issue())}`)], permission: async () => 'admin' };
    await assert.rejects(load(commented), /readyではありません/);
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
  it('when a human approves then the Issue moves from needs-review to spec-approved and no comment is posted', async () => {
    const { calls, github } = recorder(issue({ labels: labels('sbi', 'needs-review') }));
    const result = await postSpecApproval({ issueUrl: ref.url, decision: 'approve', github });
    assert.equal(result.digest, specDigest(issue()));
    assert.ok(calls.some(([kind, names]) => kind === 'add' && names.includes('spec-approved')));
    assert.ok(calls.some(([kind, name]) => kind === 'remove' && name === 'needs-review'));
    assert.ok(!calls.some(([kind]) => kind === 'comment'));
  });
  it('when a human revokes then spec-approved is removed', async () => {
    const { calls, github } = recorder(issue({ labels: labels('sbi', 'spec-approved') }));
    await postSpecApproval({ issueUrl: ref.url, decision: 'revoke', github });
    assert.ok(calls.some(([kind, name]) => kind === 'remove' && name === 'spec-approved'));
    assert.ok(!calls.some(([kind]) => kind === 'comment'));
  });
  it('when the Issue has no Gherkin then nothing is posted', async () => {
    const { calls, github } = recorder(issue({ body: '## 目的\n\nなし\n' }));
    await assert.rejects(postSpecApproval({ issueUrl: ref.url, decision: 'approve', github }), /spec digest/);
    assert.deepEqual(calls, []);
  });
});
