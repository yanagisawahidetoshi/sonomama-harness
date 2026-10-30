import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderSbiBody } from './planner.mjs';
import { planOf, planDigest, renderPlanSection, parsePlan, withPlanSection, writePbiPlan, approvePbiPlan } from './pbi-plan.mjs';

const pbi = { owner: 'acme', repo: 'app', number: 8, url: 'https://github.com/acme/app/issues/8', title: '受講生ログイン' };
const entries = [
  { id: 'SBI-002', number: 202, kind: 'implementation', dependsOn: ['SBI-001'] },
  { id: 'SBI-001', number: 201, kind: 'implementation', dependsOn: [] },
  { id: 'SBI-003', number: 203, kind: 'validation', dependsOn: ['SBI-002', 'SBI-001'] },
];
const normalized = {
  version: 1, pbi: 8, sbis: [
    { id: 'SBI-001', number: 201, kind: 'implementation', dependsOn: [] },
    { id: 'SBI-002', number: 202, kind: 'implementation', dependsOn: ['SBI-001'] },
    { id: 'SBI-003', number: 203, kind: 'validation', dependsOn: ['SBI-001', 'SBI-002'] },
  ],
};
const body = (plan = planOf(8, entries)) => `## 背景\n\nログインしたい。\n\n${renderPlanSection(pbi.url, plan)}`;

