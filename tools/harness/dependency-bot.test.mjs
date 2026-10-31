import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './test-fixture.mjs';
import { git } from './workspace.mjs';
import { judgeDependencyBot, dependencyBotExemption } from './dependency-bot.mjs';
import { runCompletionJudge } from './impact.mjs';
import { describeSbiSource } from './sbi-source.mjs';
import { dependencyBotPolicySchema } from './schemas.mjs';

const policy = dependencyBotPolicySchema.parse(JSON.parse(await readFile(new URL('../../.harness/rules/dependency-bots.json', import.meta.url), 'utf8')));
const repository = 'acme/app';
const headSha = 'a'.repeat(40);
const bot = { login: 'renovate[bot]', type: 'Bot' };
const pull = (overrides = {}) => ({ number: 42, merged_at: null, base: { ref: 'main' }, body: null, user: bot, head: { ref: 'dependabot/npm_and_yarn/zod-4.1.0', sha: headSha, repo: { full_name: repository } }, ...overrides });
const commit = (overrides = {}) => ({ commit: { message: 'chore(deps): update vite', verification: { verified: true } }, author: { login: 'renovate[bot]' }, ...overrides });
const lockfiles = [{ path: 'apps/admin/package.json' }, { path: 'pnpm-lock.yaml' }];
const judge = (overrides = {}) => judgeDependencyBot({ policy, files: lockfiles, pull: pull(), commits: [commit()], headSha, repository, ...overrides });

describe('Trusted dependency bot policy', () => {
  describe('given the shipped rule', () => {
    it('when it is read then only Renovate is trusted, as a GitHub App bot account', () => {
      assert.deepEqual(policy.bots, [{ login: 'renovate[bot]', type: 'Bot' }]);
    });
    it('when it is read then only the Admin and Rails API dependency manifests and lockfiles are allowed', () => {
      assert.deepEqual([...policy.paths].sort(), ['apps/admin/package.json', 'apps/api/Gemfile', 'apps/api/Gemfile.lock', 'pnpm-lock.yaml']);
    });
  });
});

describe('SBI source exemption of a trusted dependency bot PR', () => {
  describe('given a PR that Renovate opened and committed and that changes only allowed dependency files', () => {
    it('when judged then the SBI source requirement is exempted', () => {
      assert.deepEqual(judge(), { exempt: true, bot: 'renovate[bot]', reasons: [] });
    });
    it('when Gemfile and Gemfile.lock are updated then the SBI source requirement is exempted', () => {
      assert.equal(judge({ files: [{ path: 'apps/api/Gemfile' }, { path: 'apps/api/Gemfile.lock' }] }).exempt, true);
    });
  });
  describe('given a PR that is not fully a trusted bot dependency update', () => {
    for (const [name, overrides, pattern] of [
      ['changes one file outside the allowed dependency files', { files: [...lockfiles, { path: 'apps/admin/src/main.tsx' }] }, /apps\/admin\/src\/main\.tsx/],
      ['changes nothing', { files: [] }, /no changed file/],
      ['was opened by a human with the same change', { pull: pull({ user: { login: 'alice', type: 'User' } }) }, /alice/],
      ['was opened by an account named renovate[bot] that is not a Bot', { pull: pull({ user: { login: 'renovate[bot]', type: 'User' } }) }, /type User/],
      ['was opened by another bot', { pull: pull({ user: { login: 'dependabot[bot]', type: 'Bot' } }) }, /dependabot\[bot\]/],
      ['has a commit a human pushed onto the bot branch', { commits: [commit(), commit({ author: { login: 'alice' } })] }, /alice/],
      ['has a commit whose author is not linked to any GitHub account', { commits: [commit({ author: null })] }, /author/],
      ['has a bot-authored commit GitHub did not verify', { commits: [commit({ commit: { message: 'x', verification: { verified: false } } })] }, /not verified/],
      ['has no commit', { commits: [] }, /no commit/],
      ['was judged on a different head than GitHub reports', { headSha: 'b'.repeat(40) }, /head/],
      ['comes from a fork', { pull: pull({ head: { sha: headSha, repo: { full_name: 'mallory/app' } } }) }, /mallory\/app/],
      ['comes from a deleted fork', { pull: pull({ head: { sha: headSha, repo: null } }) }, /fork/],
    ]) {
      it(`when it ${name} then it is not exempted and names the reason`, () => {
        const result = judge(overrides);
        assert.equal(result.exempt, false);
        assert.match(result.reasons.join('\n'), pattern);
      });
    }
  });
});

