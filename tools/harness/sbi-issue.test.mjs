import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSbiBody } from './planner.mjs';
import { sbiSchema } from './schemas.mjs';
import { issueReadiness, sbiFromIssue, inScope, loadSbiIssue } from './sbi-issue.mjs';

const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
const pbi = { owner: 'acme', repo: 'app', number: 3, url: 'https://github.com/acme/app/issues/3', title: '管理画面のホーム' };
const planned = (overrides = {}) => ({
  id: 'SBI-001', title: 'ホームに見出しを表示する', purpose: '管理者がホームを開くと見出しが表示される。',
  scope: { included: ['apps/admin ホーム画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: 'ホームに見出しが表示される' }, { id: 'AC-2', description: '見出しの文言が仕様どおりである' }],
  scenarios: [{ name: 'ホームを開く', given: ['管理者がログインしている'], when: ['ホームを開く'], then: ['見出しが表示される'], acceptanceIds: ['AC-1', 'AC-2'] }],
  dependsOn: [], changeAreas: ['apps/admin'], riskCandidate: 'L2', securityImpact: [],
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

// A Rails or frontend SBI depends on the OpenAPI Schema SBI. Its Harness PR closes the Schema SBI Issue when it is merged,
// so an open (or abandoned) dependency means the canonical openapi.yaml is not on main yet.
describe('Dependencies of a ready SBI Issue', () => {
  const schema = { number: 6, title: 'SBI-001 OpenAPI Schemaを作る', html_url: 'https://github.com/acme/app/issues/6', labels: labels('sbi', 'ready') };
  const dependent = planned({ id: 'SBI-002', dependsOn: ['SBI-001'] });
  const body = (numbers = { 'SBI-001': 6 }) => renderSbiBody(dependent, pbi, numbers);
  const github = (dependency, own = issue({ body: body() }, dependent)) => ({ fetchIssue: async ({ number }) => {
    if (number === 7) return own;
    if (number === 6 && dependency) return dependency;
    throw new Error('gh: Not Found (HTTP 404)');
  } });
  const load = gh => loadSbiIssue({ issueUrl: ref.url, config: config(), github: gh });
  it('when the dependency Issue was closed as completed then the run may start', async () => {
    assert.equal((await load(github({ ...schema, state: 'closed', state_reason: 'completed' }))).sbi.id, 'ISSUE-7');
  });
  it('when the dependency Issue is still open because its Schema PR is not merged then refuses to start', async () => {
    await assert.rejects(load(github({ ...schema, state: 'open' })), /#6/);
  });
  it('when the dependency Issue was closed as not planned then refuses to start', async () => {
    await assert.rejects(load(github({ ...schema, state: 'closed', state_reason: 'not_planned' })), /#6/);
  });
  it('when the dependency Issue cannot be read then refuses to start', async () => {
    await assert.rejects(load(github(null)), /#6/);
  });
  it('when a dependency is listed without its Issue number then refuses to start', async () => {
    await assert.rejects(load(github(null, issue({ body: body({}) }, dependent))), /SBI-001/);
  });
});
