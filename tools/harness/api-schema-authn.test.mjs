import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { fixture } from './test-fixture.mjs';
import { checkApiSchemaAuthn } from './api-schema-authn.mjs';
import { classifySecurity } from './security-enforcement.mjs';
import { execute } from './io.mjs';

const config = JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
const script = 'tools/harness/api-schema-authn.mjs';
const ok = { description: 'OK' }, unauthorized = { description: 'Unauthorized' };
const contract = (paths, extra = {}) => ({ openapi: '3.1.0', info: { title: 'SONOMAMA', version: '1' },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } }, security: [{ bearerAuth: [] }], paths, ...extra });
const lessons = { '/api/v1/lessons': { get: { responses: { 200: ok, 401: unauthorized } } } };
const save = async (root, document) => {
  await mkdir(join(root, 'packages/api-schema'), { recursive: true });
  await writeFile(join(root, 'packages/api-schema/openapi.yaml'), stringify(document));
};
const check = async (root, document) => { if (document) await save(root, document); return checkApiSchemaAuthn({ root }); };

describe('API contract authentication check (#165)', () => {
  describe('given the OpenAPI Source of Truth', () => {
    it('when no OpenAPI document exists then FAILs instead of passing an authentication change unverified', () => fixture(async root => {
      const result = await check(root);
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /packages\/api-schema/);
    }));
    it('when the document is not OpenAPI 3.1 then FAILs', () => fixture(async root => {
      assert.equal((await check(root, { ...contract(lessons), openapi: '3.0.3' })).status, 'FAIL');
    }));
    it('when it defines no operation then FAILs, because there is nothing to verify', () => fixture(async root => {
      assert.equal((await check(root, contract({}))).status, 'FAIL');
    }));
    it('when it defines no security scheme then FAILs', () => fixture(async root => {
      const { status, errors } = await check(root, contract(lessons, { components: {} }));
      assert.equal(status, 'FAIL');
      assert.match(errors.join('\n'), /securitySchemes/);
    }));
    it('when every operation inherits the top-level security and documents 401 then PASSes', () => fixture(async root => {
      assert.deepEqual(await check(root, contract(lessons)), { status: 'PASS', operations: ['GET /api/v1/lessons'], public: [], errors: [] });
    }));
    it('when an operation declares security: [] then PASSes and reports it as public', () => fixture(async root => {
      const result = await check(root, contract({ ...lessons, '/api/v1/version': { get: { security: [], responses: { 200: ok } } } }));
      assert.equal(result.status, 'PASS', result.errors.join('\n'));
      assert.deepEqual(result.public, ['GET /api/v1/version']);
    }));
    it('when an operation lists an empty requirement as an alternative then reports it as public', () => fixture(async root => {
      const result = await check(root, contract({ '/api/v1/lessons': { get: { security: [{}, { bearerAuth: [] }], responses: { 200: ok, 401: unauthorized } } } }));
      assert.deepEqual(result.public, ['GET /api/v1/lessons']);
    }));
  });
  describe('given an operation whose authentication is not stated in the contract', () => {
    it('when neither the operation nor the document declares security then FAILs and names the operation', () => fixture(async root => {
      const { security, ...document } = contract(lessons);
      const { status, errors } = await check(root, document);
      assert.equal(status, 'FAIL');
      assert.match(errors.join('\n'), /GET \/api\/v1\/lessons/);
    }));
    it('when it names a security scheme the document does not define then FAILs and names the scheme', () => fixture(async root => {
      const { status, errors } = await check(root, contract({ '/api/v1/lessons': { get: { security: [{ ApiKey: [] }], responses: { 200: ok, 401: unauthorized } } } }));
      assert.equal(status, 'FAIL');
      assert.match(errors.join('\n'), /ApiKey/);
    }));
    it('when an authenticated operation does not document 401 then FAILs and names the operation', () => fixture(async root => {
      const { status, errors } = await check(root, contract({ '/api/v1/lessons': { post: { responses: { 201: ok } } } }));
      assert.equal(status, 'FAIL');
      assert.match(errors.join('\n'), /POST \/api\/v1\/lessons.*401/);
    }));
  });
  describe('given the command line entry point', () => {
    it('when the contract fails the check then exits non-zero', () => fixture(async root => {
      assert.equal((await execute(process.execPath, [script], { cwd: root })).code, 1);
    }));
    it('when the contract passes the check then exits zero', () => fixture(async root => {
      await save(root, contract(lessons));
      // The fixture copies only tracked files, so the CLI borrows this checkout's installed dependencies (yaml).
      await symlink(new URL('../../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
      assert.equal((await execute(process.execPath, [script], { cwd: root })).code, 0);
    }));
  });
  describe('given the shipped api-schema-authn-check Security Verifier', () => {
    const verifier = config.securityVerifiers.find(v => v.id === 'api-schema-authn-check');
    it('when it is looked up then it runs only the Harness check script with no network', () => {
      assert.deepEqual(verifier?.commands, [['node', script]]);
      assert.equal(verifier.isolation, 'harness');
      assert.equal(verifier.network ?? false, false);
    });
  });
  describe('given a change to the security of the OpenAPI contract', () => {
    it('when classified then requires api-schema-authn-check and not the Rails authentication specs', () => {
      const result = classifySecurity({ files: [{ path: 'packages/api-schema/openapi.yaml', status: 'M', added: '      security: []' }], sbi: {} }, policy);
      assert.ok(result.requiredVerifiers.includes('api-schema-authn-check'));
      assert.equal(result.requiredVerifiers.includes('rails-authn-test'), false);
    });
  });
});
