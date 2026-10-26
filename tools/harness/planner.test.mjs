import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './test-fixture.mjs';
import { exists, readJson } from './io.mjs';
import { parseIssueUrl, planIssue, renderCreatedList } from './planner.mjs';
import { judgePlan, creationOrder } from './planner-judge.mjs';

const pbiUrl = 'https://github.com/acme/app/issues/8';
const pbi = { number: 8, title: '受講生プロフィールを表示する', body: '## 背景\nプロフィールを取得・更新・表示する。', html_url: pbiUrl, state: 'open', labels: [] };

function sbi(id, overrides = {}) {
  return {
    id, title: `${id}の機能`, purpose: `${id}を実現する。`,
    scope: { included: ['apps/mobile プロフィール画面'], excluded: [] },
    acceptanceCriteria: [{ id: 'AC-1', description: '登録済みの氏名が画面に表示される' }, { id: 'AC-2', description: '未登録なら未設定と表示される' }],
    scenarios: [
      { name: '登録済みプロフィールを表示する', given: ['ログイン済みの受講生がいる', 'プロフィールが登録されている'], when: ['プロフィール画面を開く'], then: ['登録済みの氏名が表示される'], acceptanceIds: ['AC-1'] },
      { name: '未登録プロフィールを表示する', given: ['ログイン済みの受講生がいる'], when: ['プロフィール画面を開く'], then: ['未設定と表示される'], acceptanceIds: ['AC-2'] },
    ],
    dependsOn: [], changeAreas: ['apps/mobile'], riskCandidate: 'L2', securityImpact: [],
    verification: { applicationTest: 'RNTL', acceptance: 'Trusted Acceptance', e2e: '不要' },
    ...overrides,
  };
}
const validPlan = () => [sbi('SBI-001'), sbi('SBI-002', { dependsOn: ['SBI-001'] }), sbi('SBI-003', { dependsOn: ['SBI-001', 'SBI-002'] })];
const agentWith = sbis => async () => ({ sbis, escalation: null });
const fakeToken = 'ghp_' + 'k'.repeat(36);