describe('Reading the dependency bot PR from GitHub', () => {
  const github = (overrides = {}) => ({ fetchPull: async () => pull(), pullCommits: async () => [commit()], ...overrides });
  const read = (overrides = {}) => dependencyBotExemption({ policy, files: lockfiles, headSha, repository, pullNumber: '42', github: github(), ...overrides });
  describe('given the PR number CI passes', () => {
    it('when GitHub returns the bot PR and its commits then the exemption is read from them', async () => {
      assert.equal((await read()).exempt, true);
    });
    for (const [name, overrides, pattern] of [
      ['is missing', { pullNumber: undefined }, /pull request number/],
      ['is not a number', { pullNumber: '42; rm' }, /pull request number/],
      ['cannot be read from GitHub', { github: github({ fetchPull: async () => { throw new Error('HTTP 502'); } }) }, /HTTP 502/],
      ['has commits GitHub cannot list', { github: github({ pullCommits: async () => { throw new Error('HTTP 403'); } }) }, /HTTP 403/],
      ['has no repository to match', { repository: undefined }, /GITHUB_REPOSITORY/],
    ]) {
      it(`when it ${name} then it fails closed without an exemption`, async () => {
        const result = await read(overrides);
        assert.equal(result.exempt, false);
        assert.match(result.reasons.join('\n'), pattern);
      });
    }
  });
});

describe('CI Completion Judge for a trusted dependency bot PR', () => {
  const needs = { impact: { result: 'success' }, verifiers: { result: 'success' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };
  // A base commit, then the PR commit that updates the given files.
  const pullRequest = async (root, entries) => {
    await git(root, ['branch', 'base']);
    for (const [path, content] of Object.entries(entries)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await git(root, ['add', '--all']);
    await git(root, ['commit', '-m', 'chore(deps): update vite']);
    return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  };
  const github = sha => ({
    fetchPull: async () => pull({ head: { ref: 'dependabot/npm_and_yarn/zod-4.1.0', sha, repo: { full_name: repository } } }),
    pullCommits: async () => [commit()],
    fetchIssue: async () => { throw new Error('no SBI Issue is read'); },
  });
  const run = (root, sha, extra = {}) => runCompletionJudge({ root, base: 'base', needs, repository, pullNumber: '42', github: github(sha), ...extra });
  const bump = async (root, extra = {}) => {
    const lock = await readFile(join(root, 'apps/admin/package.json'), 'utf8');
    return pullRequest(root, { 'apps/admin/package.json': lock.replace(/\n}\s*$/, ',\n  "x-renovate": "bump"\n}\n'), ...extra });
  };

  describe('given Renovate updated only the Admin dependency manifest', () => {
    it('when judged then no SBI source is required, the exemption is logged and the Judge passes', () => fixture(async root => {
      const sha = await bump(root);
      const judged = await run(root, sha);
      assert.equal(judged.impact.sbiRequired, true);
      assert.equal(judged.source.status, 'PASS');
      assert.deepEqual(judged.source.exemption, { exempt: true, bot: 'renovate[bot]', reasons: [] });
      assert.ok(describeSbiSource(judged.source).some(line => /exempt.*renovate\[bot\]/.test(line)), describeSbiSource(judged.source).join('\n'));
      assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
    }));
    it('when the required Admin verifier failed in the matrix job then the Judge still fails', () => fixture(async root => {
      const sha = await bump(root);
      const judged = await run(root, sha, { needs: { ...needs, verifiers: { result: 'failure' } } });
      assert.ok(judged.impact.requiredVerifiers.length > 0);
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.includes('verifiers: failure'));
    }));
    it('when a secret is added to the manifest then Security still fails', () => fixture(async root => {
      const sha = await bump(root, { 'pnpm-lock.yaml': `token: ghp_${'a'.repeat(36)}\n` });
      const judged = await run(root, sha);
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.startsWith('security:')), judged.reasons.join('; '));
    }));
  });
  describe('given Renovate also changed application code', () => {
    it('when judged then the SBI source is required and the Judge fails', () => fixture(async root => {
      const sha = await bump(root, { 'apps/admin/src/renovate.ts': 'export const x = 1;\n' });
      const judged = await run(root, sha);
      assert.equal(judged.source.status, 'FAIL');
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.startsWith('sbi source missing')), judged.reasons.join('; '));
    }));
  });
  describe('given a human opened the same dependency update', () => {
    it('when judged then the SBI source is required and the Judge fails', () => fixture(async root => {
      const sha = await bump(root);
      const human = { ...github(sha), fetchPull: async () => pull({ user: { login: 'alice', type: 'User' }, head: { ref: 'alice/update-zod', sha, repo: { full_name: repository } } }) };
      const judged = await run(root, sha, { github: human });
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.startsWith('sbi source missing')), judged.reasons.join('; '));
    }));
  });
});

describe('Renovate configuration for the exemption', () => {
  it('when renovate.json is read then commits go through the GitHub API so GitHub signs them', async () => {
    const renovate = JSON.parse(await readFile(new URL('../../renovate.json', import.meta.url), 'utf8'));
    assert.equal(renovate.platformCommit, 'enabled');
  });
});
