import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSbiBody } from './planner.mjs';
import { sbiSchema } from './schemas.mjs';
import { issueReadiness, sbiFromIssue, inScope, loadSbiIssue } from './sbi-issue.mjs';

const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
const pbi = { owner: 'acme', repo: 'app', number: 3, url: 'https://github.com/acme/app/issues/3', title: '管理画面のホーム' };
const planned = (overrides = {}) => ({
  id: 'SBI-001', kind: 'implementation', title: 'ホームに見出しを表示する', purpose: '管理者がホームを開くと見出しが表示される。',
  scope: { included: ['apps/admin ホーム画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: 'ホームに見出しが表示される' }, { id: 'AC-2', description: '見出しの文言が仕様どおりである' }],
  scenarios: [{ name: 'ホームを開く', given: ['管理者がログインしている'], when: ['ホームを開く'], then: ['見出しが表示される'], acceptanceIds: ['AC-1', 'AC-2'], test: 'Vitest: apps/admin/src/features/home/index.test.tsx' }],
  dependsOn: [], changeAreas: ['apps/admin'], layers: ['画面Component'], estimatedFiles: 2, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'Vitest', acceptance: 'Trusted Acceptance', e2e: '不要' },
  ...overrides,
});
const labels = (...names) => names.map(name => ({ name }));
const issue = (overrides = {}, sbi = planned()) => ({ number: 7, title: `${sbi.id} ${sbi.title}`, body: renderSbiBody(sbi, pbi), html_url: ref.url, state: 'open', labels: labels('sbi', 'ready'), ...overrides });
// Trusted Acceptance a human wrote and registered for SBI Issue #7 before marking it ready.
const acceptance = (overrides = {}) => ({ id: 'issue-7-acceptance', trust: 'acceptance', trustedScript: '.harness/verification/issue-7.mjs', directory: '.', planned: ['ホーム見出し'], commands: [], acceptanceIds: ['AC-1', 'AC-2'], sbiIssue: 7, ...overrides });
const config = (...verifiers) => ({ verifiers: verifiers.length ? verifiers : [acceptance()] });

describe('SBI Issue readiness', () => {
  describe('given the GitHub Issue that harness:run received', () => {
    it('when it is open with sbi and ready and without needs-review then nothing blocks it', () => {
      assert.deepEqual(issueReadiness(issue(), ref.url), []);
    });
    for (const [name, overrides, pattern] of [
      ['a pull request', { pull_request: { url: 'x' } }, /pull request/],
      ['closed', { state: 'closed' }, /not open/],
      ['an ordinary Issue without the sbi label', { labels: labels('ready') }, /no sbi label/],
      ['still needs-review', { labels: labels('sbi', 'needs-review') }, /no ready label/],
      ['ready but still needs-review', { labels: labels('sbi', 'ready', 'needs-review') }, /needs-review/],
      ['without the Planner marker', { body: '## 目的\n\n手で書いたIssue' }, /marker/],
    ]) {
      it(`when it is ${name} then it cannot start a run`, () => {
        assert.match(issueReadiness(issue(overrides), ref.url).join('\n'), pattern);
      });
    }
  });
});

describe('Execution SBI from a ready SBI Issue', () => {
  describe('given a Planner-generated Issue whose acceptance criteria have registered Trusted Acceptance', () => {
    it('when it is read then the SBI carries the Issue title, purpose, Gherkin, acceptance verifiers and source URL in a valid schema', () => {
      const sbi = sbiFromIssue({ ref, issue: issue(), config: config() });
      assert.equal(sbiSchema.safeParse(sbi).success, true);
      assert.equal(sbi.title, 'SBI-001 ホームに見出しを表示する');
      assert.equal(sbi.description, '管理者がホームを開くと見出しが表示される。');
      assert.match(sbi.gherkin, /^Feature: SBI-001 ホームに見出しを表示する\n {2}Scenario: ホームを開く\n {4}Given 管理者がログインしている/);
      assert.deepEqual(sbi.acceptanceCriteria, [
        { id: 'AC-1', description: 'ホームに見出しが表示される', verifier: 'issue-7-acceptance' },
        { id: 'AC-2', description: '見出しの文言が仕様どおりである', verifier: 'issue-7-acceptance' },
      ]);
      assert.equal(sbi.issueUrl, ref.url);
      assert.deepEqual([sbi.risks, sbi.securityImpact, sbi.minimumRiskLevel], [[], [], 2]);
    });
    it('when it is read then the SBI keeps the URL of its PBI from the Planner marker so the PR can link it', () => {
      assert.equal(sbiFromIssue({ ref, issue: issue(), config: config() }).pbiUrl, pbi.url);
    });
    it('when it is read then the change areas become directory scopes and no file is allowed by name', () => {
      const sbi = sbiFromIssue({ ref, issue: issue({}, planned({ changeAreas: ['apps/admin', 'packages/ui/'] })), config: config() });
      assert.deepEqual(sbi.allowedDirs, ['apps/admin/', 'packages/ui/']);
      assert.deepEqual(sbi.allowedFiles, []);
    });
    it('when the Issue declares a security impact then the SBI keeps it as a risk at LEVEL 3', () => {
      const sbi = sbiFromIssue({ ref, issue: issue({}, planned({ securityImpact: ['PII'], riskCandidate: 'L3' })), config: config() });
      assert.deepEqual([sbi.risks, sbi.securityImpact, sbi.minimumRiskLevel], [['PII'], ['PII'], 3]);
    });
    it('when a reviewer checked an acceptance criterion box then it is still read', () => {
      const edited = issue();
      edited.body = edited.body.replace('- [ ] AC-1', '- [x] AC-1');
      assert.equal(sbiFromIssue({ ref, issue: edited, config: config() }).acceptanceCriteria[0].id, 'AC-1');
    });
  });

  describe('given acceptance criteria without exactly one registered Trusted Acceptance', () => {
    it('when an acceptance criterion is not registered then fails closed and names it', () => {
      assert.throws(() => sbiFromIssue({ ref, issue: issue(), config: config(acceptance({ acceptanceIds: ['AC-1'] })) }), /AC-2/);
    });
    it('when nothing is registered for the Issue then fails closed', () => {
      assert.throws(() => sbiFromIssue({ ref, issue: issue(), config: config(acceptance({ sbiIssue: 8 })) }), /Trusted Acceptance/);
    });
    it('when an application test claims the Issue then it does not count as Trusted Acceptance', () => {
      assert.throws(() => sbiFromIssue({ ref, issue: issue(), config: config(acceptance({ trust: 'application' })) }), /Trusted Acceptance/);
    });
    it('when two Trusted Acceptance verifiers claim the same criterion then fails closed', () => {
      assert.throws(() => sbiFromIssue({ ref, issue: issue(), config: config(acceptance(), acceptance({ id: 'other', acceptanceIds: ['AC-2'] })) }), /AC-2/);
    });
    it('when the registration covers a criterion the Issue no longer has then fails closed instead of ignoring it', () => {
      assert.throws(() => sbiFromIssue({ ref, issue: issue(), config: config(acceptance({ acceptanceIds: ['AC-1', 'AC-2', 'AC-3'] })) }), /AC-3/);
    });
  });

  describe('given a change area that is not a plain directory', () => {
    for (const area of ['apps/*', 'apps/../tools', '/apps/admin', 'apps/admin/**/x', '.harness/state', 'tools/harness', 'apps/admin ホーム', '']) {
      it(`when the change area is ${JSON.stringify(area)} then fails closed`, () => {
        assert.throws(() => sbiFromIssue({ ref, issue: issue({}, planned({ changeAreas: [area] })), config: config() }), /想定変更範囲/);
      });
    }
  });

  describe('given an Issue body without a required section', () => {
    for (const section of ['目的', '受け入れ要件', 'Gherkin', '想定変更範囲', 'Risk / Security Impact']) {
      it(`when ${section} is missing then fails closed`, () => {
        const broken = issue();
        broken.body = broken.body.replace(`## ${section}\n`, '## 削除済み\n');
        assert.throws(() => sbiFromIssue({ ref, issue: broken, config: config() }), new RegExp(section.replace(/[/]/g, '\\/')));
      });
    }
  });

  describe('given the kind and the expected number of changed files the Planner wrote', () => {
    it('when it is read then the SBI carries the expected number of changed files for the Completion Judge', () => {
      assert.equal(sbiFromIssue({ ref, issue: issue(), config: config() }).estimatedFiles, 2);
    });
    it('when the Planner justified more than 10 files then the SBI carries that number', () => {
      const sbi = sbiFromIssue({ ref, issue: issue({}, planned({ estimatedFiles: 14, oversizeReason: '生成コードを含むため分割できない' })), config: config() });
      assert.equal(sbi.estimatedFiles, 14);
    });
    it('when the Issue was planned before the number was written then the SBI is built without it so the Completion Judge fails closed', () => {
      const old = issue();
      old.body = old.body.replace(/## 想定変更ファイル数\n\n2\n\n/, '');
      const sbi = sbiFromIssue({ ref, issue: old, config: config() });
      assert.equal(sbiSchema.safeParse(sbi).success, true);
      assert.equal(sbi.estimatedFiles, null);
    });
    it('when the number is not an integer then the SBI is built without it', () => {
      const edited = issue();
      edited.body = edited.body.replace(/## 想定変更ファイル数\n\n2\n/, '## 想定変更ファイル数\n\n2〜3\n');
      assert.equal(sbiFromIssue({ ref, issue: edited, config: config() }).estimatedFiles, null);
    });
    it('when it is a validation SBI then the SBI keeps that kind', () => {
      assert.equal(sbiFromIssue({ ref, issue: issue({}, planned({ kind: 'validation' })), config: config() }).kind, 'validation');
    });
    it('when it is an implementation SBI then the SBI keeps that kind', () => {
      assert.equal(sbiFromIssue({ ref, issue: issue(), config: config() }).kind, 'implementation');
    });
  });
});

describe('Scope of an execution SBI', () => {
  const sbi = { allowedFiles: ['greeting.mjs', 'apps/api'], allowedDirs: ['apps/admin/'] };
  describe('given a directory scope', () => {
    it('when a file is below the directory then it is in scope', () => {
      assert.equal(inScope(sbi, 'apps/admin/src/features/home/index.tsx'), true);
    });
    it('when a sibling directory shares the prefix then it is out of scope', () => {
      assert.equal(inScope(sbi, 'apps/admin-other/index.ts'), false);
    });
    it('when the path is the directory itself then it is out of scope', () => {
      assert.equal(inScope(sbi, 'apps/admin'), false);
    });
    for (const path of ['apps/admin/../api/app.rb', 'apps/admin/./x.ts', '/apps/admin/x.ts', 'apps/admin//x.ts', 'apps\\admin\\x.ts']) {
      it(`when the path ${JSON.stringify(path)} is not normalized then it is out of scope`, () => {
        assert.equal(inScope(sbi, path), false);
      });
    }
    for (const path of ['apps/admin/node_modules/x/index.js', 'apps/admin/.env', 'apps/admin/AGENTS.md', 'apps/admin/.harness/x.json']) {
      it(`when ${path} is a reserved path inside the directory then it is still out of scope`, () => {
        assert.equal(inScope(sbi, path), false);
      });
    }
  });
  describe('given file scopes', () => {
    it('when the path is a listed file then it is in scope', () => {
      assert.equal(inScope(sbi, 'greeting.mjs'), true);
    });
    it('when a listed file name is a directory then files below it are not allowed implicitly', () => {
      assert.equal(inScope(sbi, 'apps/api/app.rb'), false);
    });
  });
  describe('given the SBI schema', () => {
    const base = { id: 'SBI-1', title: 't', description: 'd', gherkin: 'Feature: f\n  Scenario: s\n    Given g\n    When w\n    Then t',
      acceptanceCriteria: [{ id: 'AC-1', description: 'd', verifier: 'v' }], risks: [], ambiguous: false, requiresDesignDecision: false };
    it('when a directory scope ends with a slash then the schema accepts it without any file scope', () => {
      assert.equal(sbiSchema.safeParse({ ...base, allowedFiles: [], allowedDirs: ['apps/admin/'] }).success, true);
    });
    it('when a directory scope has no trailing slash then the schema rejects it so it cannot be mistaken for a file', () => {
      assert.equal(sbiSchema.safeParse({ ...base, allowedFiles: [], allowedDirs: ['apps/admin'] }).success, false);
    });
    it('when neither files nor directories are allowed then the schema rejects it', () => {
      assert.equal(sbiSchema.safeParse({ ...base, allowedFiles: [], allowedDirs: [] }).success, false);
    });
  });
});

// A Rails or frontend SBI depends on the OpenAPI Schema SBI. Only a merged Harness PR of that SBI puts the canonical openapi.yaml on main,
// so the dependency is done when GitHub shows such a PR, not when someone closes its Issue.
// #194: ready approves the Issue as it was when the label was added. GitHub dates the labeled event and every edit of the body.
const readyAt = '2026-10-30T10:00:00Z';
const readyEvent = { event: 'labeled', label: { name: 'ready' }, created_at: readyAt };
describe('Starting a run from an SBI Issue a human marked ready', () => {
  const github = ({ own = issue(), timeline = [readyEvent], edits = [] } = {}) => ({ fetchIssue: async () => own, issueTimeline: async () => timeline, bodyEdits: async () => edits });
  const load = gh => loadSbiIssue({ issueUrl: ref.url, config: config(), github: gh });
  // A version GitHub keeps in the edit history; the newest one is the current body.
  const editedAt = editedAt => ({ editedAt, deletedAt: null, body: issue().body });
  describe('given the Issue as it was approved', () => {
    it('when nothing was edited after ready was added then the run starts from the approved content', async () => {
      const loaded = await load(github());
      assert.equal(loaded.mode, 'registered');
      assert.equal(loaded.sbi.description, planned().purpose);
    });
  });
  describe('given an edit after ready was added', () => {
    it('when the body was edited after the approval then the run does not start and the human has to approve the Issue again', async () => {
      const edited = issue({ body: renderSbiBody(planned({ purpose: '管理者がホームを開くと設定画面へ移動する。' }), pbi) });
      await assert.rejects(load(github({ own: edited, edits: [editedAt('2026-10-30T11:00:00Z')] })), /readyではありません[\s\S]*edited after ready/);
    });
    it('when the body went from A to B and back to A after the approval then the run still does not start, since nobody approved it again', async () => {
      await assert.rejects(load(github({ edits: [editedAt('2026-10-30T11:00:00Z'), editedAt('2026-10-30T12:00:00Z')] })), /readyではありません[\s\S]*edited after ready/);
    });
    it('when the title was changed after the approval then the run does not start', async () => {
      await assert.rejects(load(github({ own: issue({ title: 'SBI-001 全ユーザーの一覧を表示する' }), timeline: [readyEvent, { event: 'renamed', created_at: '2026-10-30T11:00:00Z' }] })), /readyではありません[\s\S]*title/);
    });
    it('when ready was removed and added again after the edits then the run starts from the content approved again', async () => {
      const timeline = [readyEvent, { event: 'unlabeled', label: { name: 'ready' }, created_at: '2026-10-30T12:30:00Z' }, { ...readyEvent, created_at: '2026-10-30T13:00:00Z' }];
      assert.equal((await load(github({ timeline, edits: [editedAt('2026-10-30T11:00:00Z'), editedAt('2026-10-30T12:00:00Z')] }))).mode, 'registered');
    });
  });
  describe('given GitHub cannot show when ready was added', () => {
    it('when the edit history cannot be read then the run does not start', async () => {
      await assert.rejects(load({ ...github(), bodyEdits: async () => { throw new Error('GraphQL: edit history of acme/app#7 is unavailable'); } }), /readyではありません[\s\S]*edit history/);
    });
  });
});

describe('Dependencies of a ready SBI Issue', () => {
  const schemaUrl = 'https://github.com/acme/app/issues/6';
  const schema = { number: 6, title: 'SBI-001 OpenAPI Schemaを作る', html_url: schemaUrl, labels: labels('sbi', 'ready') };
  const closed = { ...schema, state: 'closed', state_reason: 'completed' };
  const dependent = planned({ id: 'SBI-002', dependsOn: ['SBI-001'] });
  const body = (numbers = { 'SBI-001': 6 }) => renderSbiBody(dependent, pbi, numbers);
  // The Harness PR of the Schema SBI: merged into main, Closes #6 in its body and SBI-Issue: <Issue #6> in its commit trailers.
  const harnessPull = (overrides = {}) => ({ number: 21, html_url: 'https://github.com/acme/app/pull/21', merged_at: '2026-10-01T00:00:00Z', base: { ref: 'main' },
    body: '## SBI\n- ISSUE-6: OpenAPI Schemaを作る\n\nCloses #6\n', commits: [`Implement ISSUE-6\n\nHarness-Run: r1\nSBI-Issue: ${schemaUrl}`], ...overrides });
  const github = (dependency, { pulls = [], own = issue({ body: body() }, dependent), timelineFails = false } = {}) => ({
    fetchIssue: async ({ number }) => {
      if (number === 7) return own;
      if (number === 6 && dependency) return dependency;
      throw new Error('gh: Not Found (HTTP 404)');
    },
    // #194: the dependent Issue #7 was marked ready and left unedited, so only the dependency decides.
    issueTimeline: async ({ number }) => {
      if (number === 7) return [readyEvent];
      if (timelineFails) throw new Error('gh: Server Error (HTTP 502)');
      return number === 6 ? pulls.map(p => ({ event: 'cross-referenced', source: { type: 'issue', issue: { number: p.number, html_url: p.html_url, pull_request: { url: `https://api.github.com/repos/acme/app/pulls/${p.number}` } } } })) : [];
    },
    bodyEdits: async () => [],
    fetchPull: async (_, number) => { const pull = pulls.find(p => p.number === number); if (!pull) throw new Error('gh: Not Found (HTTP 404)'); return pull; },
    pullCommitMessages: async (_, number) => pulls.find(p => p.number === number).commits,
  });
  const load = gh => loadSbiIssue({ issueUrl: ref.url, config: config(), github: gh });
  it('when the Harness PR of the dependency was merged into main then the run may start', async () => {
    assert.equal((await load(github(closed, { pulls: [harnessPull()] }))).sbi.id, 'ISSUE-7');
  });
  it('when the dependency Issue was closed as completed by hand and no PR was merged then refuses to start', async () => {
    await assert.rejects(load(github(closed)), /#6.*merge/);
  });
  it('when the PR that closes the dependency was closed without merging then refuses to start', async () => {
    await assert.rejects(load(github(closed, { pulls: [harnessPull({ merged_at: null })] })), /#6/);
  });
  it('when the merged PR targets another base branch than main then refuses to start', async () => {
    await assert.rejects(load(github(closed, { pulls: [harnessPull({ base: { ref: 'develop' } })] })), /#6/);
  });
  it('when the merged PR says Closes #6 but no commit carries SBI-Issue for #6, so the Harness did not make it, then refuses to start', async () => {
    await assert.rejects(load(github(closed, { pulls: [harnessPull({ commits: ['fix typo'] })] })), /#6/);
  });
  it('when the merged Harness PR of another SBI only mentions the dependency then refuses to start', async () => {
    await assert.rejects(load(github(closed, { pulls: [harnessPull({ body: 'See #6\n' })] })), /#6/);
  });
  it('when the PRs of the dependency cannot be read from GitHub then refuses to start', async () => {
    await assert.rejects(load(github(closed, { pulls: [harnessPull()], timelineFails: true })), /#6/);
  });
  it('when the dependency Issue is still open because its Schema PR is not merged then refuses to start', async () => {
    await assert.rejects(load(github({ ...schema, state: 'open' }, { pulls: [harnessPull({ merged_at: null })] })), /#6/);
  });
  it('when the dependency Issue was closed as not planned then refuses to start even with a merged PR', async () => {
    await assert.rejects(load(github({ ...schema, state: 'closed', state_reason: 'not_planned' }, { pulls: [harnessPull()] })), /#6/);
  });
  it('when the dependency Issue cannot be read then refuses to start', async () => {
    await assert.rejects(load(github(null)), /#6/);
  });
  it('when a dependency is listed without its Issue number then refuses to start', async () => {
    await assert.rejects(load(github(null, { own: issue({ body: body({}) }, dependent) })), /SBI-001/);
  });
});
