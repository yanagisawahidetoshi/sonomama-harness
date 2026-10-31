import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { exists, readJson } from './io.mjs';
import { parseIssueUrl, planIssue, renderCreatedList, sbiMarker, sbiDigest } from './planner.mjs';
import { judgePlan, creationOrder, judgeChangedFileCount } from './planner-judge.mjs';
import { plannedSbiSchema, planJsonSchema } from './schemas.mjs';
import { parsePlan, planOf, planDigest } from './pbi-plan.mjs';

const pbiUrl = 'https://github.com/acme/app/issues/8';
const pbi = { number: 8, title: '受講生プロフィールを表示する', body: '## 背景\nプロフィールを取得・更新・表示する。', html_url: pbiUrl, state: 'open', labels: [] };

function sbi(id, overrides = {}) {
  return {
    id, kind: 'implementation', title: `${id}の機能`, purpose: `${id}を実現する。`,
    scope: { included: ['apps/mobile プロフィール画面'], excluded: [] },
    acceptanceCriteria: [{ id: 'AC-1', description: '登録済みの氏名が画面に表示される' }, { id: 'AC-2', description: '未登録なら未設定と表示される' }],
    scenarios: [
      { name: '登録済みプロフィールを表示する', given: ['ログイン済みの受講生がいる', 'プロフィールが登録されている'], when: ['プロフィール画面を開く'], then: ['登録済みの氏名が表示される'], acceptanceIds: ['AC-1'], test: 'RNTL: プロフィール画面Component' },
      { name: '未登録プロフィールを表示する', given: ['ログイン済みの受講生がいる'], when: ['プロフィール画面を開く'], then: ['未設定と表示される'], acceptanceIds: ['AC-2'], test: 'RNTL: プロフィール画面Component' },
    ],
    dependsOn: [], changeAreas: ['apps/mobile'], layers: ['画面Component'], estimatedFiles: 4, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
    verification: { applicationTest: 'RNTL', acceptance: 'Trusted Acceptance', e2e: '不要' },
    ...overrides,
  };
}
// A validation SBI (real API + Maestro) is added only when the PBI needs Integration / E2E. Human acceptance is a PBI Gate, not an SBI.
const e2eScenarios = (test) => sbi('x').scenarios.map(s => ({ ...s, test }));
const validation = (id, dependsOn) => sbi(id, { kind: 'validation', dependsOn, changeAreas: ['apps/mobile', 'apps/api'], layers: ['画面Component', 'Rails Controller', 'Rails Model'], estimatedFiles: 3, scenarios: e2eScenarios('Maestro: 実API + Rails + DB'), verification: { applicationTest: '不要', acceptance: 'Trusted Acceptance', e2e: 'Maestro（実API + Rails + DB）' } });
const validPlan = () => [sbi('SBI-001'), sbi('SBI-002', { dependsOn: ['SBI-001'] }), validation('SBI-003', ['SBI-001', 'SBI-002'])];
const withValidation = (...implementations) => [...implementations, validation('SBI-901', implementations.map(s => s.id))];
const agentWith = sbis => async () => ({ sbis, escalation: null });
const fakeToken = 'ghp_' + 'k'.repeat(36);

const mockGitHub = githubMock({ issue: pbi });
const plan = (root, options = {}) => planIssue({ root, issueUrl: pbiUrl, provider: 'claude', quiet: true, agent: agentWith(validPlan()), ...options });

