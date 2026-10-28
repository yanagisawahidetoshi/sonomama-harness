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
const routes = async (root, entries) => {
  await mkdir(join(root, 'apps/api/config'), { recursive: true });
  await writeFile(join(root, 'apps/api/config/routes.rb'), 'Rails.application.routes.draw do\nend\n');
  if (entries !== undefined) await writeFile(join(root, 'apps/api/config/routes.manifest.json'), typeof entries === 'string' ? entries : JSON.stringify(entries));
};
const route = (verb, path, controller = 'api/v1/lessons', action = 'index') => ({ verb, path, controller, action });
const lesson = { '/api/v1/lessons/{lessonId}': { get: { operationId: 'getLesson', responses: { 200: { description: 'OK' } } }, patch: { operationId: 'updateLesson', responses: { 200: { description: 'OK' } } } } };
const contract = async (root, paths, entries) => { await commit(root); await write(root, schema(paths)); await routes(root, entries); return checkApiContract({ root, base: 'main' }); };
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

  describe('given an OpenAPI document and the Rails route manifest', () => {
    it('when every Rails route is in the contract then passes without mismatches', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show'), route('PATCH', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'update')]);
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.mismatches, []);
      assert.deepEqual(result.unimplemented, []);
    }));

    it('when Rails adds an endpoint that the contract does not define then fails naming the route', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show'), route('GET', '/api/v1/coaches(.:format)', 'api/v1/coaches')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /GET \/api\/v1\/coaches/);
    }));

    it('when Rails serves a contract path with a method the contract does not define then fails naming the method', () => repo(async root => {
      const result = await contract(root, lesson, [route('PUT', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'update')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /PUT \/api\/v1\/lessons\/\{\}.*GET, PATCH/);
    }));

    it('when Rails serves a path that differs from the contract only by a segment then fails', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lesson/:id(.:format)', 'api/v1/lessons', 'show')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /\/api\/v1\/lesson\//);
    }));

    it('when a Rails route accepts any HTTP method then fails because the contract cannot cover it', () => repo(async root => {
      const result = await contract(root, lesson, [route('', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /any HTTP method/);
    }));

    it('when a Rails route has an optional segment other than the format then fails instead of guessing the paths', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons(/:id)(.:format)', 'api/v1/lessons', 'show')]);
      assert.equal(result.status, 'FAIL');
      assert.match(result.mismatches.join('\n'), /optional segment/);
    }));

    it('when the contract defines an operation that Rails has not implemented yet then passes and reports it as unimplemented', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show')]);
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.unimplemented, ['PATCH /api/v1/lessons/{lessonId}']);
    }));

    it('when path parameter names differ between Rails and the contract then matches them by position', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/api/v1/lessons/:id(.:format)', 'api/v1/lessons', 'show')]);
      assert.deepEqual(result.mismatches, []);
    }));

    it('when the only Rails routes are framework routes such as the health check then excludes them from the contract', () => repo(async root => {
      const result = await contract(root, lesson, [route('GET', '/up(.:format)', 'rails/health', 'show')]);
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.mismatches, []);
    }));

    it('when the Rails app has no route manifest then fails and asks for it to be generated', () => repo(async root => {
      const result = await contract(root, lesson, undefined);
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /routes\.manifest\.json/);
    }));

    it('when the route manifest is not a list of routes then fails', () => repo(async root => {
      const result = await contract(root, lesson, '{"verb":"GET"}');
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /routes\.manifest\.json/);
    }));
  });

  describe('given an OpenAPI document without a Rails app', () => {
    it('when the contract is checked then skips the route comparison and passes', () => repo(async root => {
      await commit(root);
      await write(root, schema(lesson));
      const result = await checkApiContract({ root, base: 'main' });
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.mismatches, []);
    }));
  });
});