describe('PBI plan: the complete SBI set of a PBI', () => {
  describe('given the SBIs the Planner created', () => {
    it('when the plan is built then the SBIs are sorted by ID with sorted dependencies', () => {
      assert.deepEqual(planOf(8, entries), normalized);
    });
    it('when the digest is taken then it is the sha256 of the normalized PBI number, Issue numbers, SBI IDs, kinds and dependencies', () => {
      assert.equal(planDigest(planOf(8, entries)), createHash('sha256').update(JSON.stringify(normalized)).digest('hex'));
      assert.equal(planDigest(planOf(8, [...entries].reverse())), planDigest(planOf(8, entries)));
    });
    for (const [name, change] of [
      ['an SBI is added', e => [...e, { id: 'SBI-004', number: 204, kind: 'implementation', dependsOn: [] }]],
      ['an SBI is removed', e => e.slice(1)],
      ['an Issue number changes', e => e.map(s => s.id === 'SBI-001' ? { ...s, number: 209 } : s)],
      ['a kind changes', e => e.map(s => s.id === 'SBI-002' ? { ...s, kind: 'validation' } : s)],
      ['a dependency changes', e => e.map(s => s.id === 'SBI-002' ? { ...s, dependsOn: [] } : s)],
    ]) {
      it(`when ${name} then the digest changes`, () => {
        assert.notEqual(planDigest(planOf(8, change(entries))), planDigest(planOf(8, entries)));
      });
    }
    it('when the plan is rendered and parsed back from the PBI body then it is the same plan', () => {
      const section = renderPlanSection(pbi.url, planOf(8, entries));
      assert.match(section, /^## SBI構成$/m);
      assert.match(section, /^- SBI-001: #201 implementation$/m);
      assert.match(section, /^- SBI-003: #203 validation 依存: SBI-001, SBI-002$/m);
      assert.deepEqual(parsePlan(body(), pbi.url), { plan: normalized, errors: [] });
    });
  });

  describe('given a PBI body', () => {
    it('when it has no plan section then there is no plan', () => {
      assert.deepEqual(parsePlan('## 背景\n\nログインしたい。', pbi.url), { plan: null, errors: ['PBI本文に ## SBI構成 がありません'] });
    });
    for (const [name, mutate] of [
      ['a line that is not an SBI entry', text => text.replace('- SBI-001: #201 implementation', '- SBI-001: #201 implementation（済）')],
      ['an unknown kind', text => text.replace('- SBI-001: #201 implementation', '- SBI-001: #201 review')],
      ['the same SBI ID twice', text => text.replace('- SBI-002: #202', '- SBI-001: #202')],
      ['the same Issue number twice', text => text.replace('- SBI-002: #202', '- SBI-002: #201')],
      ['no SBI entry', text => text.replace(/^- SBI-.*\n/gm, '')],
      ['a marker for another PBI', text => text.replace('pbi=https://github.com/acme/app/issues/8', 'pbi=https://github.com/acme/app/issues/9')],
      ['no end marker', text => text.replace('<!-- /sonomama-pbi-plan -->', '')],
    ]) {
      it(`when the section has ${name} then the plan is rejected with the reason`, () => {
        const result = parsePlan(mutate(body()), pbi.url);
        assert.equal(result.plan, null);
        assert.ok(result.errors.length > 0);
      });
    }
    it('when the plan section is written into a body then the rest of the body is kept and an existing section is replaced', () => {
      const first = withPlanSection('## 背景\n\nログインしたい。\n', renderPlanSection(pbi.url, planOf(8, entries)));
      assert.match(first, /^## 背景\n\nログインしたい。\n/);
      const second = withPlanSection(first, renderPlanSection(pbi.url, planOf(8, entries.slice(1))));
      assert.equal(second.match(/sonomama-pbi-plan pbi=/g).length, 1);
      assert.deepEqual(parsePlan(second, pbi.url).plan, planOf(8, entries.slice(1)));
      assert.match(second, /^## 背景\n\nログインしたい。\n/);
    });
  });
});

const sbiBody = (id, kind = 'implementation', dependsOn = []) => renderSbiBody({
  id, kind, title: id, purpose: '目的。', scope: { included: ['apps/mobile'], excluded: [] }, acceptanceCriteria: [{ id: 'AC-1', description: 'できる' }],
  scenarios: [{ name: 's', given: ['g'], when: ['w'], then: ['t'], acceptanceIds: ['AC-1'], test: 'Jest' }], dependsOn, changeAreas: ['apps/mobile'], layers: ['画面Component'],
  estimatedFiles: 1, oversizeReason: null, riskCandidate: 'L2', securityImpact: [], verification: { applicationTest: 'Jest', acceptance: 'Trusted Acceptance', e2e: '不要' },
}, pbi, { 'SBI-001': 201, 'SBI-002': 202 });
function world({ pbiBody = '## 背景\n\nログインしたい。', comments = [], permission = 'write' } = {}) {
  const state = {
    pbi: { number: 8, title: pbi.title, body: pbiBody, html_url: pbi.url, state: 'open', labels: [] },
    issues: [
      { number: 201, title: 'SBI-001 a', body: sbiBody('SBI-001'), html_url: 'https://github.com/acme/app/issues/201', state: 'open', labels: [{ name: 'sbi' }] },
      { number: 202, title: 'SBI-002 b', body: sbiBody('SBI-002', 'implementation', ['SBI-001']), html_url: 'https://github.com/acme/app/issues/202', state: 'open', labels: [{ name: 'sbi' }] },
    ],
    comments, posted: [], patched: [],
  };
  const github = {
    async fetchIssue() { return state.pbi; },
    async listIssues(_ref, label) { return state.issues.filter(i => i.labels.some(l => l.name === label)); },
    async updateIssue(_ref, fields) { state.patched.push(fields); state.pbi.body = fields.body; return state.pbi; },
    async listComments() { return state.comments; },
    async permission() { return permission; },
    async addComment(_ref, text) { state.posted.push(text); return { id: 9, body: text, html_url: `${pbi.url}#issuecomment-9` }; },
  };
  return { state, github };
}
const currentPlan = planOf(8, [{ id: 'SBI-001', number: 201, kind: 'implementation', dependsOn: [] }, { id: 'SBI-002', number: 202, kind: 'implementation', dependsOn: ['SBI-001'] }]);

describe('PBI plan commands', () => {
  describe('given a PBI planned before ## SBI構成 existed', () => {
    it('when harness:pbi-plan is run then the SBI set found on GitHub is written into the PBI body without re-running the Planner', async () => {
      const { state, github } = world();
      const result = await writePbiPlan({ pbiUrl: pbi.url, github });
      assert.equal(result.digest, planDigest(currentPlan));
      assert.deepEqual(parsePlan(state.pbi.body, pbi.url).plan, currentPlan);
      assert.match(state.pbi.body, /^## 背景/);
    });
    it('when the body already has the same plan then nothing is written', async () => {
      const { state, github } = world({ pbiBody: body(currentPlan) });
      await writePbiPlan({ pbiUrl: pbi.url, github });
      assert.deepEqual(state.patched, []);
    });
  });

  describe('given a PBI whose ## SBI構成 matches the SBI Issues on GitHub', () => {
    it('when a human runs harness:pbi-plan-approve then the approval line of the plan digest is posted on the PBI', async () => {
      const { state, github } = world({ pbiBody: body(currentPlan) });
      const result = await approvePbiPlan({ pbiUrl: pbi.url, github });
      assert.deepEqual(state.posted, [`harness-pbi-plan: ${planDigest(currentPlan)}`]);
      assert.equal(result.digest, planDigest(currentPlan));
    });
    it('when the human revokes then the revoke line is posted', async () => {
      const { state, github } = world({ pbiBody: body(currentPlan) });
      await approvePbiPlan({ pbiUrl: pbi.url, github, decision: 'revoke' });
      assert.deepEqual(state.posted, [`harness-pbi-plan-revoke: ${planDigest(currentPlan)}`]);
    });
  });

  describe('given a PBI whose plan cannot be approved', () => {
    for (const [name, options, pattern] of [
      ['there is no ## SBI構成', {}, /SBI構成/],
      ['## SBI構成 lists an SBI Issue that is not on GitHub', { pbiBody: body(planOf(8, [...currentPlan.sbis, { id: 'SBI-003', number: 203, kind: 'validation', dependsOn: [] }])) }, /SBI #203 が見つかりません/],
      ['an SBI Issue on GitHub is missing from ## SBI構成', { pbiBody: body(planOf(8, currentPlan.sbis.slice(0, 1))) }, /SBI #202 が承認済みPBI planに登録されていません|SBI #202 がPBI planに登録されていません/],
      ['## SBI構成 says another kind than the SBI Issue', { pbiBody: body(planOf(8, currentPlan.sbis.map(s => s.id === 'SBI-002' ? { ...s, kind: 'validation' } : s))) }, /SBI #202/],
    ]) {
      it(`when ${name} then nothing is posted`, async () => {
        const { state, github } = world(options);
        await assert.rejects(approvePbiPlan({ pbiUrl: pbi.url, github }), pattern);
        assert.deepEqual(state.posted, []);
      });
    }
  });
});