describe('PBI → SBI Planner', () => {
  describe('given a GitHub Issue URL', () => {
    it('when the URL is a github.com issue then extracts owner, repository and number', () => {
      assert.deepEqual(parseIssueUrl('https://github.com/acme/app-1.2/issues/42'), { owner: 'acme', repo: 'app-1.2', number: 42, url: 'https://github.com/acme/app-1.2/issues/42' });
    });
    for (const url of ['https://example.com/acme/app/issues/8', 'https://github.com/acme/app/pull/8', 'https://github.com/acme/app/issues/abc', 'https://github.com/acme/issues/8', 'not a url', 'https://github.com/acme/app/issues/8/../9']) {
      it(`when the URL is ${JSON.stringify(url)} then rejects it before any GitHub call`, () => fixture(root => mockGitHub({}, async github => {
        await assert.rejects(plan(root, { issueUrl: url }), /GitHub Issue URL/);
        assert.deepEqual(await github.calls(), []);
      })));
    }
    it('when the issue cannot be fetched then fails with a clear error and creates nothing', () => fixture(root => mockGitHub({ issue: { ...pbi, number: 9 } }, async github => {
      await assert.rejects(plan(root), /GitHub Issue.*(404|fetch|取得)/i);
      assert.equal((await github.state()).created.length, 0);
    })));
    it('when the number refers to a pull request then rejects it as a PBI', () => fixture(root => mockGitHub({ issue: { ...pbi, pull_request: { url: 'x' } } }, async github => {
      await assert.rejects(plan(root), /pull request/i);
      assert.equal((await github.state()).created.length, 0);
    })));
  });

  describe('given a PBI and a provider that returns SBI candidates', () => {
    it('when the candidates pass the quality judge then creates one Issue per SBI with sbi and needs-review labels in dependency order', () => fixture(root => mockGitHub({}, async github => {
      const result = await plan(root);
      const state = await github.state();
      assert.equal(result.quality.status, 'PASS');
      assert.deepEqual(state.created.map(i => i.title), ['SBI-001 SBI-001の機能', 'SBI-002 SBI-002の機能', 'SBI-003 SBI-003の機能']);
      for (const issue of state.created) {
        assert.deepEqual(issue.labels.map(l => l.name).sort(), ['needs-review', 'sbi']);
        assert.match(issue.body, /#8/);
        const sbiId = issue.title.split(' ')[0];
        assert.ok(issue.body.includes(`<!-- sonomama-sbi pbi=${pbiUrl} id=${sbiId} digest=${sbiDigest(validPlan().find(s => s.id === sbiId))} -->`), 'deterministic marker with content digest');
        for (const heading of ['## 種類', '## 目的', '## 対象範囲', '## 受け入れ要件', '## Gherkin', '## 依存SBI', '## 想定変更範囲', '## Risk / Security Impact', '## 検証方法', '## 元PBI']) assert.ok(issue.body.includes(heading), `${issue.title} lacks ${heading}`);
        assert.match(issue.body, /Scenario: 登録済みプロフィールを表示する\n\s+Given ログイン済みの受講生がいる\n\s+And プロフィールが登録されている\n\s+When プロフィール画面を開く\n\s+Then 登録済みの氏名が表示される/);
        assert.match(issue.body, /- \[ \] AC-1: 登録済みの氏名が画面に表示される/);
        assert.match(issue.body, /Risk: L2 candidate\nSecurity: None/);
        const { verification } = validPlan().find(s => s.id === sbiId);
        assert.ok(issue.body.includes(`Application Test: ${verification.applicationTest}\n受け入れ要件: ${verification.acceptance}\nE2E: ${verification.e2e}`));
      }
      assert.match(state.created[0].body, /## 依存SBI\n\nなし/);
      assert.match(state.created[0].body, /Application Test: RNTL\n受け入れ要件: Trusted Acceptance\nE2E: 不要/);
      assert.match(state.created[2].body, /E2E: Maestro（実API \+ Rails \+ DB）/);
      assert.match(state.created[1].body, /## 依存SBI\n\n- SBI-001 \(#101\)\n\n/);
      assert.match(state.created[2].body, /## 依存SBI\n\n- SBI-001 \(#101\)\n- SBI-002 \(#102\)\n\n/);
      assert.match(state.created[0].body, /## 種類\n\n実装SBI（implementation）/);
      assert.match(state.created[1].body, /## 種類\n\n実装SBI（implementation）/);
      assert.match(state.created[2].body, /## 種類\n\n最終確認SBI（validation）/);
      for (const issue of state.created) assert.doesNotMatch(issue.body, /人間確認SBI|acceptance）/);
      assert.match(state.created[0].body, /## レイヤー\n\n画面Component\n\n## 想定変更ファイル数\n\n4\n\n/);
      assert.match(state.created[0].body, /## Gherkinと実テスト\n\n- 登録済みプロフィールを表示する → RNTL: プロフィール画面Component\n- 未登録プロフィールを表示する → RNTL: プロフィール画面Component\n/);
      assert.match(state.created[2].body, /- 登録済みプロフィールを表示する → Maestro: 実API \+ Rails \+ DB\n/);
      assert.deepEqual(result.created.map(c => [c.sbiId, c.number, c.url]), [['SBI-001', 101, 'https://github.com/acme/app/issues/101'], ['SBI-002', 102, 'https://github.com/acme/app/issues/102'], ['SBI-003', 103, 'https://github.com/acme/app/issues/103']]);
      assert.deepEqual(state.labels.sort(), ['needs-review', 'plan-approved', 'sbi', 'spec-approved']);
    })));
    // ADR-0009: the approval labels exist so that a human can pick them on GitHub; the Planner never approves its own output.
    it('when Issues are created then neither spec-approved nor plan-approved is put on any Issue', () => fixture(root => mockGitHub({}, async github => {
      await plan(root);
      const state = await github.state();
      assert.ok(!state.created.some(i => i.labels.some(l => ['spec-approved', 'plan-approved', 'ready'].includes(l.name))));
      assert.ok(!(await github.calls()).some(call => call.args.some(arg => /\/issues\/\d+\/labels/.test(arg))), 'the Planner adds no label to an existing Issue');
    })));
    it('when Issues are created then comments the generated SBI list on the PBI and lists every URL on stdout', () => fixture(root => mockGitHub({}, async github => {
      const result = await plan(root);
      const [comment] = (await github.state()).comments;
      assert.equal(comment.issue, 8);
      assert.match(comment.body, /## Generated SBI\n\n- #101 SBI-001 SBI-001の機能\n- #102 SBI-002 SBI-002の機能\n- #103 SBI-003 SBI-003の機能/);
      const output = renderCreatedList(result.created);
      assert.match(output, /Created SBI Issues/);
      for (const created of result.created) assert.ok(output.includes(`#${created.number} ${created.sbiId}`) && output.includes(created.url));
    })));
    it('when GITHUB_STEP_SUMMARY is set then appends the same list to the Job Summary', () => fixture(root => mockGitHub({}, async github => {
      const summary = join(github.dir, 'summary.md');
      await writeFile(summary, '# existing\n');
      process.env.GITHUB_STEP_SUMMARY = summary;
      const result = await plan(root);
      const text = await readFile(summary, 'utf8');
      assert.match(text, /^# existing\n/);
      assert.match(text, /Created SBI Issues/);
      for (const created of result.created) assert.ok(text.includes(created.url));
    })));
    it('when planning succeeds then the PBI body gets ## SBI構成 with every created SBI Issue, its kind and its dependencies, and keeps the rest of the body', () => fixture(root => mockGitHub({}, async github => {
      const result = await plan(root);
      const body = (await github.state()).issue.body;
      assert.match(body, /^## 背景\nプロフィールを取得・更新・表示する。/);
      assert.deepEqual(parsePlan(body, pbiUrl), { plan: planOf(8, [
        { id: 'SBI-001', number: 101, kind: 'implementation', dependsOn: [] }, { id: 'SBI-002', number: 102, kind: 'implementation', dependsOn: ['SBI-001'] },
        { id: 'SBI-003', number: 103, kind: 'validation', dependsOn: ['SBI-001', 'SBI-002'] },
      ]), errors: [] });
      assert.equal(result.planDigest, planDigest(parsePlan(body, pbiUrl).plan));
      assert.match(body, /pnpm harness:pbi-plan-approve https:\/\/github\.com\/acme\/app\/issues\/8/);
    })));
    it('when a human edits the PBI body while the Planner runs then ## SBI構成 is added to the edited body instead of overwriting the edit', () => fixture(root => mockGitHub({}, async github => {
      const agent = async () => { await github.update(state => { state.issue.body += '\n\n追記: 管理者向けの表示は対象外'; }); return { sbis: validPlan(), escalation: null }; };
      await plan(root, { agent });
      const body = (await github.state()).issue.body;
      assert.match(body, /追記: 管理者向けの表示は対象外/);
      assert.match(body, /^## SBI構成$/m);
    })));
    it('when the planner is re-run with the same SBIs then the PBI body is not written again', () => fixture(root => mockGitHub({}, async github => {
      await plan(root);
      const before = (await github.calls()).length;
      await plan(root);
      assert.ok(!(await github.calls()).slice(before).some(call => call.args.includes('PATCH') && call.args.some(a => /^repos\/acme\/app\/issues\/8$/.test(a))));
    })));
    it('when GITHUB_STEP_SUMMARY is unset then writes no summary file', () => fixture(root => mockGitHub({}, async github => {
      await plan(root);
      assert.equal(await exists(join(github.dir, 'summary.md')), false);
    })));
    it('when planning succeeds then records redacted evidence and never starts the Execution Harness', () => fixture(root => mockGitHub({ issue: { ...pbi, body: `token=${fakeToken}\n本文` } }, async github => {
      const result = await plan(root);
      const directory = join(root, result.planDir);
      for (const file of ['pbi.json', 'prompt.txt', 'quality.json', 'issues.json', 'summary.json']) assert.ok(await exists(join(directory, file)), `missing ${file}`);
      const prompt = await readFile(join(directory, 'prompt.txt'), 'utf8');
      assert.match(prompt, /受講生プロフィールを表示する/);
      assert.ok(!prompt.includes(fakeToken));
      assert.ok(!(await readFile(join(directory, 'pbi.json'), 'utf8')).includes(fakeToken));
      const runState = join(root, '.harness/state/runs');
      assert.ok(!(await exists(runState)) || (await readdir(runState)).every(name => name === '.gitkeep'), 'execution run state must not be created');
      assert.ok(!(await github.state()).created.some(i => i.labels.some(l => l.name === 'ready')));
      assert.ok(!(await readdir(join(root, '.harness/runs'))).some(name => !name.startsWith('plan-') && name !== '.gitkeep'));
    })));
    it('when the provider escalates then stops without creating Issues', () => fixture(root => mockGitHub({}, async github => {
      await assert.rejects(plan(root, { agent: async () => ({ sbis: [], escalation: 'PBIが曖昧です' }) }), /PBIが曖昧です/);
      assert.equal((await github.state()).created.length, 0);
    })));
    it('when no --provider is given then decomposes the PBI with Claude', () => fixture(root => mockGitHub({}, async () => {
      const used = [];
      await plan(root, { provider: undefined, agent: async ({ provider }) => { used.push(provider); return { sbis: validPlan(), escalation: null }; } });
      assert.deepEqual(used, ['claude']);
    })));
    it('when --provider codex is given then decomposes the PBI with Codex instead', () => fixture(root => mockGitHub({}, async () => {
      const used = [];
      await plan(root, { provider: 'codex', agent: async ({ provider }) => { used.push(provider); return { sbis: validPlan(), escalation: null }; } });
      assert.deepEqual(used, ['codex']);
    })));
    it('when the provider is fake then refuses to publish to GitHub', () => fixture(root => mockGitHub({}, async github => {
      await assert.rejects(plan(root, { provider: 'fake' }), /provider/);
      assert.deepEqual(await github.calls(), []);
    })));
    it('when the quality judge fails then creates no Issue and reports every reason', () => fixture(root => mockGitHub({}, async github => {
      const broken = withValidation(sbi('SBI-001', { scenarios: [], dependsOn: ['SBI-002'] }), sbi('SBI-002', { dependsOn: ['SBI-001'], changeAreas: [] }));
      await assert.rejects(plan(root, { agent: agentWith(broken) }), error => /SBI Quality Judge/.test(error.message) && /Gherkin/.test(error.message) && /循環/.test(error.message) && /変更範囲/.test(error.message));
      assert.equal((await github.state()).created.length, 0);
      assert.ok(!(await github.calls()).some(call => call.args.includes('-X')));
      const plans = (await readdir(join(root, '.harness/runs'))).filter(name => name.startsWith('plan-'));
      assert.equal((await readJson(join(root, '.harness/runs', plans[0], 'quality.json'))).status, 'FAIL');
    })));
    it('when Issue creation fails midway then reports the Issues created so far and does not comment on the PBI', () => fixture(root => mockGitHub({ failOnCreate: 2 }, async github => {
      await assert.rejects(plan(root), /#101/);
      const state = await github.state();
      assert.equal(state.created.length, 1);
      assert.equal(state.comments.length, 0);
    })));
    it('when the planner is re-run after a partial failure then reuses the existing SBI Issue and creates only the missing ones', () => fixture(root => mockGitHub({ failOnCreate: 2 }, async github => {
      await assert.rejects(plan(root), /#101/);
      const result = await plan(root);
      const state = await github.state();
      assert.deepEqual(state.created.map(i => i.title), ['SBI-001 SBI-001の機能', 'SBI-002 SBI-002の機能', 'SBI-003 SBI-003の機能']);
      assert.deepEqual(result.created.map(c => [c.sbiId, c.number, c.reused]), [['SBI-001', 101, true], ['SBI-002', 102, false], ['SBI-003', 103, false]]);
      assert.match(state.created[2].body, /- SBI-001 \(#101\)\n- SBI-002 \(#102\)/);
      assert.equal(state.comments.length, 1);
      assert.match(state.comments[0].body, /- #101 SBI-001 SBI-001の機能\n- #102 SBI-002 SBI-002の機能\n- #103 SBI-003 SBI-003の機能/);
    })));
    it('when the planner is re-run after success then creates no duplicate Issue and updates the existing PBI comment in place', () => fixture(root => mockGitHub({}, async github => {
      await plan(root);
      const result = await plan(root);
      const state = await github.state();
      assert.equal(state.created.length, 3);
      assert.ok(result.created.every(c => c.reused));
      assert.equal(state.comments.length, 1);
      assert.equal(state.comments[0].updated, 1);
      assert.match(renderCreatedList(result.created), /#101 SBI-001/);
    })));
    it('when an SBI Issue for another PBI carries the same SBI ID then does not reuse it', () => fixture(root => mockGitHub({ created: [{ number: 50, title: 'SBI-001 別PBIのSBI', body: sbiMarker('https://github.com/acme/app/issues/7', 'SBI-001', sbiDigest(sbi('SBI-001'))), state: 'open', html_url: 'https://github.com/acme/app/issues/50', labels: [{ name: 'sbi' }, { name: 'needs-review' }] }] }, async github => {
      const result = await plan(root);
      assert.deepEqual(result.created.map(c => [c.sbiId, c.reused]), [['SBI-001', false], ['SBI-002', false], ['SBI-003', false]]);
      assert.equal((await github.state()).created.length, 4);
    })));
    it('when an existing SBI Issue was generated from different content then fails before any GitHub write and names the Issue', () => fixture(root => mockGitHub({}, async github => {
      await plan(root);
      const afterFirst = (await github.calls()).length;
      const changed = validPlan();
      changed[0].acceptanceCriteria.push({ id: 'AC-3', description: '氏名の変更が即時に反映される' });
      changed[0].scenarios[0].acceptanceIds.push('AC-3');
      await assert.rejects(plan(root, { agent: agentWith(changed) }), error => /#101/.test(error.message) && /SBI-001/.test(error.message) && /digest|内容/.test(error.message));
      const state = await github.state();
      assert.equal(state.created.length, 3);
      assert.equal(state.comments[0].updated, undefined);
      assert.ok(!(await github.calls()).slice(afterFirst).some(call => call.args.includes('-X')), 'second run must not write');
      assert.equal((await github.calls()).filter(call => call.args.includes('POST')).length, 8, 'first run: 4 labels + 3 issues + 1 comment; second run: no POST');
    })));
    const tampered = [
      ['a human edited the Issue body after generation', issue => { issue.body = issue.body.replace('登録済みの氏名が画面に表示される', '登録済みの氏名と所属が画面に表示される'); }, /本文/],
      ['the Issue was moved from needs-review to ready', issue => { issue.labels = [{ name: 'sbi' }, { name: 'ready' }]; }, /needs-review/],
      ['the Issue was closed', issue => { issue.state = 'closed'; }, /closed|open/],
      ['the Issue title was changed', issue => { issue.title = 'SBI-001 改題されたSBI'; }, /title|タイトル/],
    ];
    for (const [condition, mutate, reason] of tampered) {
      it(`when ${condition} then does not reuse it, writes nothing and asks for a human decision`, () => fixture(root => mockGitHub({}, async github => {
        await plan(root);
        const state = await github.state();
        mutate(state.created[0]);
        await writeFile(join(github.dir, 'state.json'), JSON.stringify(state));
        const before = (await github.calls()).length;
        await assert.rejects(plan(root), error => /#101/.test(error.message) && /SBI-001/.test(error.message) && reason.test(error.message));
        assert.equal((await github.state()).created.length, 3);
        assert.ok(!(await github.calls()).slice(before).some(call => call.args.includes('-X')), 'second run must not write');
      })));
    }
    it('when an existing SBI Issue carries a marker without a digest then does not reuse it silently', () => fixture(root => mockGitHub({ created: [{ number: 50, title: 'SBI-001 SBI-001の機能', body: '<!-- sonomama-sbi pbi=https://github.com/acme/app/issues/8 id=SBI-001 -->', state: 'open', html_url: 'https://github.com/acme/app/issues/50', labels: [{ name: 'sbi' }, { name: 'needs-review' }] }] }, async github => {
      await assert.rejects(plan(root), /#50/);
      assert.equal((await github.state()).created.length, 1);
    })));
    it('when the same content is rendered twice then the digest is stable and independent of key order', () => {
      const a = sbi('SBI-001');
      const b = Object.fromEntries(Object.entries(a).reverse());
      assert.equal(sbiDigest(a), sbiDigest(b));
      assert.match(sbiDigest(a), /^[0-9a-f]{64}$/);
      assert.notEqual(sbiDigest(a), sbiDigest(sbi('SBI-001', { purpose: '別の目的。' })));
    });
    it('when a candidate contains a credential then rejects it before any GitHub write', () => fixture(root => mockGitHub({}, async github => {
      const leaking = validPlan();
      leaking[1].acceptanceCriteria[0].description = `${fakeToken} で認証できる`;
      await assert.rejects(plan(root, { agent: agentWith(leaking) }), /[Ss]ecret|[Cc]redential/);
      assert.equal((await github.state()).created.length, 0);
      assert.ok(!(await github.calls()).some(call => call.args.includes('-X')));
      const plans = (await readdir(join(root, '.harness/runs'))).filter(name => name.startsWith('plan-'));
      assert.ok(!(await readFile(join(root, '.harness/runs', plans[0], 'summary.json'), 'utf8')).includes(fakeToken));
    })));
    it('when a candidate declares a security category outside the Harness policy then the quality judge fails', () => fixture(root => mockGitHub({}, async github => {
      await assert.rejects(plan(root, { agent: agentWith([sbi('SBI-001', { securityImpact: ['Telemetry'], riskCandidate: 'L3' })]) }), /SBI Quality Judge[\s\S]*Telemetry/);
      assert.equal((await github.state()).created.length, 0);
    })));
  });
});

describe('SBI Quality Judge', () => {
  describe('given SBI candidates generated from a PBI', () => {
    it('when every SBI is small, verifiable and acyclic then passes', () => {
      assert.deepEqual(judgePlan(validPlan()), { status: 'PASS', findings: [] });
    });
    // A PBI that needs an API contract change gets one OpenAPI Schema SBI; the Rails and frontend SBIs depend on it.
    it('when an OpenAPI Schema SBI changes only packages/api-schema and the implementation SBIs depend on it then passes', () => {
      const plan = [sbi('SBI-001', { changeAreas: ['packages/api-schema'] }), sbi('SBI-002', { changeAreas: ['apps/api'], dependsOn: ['SBI-001'] }), sbi('SBI-003', { changeAreas: ['apps/admin'], dependsOn: ['SBI-001'] })];
      assert.deepEqual(judgePlan(plan), { status: 'PASS', findings: [] });
    });
    it('when the OpenAPI Schema change is mixed into an implementation SBI then fails and asks for a separate Schema SBI', () => {
      const result = judgePlan([sbi('SBI-001', { changeAreas: ['packages/api-schema', 'apps/api'] })]);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.findings.some(f => f.sbi === 'SBI-001' && f.rule === 'schema-sbi' && /OpenAPI Schema/.test(f.reason)));
    });
    it('when an implementation SBI does not depend on the OpenAPI Schema SBI of the same PBI then fails', () => {
      const result = judgePlan([sbi('SBI-001', { changeAreas: ['packages/api-schema'] }), sbi('SBI-002', { changeAreas: ['apps/api'] })]);
      assert.ok(result.findings.some(f => f.sbi === 'SBI-002' && f.rule === 'schema-sbi' && /SBI-001/.test(f.reason)));
    });
    it('when an implementation SBI that seems not to use the API does not depend on the OpenAPI Schema SBI then still fails', () => {
      const result = judgePlan([sbi('SBI-001', { changeAreas: ['packages/api-schema'] }), sbi('SBI-002', { changeAreas: ['apps/mobile'], layers: ['FE state hook'] })]);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.findings.some(f => f.sbi === 'SBI-002' && f.rule === 'schema-sbi' && /SBI-001/.test(f.reason)), JSON.stringify(result.findings));
    });
    it('when a PBI has two OpenAPI Schema SBIs then fails', () => {
      const result = judgePlan([sbi('SBI-001', { changeAreas: ['packages/api-schema'] }), sbi('SBI-002', { changeAreas: ['packages/api-schema/'], dependsOn: ['SBI-001'] })]);
      assert.ok(result.findings.some(f => f.rule === 'schema-sbi'));
    });
    it('when dependencies form a DAG then orders creation so that dependencies come first', () => {
      assert.deepEqual(creationOrder([sbi('SBI-003', { dependsOn: ['SBI-001', 'SBI-002'] }), sbi('SBI-002', { dependsOn: ['SBI-001'] }), sbi('SBI-001')]), ['SBI-001', 'SBI-002', 'SBI-003']);
    });
    const failures = [
      ['the SBI has more than 6 acceptance criteria', sbi('SBI-001', { acceptanceCriteria: Array.from({ length: 7 }, (_, i) => ({ id: `AC-${i + 1}`, description: `項目${i + 1}が表示される` })), scenarios: [{ name: 's', given: ['a'], when: ['b'], then: ['c'], acceptanceIds: Array.from({ length: 7 }, (_, i) => `AC-${i + 1}`) }] }), /粒度/],
      ['the SBI has more than 4 change areas', sbi('SBI-001', { changeAreas: ['apps/api', 'apps/mobile', 'apps/admin', 'packages/ui', 'packages/api-schema'] }), /粒度/],
      ['the purpose contains more than two sentences', sbi('SBI-001', { purpose: '取得する。更新する。表示する。' }), /目的/],
      ['acceptance criteria are missing', sbi('SBI-001', { acceptanceCriteria: [], scenarios: [{ name: 's', given: ['a'], when: ['b'], then: ['c'], acceptanceIds: [] }] }), /受け入れ要件/],
      ['an acceptance criterion is not verifiable', sbi('SBI-001', { acceptanceCriteria: [{ id: 'AC-1', description: '適切に表示される' }, { id: 'AC-2', description: '未登録なら未設定と表示される' }] }), /検証可能/],
      ['Gherkin scenarios are missing', sbi('SBI-001', { scenarios: [] }), /Gherkin/],
      ['a scenario lacks Given, When or Then', sbi('SBI-001', { scenarios: [{ name: 's', given: [], when: ['b'], then: ['c'], acceptanceIds: ['AC-1', 'AC-2'] }] }), /Given/],
      ['a scenario references an unknown acceptance criterion', sbi('SBI-001', { scenarios: [{ name: 's', given: ['a'], when: ['b'], then: ['c'], acceptanceIds: ['AC-1', 'AC-2', 'AC-9'] }] }), /AC-9/],
      ['an acceptance criterion has no scenario', sbi('SBI-001', { scenarios: [{ name: 's', given: ['a'], when: ['b'], then: ['c'], acceptanceIds: ['AC-1'] }] }), /AC-2/],
      ['the SBI depends on itself', sbi('SBI-001', { dependsOn: ['SBI-001'] }), /循環|自分自身/],
      ['the SBI depends on an unknown SBI', sbi('SBI-001', { dependsOn: ['SBI-009'] }), /SBI-009/],
      ['the change areas are empty', sbi('SBI-001', { changeAreas: [] }), /変更範囲/],
      ['a security impact is declared with a risk candidate below L3', sbi('SBI-001', { securityImpact: ['AuthZ'], riskCandidate: 'L2' }), /Risk/],
      ['the security impact mixes None with a category', sbi('SBI-001', { securityImpact: ['None', 'PII'], riskCandidate: 'L3' }), /Security/],
      ['the title is blank', sbi('SBI-001', { title: ' ' }), /タイトル/],
      ['the purpose is blank', sbi('SBI-001', { purpose: ' ' }), /目的/],
      ['the scope has no included item', sbi('SBI-001', { scope: { included: [], excluded: [] } }), /対象範囲/],
      ['the scope contains a blank item', sbi('SBI-001', { scope: { included: [' '], excluded: [] } }), /対象範囲/],
      ['the verification method is blank', sbi('SBI-001', { verification: { applicationTest: ' ', acceptance: 'Trusted Acceptance', e2e: '不要' } }), /検証方法/],
    ];
    for (const [condition, candidate, reason] of failures) {
      it(`when ${condition} then fails with the reason`, () => {
        const result = judgePlan([candidate]);
        assert.equal(result.status, 'FAIL');
        assert.ok(result.findings.some(f => f.sbi === 'SBI-001' && reason.test(f.reason)), JSON.stringify(result.findings));
      });
    }
    it('when an acceptance criterion contains a word like fetch then does not treat it as the vague term etc', () => {
      assert.equal(judgePlan([sbi('SBI-001', { acceptanceCriteria: [{ id: 'AC-1', description: 'プロフィールをfetchして氏名を表示する' }, { id: 'AC-2', description: '未登録なら未設定と表示される' }] })]).status, 'PASS');
    });
    it('when the purpose mentions a host name or version then does not count the dots as sentences', () => {
      assert.equal(judgePlan([sbi('SBI-001', { purpose: 'api.example.com のv1.2を使ってプロフィールを取得する。表示までを対象にする。' })]).status, 'PASS');
    });
    it('when a security category is outside the known list then fails naming it', () => {
      const result = judgePlan([sbi('SBI-001', { securityImpact: ['Telemetry'], riskCandidate: 'L3' })], { securityCategories: ['AuthZ', 'PII'] });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.findings.some(f => /Security/.test(f.reason) && /Telemetry/.test(f.reason)));
    });
    it('when every security category is in the known list then passes', () => {
      assert.equal(judgePlan([sbi('SBI-001', { securityImpact: ['AuthZ'], riskCandidate: 'L3' })], { securityCategories: ['AuthZ', 'PII'] }).status, 'PASS');
    });
    it('when two SBIs share an ID then fails with the duplicate', () => {
      const result = judgePlan([sbi('SBI-001'), sbi('SBI-001')]);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.findings.some(f => /重複/.test(f.reason)));
    });
    it('when a PBI has several implementation SBIs followed by one validation SBI then passes', () => {
      assert.deepEqual(judgePlan(withValidation(sbi('SBI-001'), sbi('SBI-002', { dependsOn: ['SBI-001'] }), sbi('SBI-003'))), { status: 'PASS', findings: [] });
    });
    it('when a PBI needs no Integration / E2E and has only implementation SBIs then passes without a validation SBI', () => {
      assert.deepEqual(judgePlan([sbi('SBI-001'), sbi('SBI-002', { dependsOn: ['SBI-001'] })]), { status: 'PASS', findings: [] });
    });
    it('when a candidate declares the acceptance kind then fails because human acceptance is a PBI Gate, not an SBI', () => {
      const result = judgePlan([sbi('SBI-001'), sbi('SBI-002', { kind: 'acceptance', dependsOn: ['SBI-001'] })]);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.findings.some(f => f.sbi === 'SBI-002' && /PBI Human Acceptance Gate/.test(f.reason)), JSON.stringify(result.findings));
    });
    it('when the validation SBI spans more change areas than an implementation SBI may then still passes because the E2E covers the whole PBI', () => {
      const plan = withValidation(sbi('SBI-001'));
      plan[1].changeAreas = ['apps/mobile', 'apps/api', 'apps/admin', 'packages/api-schema', 'packages/ui'];
      assert.equal(judgePlan(plan).status, 'PASS');
    });
    const kindFailures = [
      ['the plan has no implementation SBI', () => [validation('SBI-901', [])], '*', /実装SBI/],
      ['the plan has two validation SBIs', () => [...withValidation(sbi('SBI-001')), validation('SBI-903', ['SBI-001'])], '*', /最終確認SBI.*1件まで/],
      ['the validation SBI does not depend on every implementation SBI', () => [sbi('SBI-001'), sbi('SBI-002'), validation('SBI-901', ['SBI-001'])], 'SBI-901', /SBI-002/],
      ['the validation SBI depends on another validation SBI', () => [sbi('SBI-001'), validation('SBI-901', ['SBI-001', 'SBI-902']), validation('SBI-902', ['SBI-001'])], 'SBI-901', /SBI-902/],
      ['an implementation SBI depends on the validation SBI', () => [sbi('SBI-001'), sbi('SBI-002', { dependsOn: ['SBI-901'] }), validation('SBI-901', ['SBI-001', 'SBI-002'])], 'SBI-002', /実装SBI.*SBI-901/],
    ];
    for (const [condition, candidates, target, reason] of kindFailures) {
      it(`when ${condition} then fails with the reason`, () => {
        const result = judgePlan(candidates());
        assert.equal(result.status, 'FAIL');
        assert.ok(result.findings.some(f => f.sbi === target && reason.test(f.reason)), JSON.stringify(result.findings));
      });
    }
    for (const field of ['layers', 'estimatedFiles', 'oversizeReason']) {
      it(`when a candidate omits ${field} then the provider output is rejected and the provider schema requires it`, () => {
        const { [field]: _omitted, ...candidate } = sbi('SBI-001');
        assert.equal(plannedSbiSchema.safeParse(candidate).success, false);
        assert.ok(planJsonSchema.properties.sbis.items.required.includes(field));
      });
    }
    it('when a scenario omits the test that verifies it then the provider output is rejected and the provider schema requires it', () => {
      const candidate = sbi('SBI-001');
      candidate.scenarios = candidate.scenarios.map(({ test: _omitted, ...scenario }) => scenario);
      assert.equal(plannedSbiSchema.safeParse(candidate).success, false);
      assert.ok(planJsonSchema.properties.sbis.items.properties.scenarios.items.required.includes('test'));
    });
    const layered = (id, layer, changeAreas, test, overrides = {}) => sbi(id, { layers: [layer], changeAreas, scenarios: sbi(id).scenarios.map(s => ({ ...s, test })), verification: { applicationTest: test.split(':')[0], acceptance: 'Trusted Acceptance', e2e: '不要' }, ...overrides });
    it('when a PBI is split into one SBI per Rails and Frontend layer with an integration SBI then passes', () => {
      const plan = withValidation(
        layered('SBI-001', 'OpenAPI Schema', ['packages/api-schema'], 'Prism mock contract test: GET /students'),
        layered('SBI-002', 'Rails Model', ['apps/api'], 'RSpec Model Spec: Student', { dependsOn: ['SBI-001'] }),
        layered('SBI-003', 'Rails Controller / Request', ['apps/api'], 'RSpec Request Spec: GET /students', { dependsOn: ['SBI-002'] }),
        layered('SBI-004', 'FE API Hook', ['apps/mobile'], 'Vitest Hook test with API mock: useStudents', { dependsOn: ['SBI-001'] }),
        // The Schema SBI rule of the PBI applies to every implementation SBI, including one that does not call the API.
        layered('SBI-005', 'FE state hook', ['apps/mobile'], 'Vitest Hook test: useStudentFilter', { dependsOn: ['SBI-001'] }),
        layered('SBI-006', '画面Component', ['apps/mobile', 'packages/ui'], 'RNTL Component test: StudentList', { dependsOn: ['SBI-004', 'SBI-005'] }),
        layered('SBI-007', 'Integration', ['apps/mobile'], 'Maestro E2E against the mock API: 受講生一覧', { dependsOn: ['SBI-006'] }),
      );
      assert.deepEqual(judgePlan(plan), { status: 'PASS', findings: [] });
    });
    it('when an implementation SBI expects more than 10 changed files and states why it cannot be split then passes', () => {
      assert.equal(judgePlan(withValidation(sbi('SBI-001', { estimatedFiles: 14, oversizeReason: '生成されたAPI clientの再生成で14ファイルが同時に変わり、分割すると型が一致しない' }))).status, 'PASS');
    });
    it('when the application test names a real test alongside lint and typecheck then passes', () => {
      assert.equal(judgePlan(withValidation(sbi('SBI-001', { verification: { applicationTest: 'Vitest + eslint + tsc', acceptance: 'Trusted Acceptance', e2e: '不要' } }))).status, 'PASS');
    });
    it('when the validation SBI spans several layers, more than 10 files and has no application test then passes because its Maestro E2E is the real test', () => {
      const plan = withValidation(sbi('SBI-001'));
      plan[1].estimatedFiles = 12;
      assert.equal(judgePlan(plan).status, 'PASS');
    });
    it('when the acceptance SBI has no layer, no changed file and only a human check then passes', () => {
      assert.equal(judgePlan(validPlan()).findings.filter(f => f.sbi === 'SBI-003').length, 0);
    });
    const verification = applicationTest => ({ applicationTest, acceptance: 'Trusted Acceptance', e2e: '不要' });
    const granularityFailures = [
      ['an implementation SBI declares more than one layer', () => withValidation(sbi('SBI-001', { layers: ['Rails Model', 'Rails Controller'] })), 'SBI-001', /レイヤー/],
      ['an implementation SBI declares no layer', () => withValidation(sbi('SBI-001', { layers: [] })), 'SBI-001', /レイヤー/],
      ['an implementation SBI changes both the Rails API and the mobile app', () => withValidation(sbi('SBI-001', { changeAreas: ['apps/api', 'apps/mobile'] })), 'SBI-001', /レイヤー.*apps\/api.*apps\/mobile/],
      ['an implementation SBI expects more than 10 changed files without a reason', () => withValidation(sbi('SBI-001', { estimatedFiles: 11 })), 'SBI-001', /11ファイル.*分割/],
      ['an implementation SBI expects more than 10 changed files with a blank reason', () => withValidation(sbi('SBI-001', { estimatedFiles: 11, oversizeReason: ' ' })), 'SBI-001', /11ファイル.*分割/],
      ['an implementation SBI expects no changed file', () => withValidation(sbi('SBI-001', { estimatedFiles: 0 })), 'SBI-001', /変更ファイル数/],
      ['the application test is lint only', () => withValidation(sbi('SBI-001', { verification: verification('lint') })), 'SBI-001', /実テスト/],
      ['the application test is lint and typecheck only', () => withValidation(sbi('SBI-001', { verification: verification('eslint / tsc --noEmit のみ') })), 'SBI-001', /実テスト/],
      ['the application test is 型チェック only', () => withValidation(sbi('SBI-001', { verification: verification('型チェックと静的解析だけ') })), 'SBI-001', /実テスト/],
      ['the application test is declared unnecessary', () => withValidation(sbi('SBI-001', { verification: verification('不要') })), 'SBI-001', /実テスト/],
      ['the application test says no test is needed', () => withValidation(sbi('SBI-001', { verification: verification('テスト不要（lintのみ）') })), 'SBI-001', /実テスト/],
      ['an implementation scenario names no test', () => withValidation(sbi('SBI-001', { scenarios: sbi('SBI-001').scenarios.map((s, i) => ({ ...s, test: i ? s.test : ' ' })) })), 'SBI-001', /Scenario「登録済みプロフィールを表示する」.*実テスト/],
      ['an implementation scenario is verified by typecheck only', () => withValidation(sbi('SBI-001', { scenarios: sbi('SBI-001').scenarios.map(s => ({ ...s, test: 'typecheck' })) })), 'SBI-001', /Scenario「未登録プロフィールを表示する」.*実テスト/],
      ['the validation SBI has no E2E', () => { const plan = withValidation(sbi('SBI-001')); plan[1].verification = { applicationTest: '不要', acceptance: 'Trusted Acceptance', e2e: '不要' }; return plan; }, 'SBI-901', /E2E/],
    ];
    for (const [condition, candidates, target, reason] of granularityFailures) {
      it(`when ${condition} then fails with the reason`, () => {
        const result = judgePlan(candidates());
        assert.equal(result.status, 'FAIL');
        assert.ok(result.findings.some(f => f.sbi === target && reason.test(f.reason)), JSON.stringify(result.findings));
      });
    }
    it('when dependencies form a cycle then fails naming the cycle', () => {
      const result = judgePlan([sbi('SBI-001', { dependsOn: ['SBI-002'] }), sbi('SBI-002', { dependsOn: ['SBI-001'] })]);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.findings.some(f => /循環/.test(f.reason) && /SBI-001/.test(f.reason)));
    });
  });
});

describe('Changed file count after implementation', () => {
  describe('given the number of files an SBI expected to change and the files its PR changed', () => {
    const changed = count => Array.from({ length: count }, (_, i) => `apps/mobile/src/file-${i}.ts`);
    it('when the PR stays within 10 files then passes even if it exceeds the estimate', () => {
      assert.equal(judgeChangedFileCount({ estimatedFiles: 3, changedPaths: changed(10) }).status, 'PASS');
    });
    it('when the PR stays within an estimate above 10 that the Planner justified then passes', () => {
      assert.equal(judgeChangedFileCount({ estimatedFiles: 14, changedPaths: changed(14) }).status, 'PASS');
    });
    it('when the PR exceeds both 10 files and the estimate then fails naming both numbers', () => {
      const result = judgeChangedFileCount({ estimatedFiles: 4, changedPaths: changed(11) });
      assert.equal(result.status, 'FAIL');
      assert.match(result.reason, /11ファイル/);
      assert.match(result.reason, /想定4ファイル/);
    });
    it('when the same path is listed twice then counts it once', () => {
      assert.equal(judgeChangedFileCount({ estimatedFiles: 4, changedPaths: [...changed(10), 'apps/mobile/src/file-0.ts'] }).status, 'PASS');
    });
    it('when the estimate is missing then fails closed instead of assuming any size is fine', () => {
      assert.equal(judgeChangedFileCount({ estimatedFiles: undefined, changedPaths: changed(1) }).status, 'FAIL');
    });
  });
});
