import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from './workspace.mjs';
import { judgeEngineeringIssue, verifyEngineeringSource } from './engineering-source.mjs';
import { describeSbiSource } from './sbi-source.mjs';

const url = 'https://github.com/acme/app/issues/123';
const labels = (...names) => names.map(name => ({ name }));
// A human marked this Issue as an engineering change and as ready; neither label can be set from a PR body or a commit.
const issue = (overrides = {}) => ({
  number: 123,
  title: 'Sparkle Designを導入する',
  body: '## 背景\n技術基盤を更新する。\n',
  html_url: url,
  state: 'open',
  labels: labels('engineering', 'ready'),
  ...overrides,
});

async function repository(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-engineering-source-')));
  try {
    await git(root, ['init', '--template=', '--initial-branch=main']);
    await git(root, ['config', 'gc.auto', '0']);
    await git(root, ['commit', '--allow-empty', '-m', 'base']);
    await git(root, ['branch', 'base']);
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}

const commit = (root, message) => git(root, ['commit', '--allow-empty', '-m', message]);
const linked = `chore: adopt design system\n\nEngineering-Issue: ${url}`;
const verify = (root, fetchIssue = async () => issue()) => verifyEngineeringSource({
  root,
  base: 'base',
  required: ['production:apps/admin/package.json'],
  repository: 'acme/app',
  github: { fetchIssue },
});
const judge = overrides => judgeEngineeringIssue({ issue: issue(overrides), url, repository: 'acme/app' });

describe('Engineering Issue as the source of a Production change', () => {
  describe('given one commit trailer linking a ready engineering Issue of this repository', () => {
    it('when verified then passes and records the Issue', () => repository(async root => {
      await commit(root, linked);
      const source = await verify(root);
      assert.equal(source.status, 'PASS', source.reasons.join('; '));
      assert.equal(source.kind, 'engineering');
      assert.deepEqual(source.sources, [{ url }]);
    }));

    it('when the same Issue is linked from several commits then still counts it once and passes', () => repository(async root => {
      await commit(root, linked);
      await commit(root, `chore: storybook\n\nEngineering-Issue: ${url}`);
      const source = await verify(root);
      assert.equal(source.status, 'PASS', source.reasons.join('; '));
    }));
  });

  describe('given no Engineering-Issue trailer', () => {
    it('when the commit message only claims an engineering change then fails because nothing links an Issue', () => repository(async root => {
      await commit(root, 'chore: engineering change (no SBI needed)\n\nType: engineering');
      const source = await verify(root, async () => { throw new Error('must not be read'); });
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.startsWith('production source missing') && r.includes('Engineering-Issue')), source.reasons.join('; '));
    }));
  });

  describe('given an Issue that a human has not approved as a ready engineering change', () => {
    for (const [name, overrides, reason] of [
      ['has only a self-declared engineering section in its body', { body: '## 種類\nengineering\n', labels: labels('ready') }, 'no engineering label'],
      ['is not ready', { labels: labels('engineering') }, 'no ready label'],
      ['still needs review', { labels: labels('engineering', 'ready', 'needs-review') }, 'needs-review'],
      ['is an SBI Issue, so Product implementation cannot skip the Run snapshot', { labels: labels('engineering', 'ready', 'sbi') }, 'sbi label'],
      ['is closed', { state: 'closed' }, 'is not open (closed)'],
      ['is a pull request, so a PR cannot approve itself', { pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/123' } }, 'is a pull request'],
    ]) {
      it(`when it ${name} then fails with the reason`, () => {
        const reasons = judge(overrides);
        assert.ok(reasons.some(r => r.includes(reason)), reasons.join('; '));
      });
    }
  });

  describe('given a link that cannot be trusted', () => {
    it('when the Issue is in another repository then fails without reading it', () => repository(async root => {
      await commit(root, 'chore: deps\n\nEngineering-Issue: https://github.com/other/app/issues/1');
      const source = await verify(root, async () => { throw new Error('must not be read'); });
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('is not in acme/app')), source.reasons.join('; '));
    }));

    it('when the trailer is not a GitHub Issue URL then fails', () => repository(async root => {
      await commit(root, 'chore: deps\n\nEngineering-Issue: #123');
      const source = await verify(root);
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('is not a GitHub Issue URL')), source.reasons.join('; '));
    }));

    it('when GitHub cannot be read then fails closed', () => repository(async root => {
      await commit(root, linked);
      const source = await verify(root, async () => { throw new Error('HTTP 502'); });
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('could not be read (HTTP 502)')), source.reasons.join('; '));
    }));

    it('when GITHUB_REPOSITORY is not known then fails closed', () => repository(async root => {
      await commit(root, linked);
      const source = await verifyEngineeringSource({ root, base: 'base', required: ['production:apps/admin/package.json'], repository: undefined, github: { fetchIssue: async () => issue() } });
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('GITHUB_REPOSITORY is not set')), source.reasons.join('; '));
    }));

    it('when the PR links two different Issues then fails', () => repository(async root => {
      await commit(root, linked);
      await commit(root, 'chore: second\n\nEngineering-Issue: https://github.com/acme/app/issues/124');
      const source = await verify(root);
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('found 2')), source.reasons.join('; '));
    }));
  });

  describe('given the Completion Judge log', () => {
    it('when an Engineering Issue was checked then names it instead of an SBI Run', () => {
      const lines = describeSbiSource({ kind: 'engineering', required: ['production:apps/admin/package.json'], sources: [{ url }], reasons: [], status: 'PASS' });
      assert.deepEqual(lines, [`Engineering source: ${url}`, 'Engineering source check: PASS']);
    });
  });
});
