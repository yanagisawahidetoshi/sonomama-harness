import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from './workspace.mjs';
import { judgeEngineeringIssue, verifyEngineeringSource } from './engineering-source.mjs';

const url = 'https://github.com/acme/app/issues/123';
const labels = (...names) => names.map(name => ({ name }));
const issue = (overrides = {}) => ({
  number: 123,
  title: 'Sparkle Designを導入する',
  body: '## 背景\n技術基盤を更新する。\n\n## 種類\nengineering\n',
  html_url: url,
  state: 'open',
  labels: labels('ready'),
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

async function commit(root, message) {
  await git(root, ['commit', '--allow-empty', '-m', message]);
}

const verify = (root, currentIssue = issue()) => verifyEngineeringSource({
  root,
  base: 'base',
  required: ['production:apps/admin/package.json'],
  repository: 'acme/app',
  github: { fetchIssue: async () => currentIssue },
});

describe('Engineering Issue production source', () => {
  it('accepts one ready engineering Issue linked by a commit trailer', () => repository(async root => {
    await commit(root, `chore: adopt design system\n\nEngineering-Issue: ${url}`);
    const source = await verify(root);
    assert.equal(source.status, 'PASS', source.reasons.join('; '));
    assert.deepEqual(source.sources, [{ url }]);
  }));

  it('fails closed when a Production change has no SBI snapshot and no Engineering-Issue trailer', () => repository(async root => {
    await commit(root, 'chore: adopt design system');
    const source = await verify(root);
    assert.equal(source.status, 'FAIL');
    assert.ok(source.reasons.some(reason => reason.includes('ready SBI snapshot') && reason.includes('Engineering-Issue')));
  }));

  it('rejects an Issue that is not ready', () => repository(async root => {
    await commit(root, `chore: adopt design system\n\nEngineering-Issue: ${url}`);
    const source = await verify(root, issue({ labels: [] }));
    assert.equal(source.status, 'FAIL');
    assert.ok(source.reasons.some(reason => reason.includes('no ready label')));
  }));

  it('rejects an SBI Issue so Product implementation cannot bypass the Run snapshot', () => repository(async root => {
    await commit(root, `feat: product change\n\nEngineering-Issue: ${url}`);
    const source = await verify(root, issue({ labels: labels('ready', 'sbi') }));
    assert.equal(source.status, 'FAIL');
    assert.ok(source.reasons.some(reason => reason.includes('sbi label')));
  }));

  it('rejects an Issue without the explicit engineering marker', () => {
    const reasons = judgeEngineeringIssue({ issue: issue({ body: '## 種類\nimplementation\n' }), url, repository: 'acme/app' });
    assert.ok(reasons.some(reason => reason.includes('engineering')));
  });

  it('rejects multiple different Engineering Issues for one PR', () => repository(async root => {
    await commit(root, `chore: first\n\nEngineering-Issue: ${url}`);
    await commit(root, 'chore: second\n\nEngineering-Issue: https://github.com/acme/app/issues/124');
    const source = await verify(root);
    assert.equal(source.status, 'FAIL');
    assert.ok(source.reasons.some(reason => reason.includes('found 2')));
  }));
});
