import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from './workspace.mjs';
import { checkApiContract } from './api-contract.mjs';

const schema = (paths, openapi = '3.1.0') => JSON.stringify({ openapi, info: { title: 'SONOMAMA', version: '0.1.0' }, paths });
const lessons = { '/lessons': { get: { operationId: 'listLessons', responses: { 200: { description: 'OK' } } } } };
const lessonsAndCoaches = { ...lessons, '/coaches': { get: { operationId: 'listCoaches', responses: { 200: { description: 'OK' } } } } };

async function repo(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-contract-')));
  try {
    await mkdir(join(root, 'packages/api-schema'), { recursive: true });
    await git(root, ['init', '--template=', '--initial-branch=main']);
    await git(root, ['config', 'user.email', 'harness@example.invalid']);
    await git(root, ['config', 'user.name', 'Harness']);
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}
const write = (root, text, file = 'openapi.json') => writeFile(join(root, 'packages/api-schema', file), text);
const commit = async root => { await git(root, ['add', '--all']); await git(root, ['commit', '--allow-empty', '-m', 'base']); };

describe('API contract verifier', () => {
  describe('given no OpenAPI document at the base', () => {
    it('when a valid OpenAPI 3.1 document is added then passes', () => repo(async root => {
      await commit(root);
      await write(root, schema(lessons));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.breaking, []);
    }));

    it('when an OpenAPI 3.0 document is added then fails', () => repo(async root => {
      await commit(root);
      await write(root, schema(lessons, '3.0.3'));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /OpenAPI 3\.1\.x/);
    }));

    it('when the document cannot be parsed then fails', () => repo(async root => {
      await commit(root);
      await write(root, '{ not json');
      assert.equal((await checkApiContract({ root, base: 'main' })).status, 'FAIL');
    }));
  });

  describe('given an OpenAPI document at the base', () => {
    it('when an endpoint is added then passes and reports the addition as non-breaking', () => repo(async root => {
      await write(root, schema(lessons));
      await commit(root);
      await write(root, schema(lessonsAndCoaches));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'PASS');
      assert.ok(result.nonBreaking.length > 0);
    }));

    it('when an endpoint is removed then fails as a breaking change', () => repo(async root => {
      await write(root, schema(lessonsAndCoaches));
      await commit(root);
      await write(root, schema(lessons));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'FAIL');
      assert.match(result.breaking.join('\n'), /\/coaches/);
    }));
  });

  describe('given no OpenAPI document in the change', () => {
    it('when the Source of Truth is still missing then reports it as not created', () => repo(async root => {
      await commit(root);
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'MISSING');
    }));
  });
});