// Stub gh on PATH. It answers `gh api` calls from a state directory and records every call.
async function mockGitHub(state, test) {
  const dir = await mkdtemp(join(tmpdir(), 'harness-gh-'));
  const previous = { PATH: process.env.PATH, GH_MOCK_DIR: process.env.GH_MOCK_DIR, GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY };
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ issue: pbi, labels: [], created: [], comments: [], failOnCreate: null, ...state }));
    await writeFile(join(dir, 'gh'), `#!${process.execPath}
      const fs = require('node:fs'), path = require('node:path');
      const dir = process.env.GH_MOCK_DIR, file = path.join(dir, 'state.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      const args = process.argv.slice(2);
      const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
      fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, input }) + '\\n');
      const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
      const endpoint = args.find(a => a.startsWith('repos/'));
      const fail = (message, code = 1) => { process.stderr.write(message + '\\n'); process.exit(code); };
      if (args[0] !== 'api') fail('unexpected gh command');
      if (state.failOnCreate && method === 'POST' && endpoint === 'repos/acme/app/issues' && state.created.length + 1 === state.failOnCreate) fail('gh: Validation Failed (HTTP 422)');
      let m;
      if (method === 'GET' && (m = endpoint.match(/^repos\\/acme\\/app\\/issues\\/(\\d+)$/))) {
        if (Number(m[1]) !== state.issue.number) fail('gh: Not Found (HTTP 404)');
        process.stdout.write(JSON.stringify(state.issue));
      } else if (method === 'GET' && (m = endpoint.match(/^repos\\/acme\\/app\\/labels\\/(.+)$/))) {
        const name = decodeURIComponent(m[1]);
        if (!state.labels.includes(name)) fail('gh: Not Found (HTTP 404)');
        process.stdout.write(JSON.stringify({ name }));
      } else if (method === 'POST' && endpoint === 'repos/acme/app/labels') {
        const label = JSON.parse(input); state.labels.push(label.name); process.stdout.write(JSON.stringify(label));
      } else if (method === 'POST' && endpoint === 'repos/acme/app/issues') {
        const issue = JSON.parse(input); const number = 101 + state.created.length;
        const created = { number, title: issue.title, body: issue.body, html_url: 'https://github.com/acme/app/issues/' + number, labels: (issue.labels || []).map(name => ({ name })) };
        state.created.push(created); process.stdout.write(JSON.stringify(created));
      } else if (method === 'POST' && (m = endpoint.match(/^repos\\/acme\\/app\\/issues\\/(\\d+)\\/comments$/))) {
        const comment = { issue: Number(m[1]), body: JSON.parse(input).body, html_url: 'https://github.com/acme/app/issues/' + m[1] + '#issuecomment-1' };
        state.comments.push(comment); process.stdout.write(JSON.stringify(comment));
      } else fail('unexpected gh api call: ' + method + ' ' + endpoint);
      fs.writeFileSync(file, JSON.stringify(state));
    `);
    await chmod(join(dir, 'gh'), 0o755);
    process.env.PATH = `${dir}:${previous.PATH}`;
    process.env.GH_MOCK_DIR = dir;
    delete process.env.GITHUB_STEP_SUMMARY;
    const github = {
      state: () => readJson(join(dir, 'state.json')),
      calls: async () => (await exists(join(dir, 'calls.jsonl'))) ? (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : [],
      dir,
    };
    await test(github);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
}
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
        for (const heading of ['## 目的', '## 対象範囲', '## 受け入れ要件', '## Gherkin', '## 依存SBI', '## 想定変更範囲', '## Risk / Security Impact', '## 検証方法', '## 元PBI']) assert.ok(issue.body.includes(heading), `${issue.title} lacks ${heading}`);
        assert.match(issue.body, /Scenario: 登録済みプロフィールを表示する\n\s+Given ログイン済みの受講生がいる\n\s+And プロフィールが登録されている\n\s+When プロフィール画面を開く\n\s+Then 登録済みの氏名が表示される/);
        assert.match(issue.body, /- \[ \] AC-1: 登録済みの氏名が画面に表示される/);
        assert.match(issue.body, /Risk: L2 candidate\nSecurity: None/);
        assert.match(issue.body, /Application Test: RNTL\n受け入れ要件: Trusted Acceptance\nE2E: 不要/);
      }
      assert.match(state.created[0].body, /## 依存SBI\n\nなし/);
      assert.match(state.created[2].body, /- SBI-001 \(#101\)\n- SBI-002 \(#102\)/);
      assert.deepEqual(result.created.map(c => [c.sbiId, c.number, c.url]), [['SBI-001', 101, 'https://github.com/acme/app/issues/101'], ['SBI-002', 102, 'https://github.com/acme/app/issues/102'], ['SBI-003', 103, 'https://github.com/acme/app/issues/103']]);
      assert.deepEqual(state.labels.sort(), ['needs-review', 'sbi']);
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
    it('when the provider is fake then refuses to publish to GitHub', () => fixture(root => mockGitHub({}, async github => {
      await assert.rejects(plan(root, { provider: 'fake' }), /provider/);
      assert.deepEqual(await github.calls(), []);
    })));
    it('when the quality judge fails then creates no Issue and reports every reason', () => fixture(root => mockGitHub({}, async github => {
      const broken = [sbi('SBI-001', { scenarios: [], dependsOn: ['SBI-002'] }), sbi('SBI-002', { dependsOn: ['SBI-001'], changeAreas: [] })];
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
  });
});

describe('SBI Quality Judge', () => {
  describe('given SBI candidates generated from a PBI', () => {
    it('when every SBI is small, verifiable and acyclic then passes', () => {
      assert.deepEqual(judgePlan(validPlan()), { status: 'PASS', findings: [] });
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
    it('when two SBIs share an ID then fails with the duplicate', () => {
      const result = judgePlan([sbi('SBI-001'), sbi('SBI-001')]);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.findings.some(f => /重複/.test(f.reason)));
    });
    it('when dependencies form a cycle then fails naming the cycle', () => {
      const result = judgePlan([sbi('SBI-001', { dependsOn: ['SBI-002'] }), sbi('SBI-002', { dependsOn: ['SBI-001'] })]);
      assert.equal(result.status, 'FAIL');
      assert.ok(result.findings.some(f => /循環/.test(f.reason) && /SBI-001/.test(f.reason)));
    });
  });
});
