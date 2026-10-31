import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
// Trusted acceptance for SBI #232: the first OpenAPI contract with GET /api/v1/health. Reads the worktree only.
// AC-1 checks the structure the Harness relies on (version, info, paths, responses, local $refs); the full OpenAPI 3.1
// validation runs in the api-contract verifier, which this script does not replace.
const root = process.argv[2];
const candidates = ['openapi.yaml', 'openapi.yml', 'openapi.json'].map(file => `packages/api-schema/${file}`);
const methods = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace'];
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
let document;
const contract = () => {
  if (document) return document;
  const found = candidates.filter(path => existsSync(join(root, path)));
  assert.equal(found.length, 1, `exactly one contract file: ${found.join(', ') || 'none'}`);
  const text = readFileSync(join(root, found[0]), 'utf8');
  document = found[0].endsWith('.json') ? JSON.parse(text) : parse(text);
  assert.ok(isObject(document), 'the contract is an object');
  return document;
};
// Local JSON pointers only; a $ref to another file is not part of the single contract.
const resolve = (value, seen = new Set()) => {
  if (!isObject(value) || value.$ref === undefined) return value;
  assert.match(value.$ref, /^#\//, `local $ref: ${value.$ref}`);
  assert.ok(!seen.has(value.$ref), `circular $ref: ${value.$ref}`);
  const target = value.$ref.slice(2).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((node, key) => node?.[key], contract());
  assert.ok(target !== undefined, `$ref resolves: ${value.$ref}`);
  return resolve(target, new Set([...seen, value.$ref]));
};
const refs = (value, out = []) => {
  if (Array.isArray(value)) value.forEach(item => refs(item, out));
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) key === '$ref' ? out.push(value) : refs(item, out);
  return out;
};
const health = () => contract().paths?.['/api/v1/health']?.get;
const okJson = () => {
  const response = resolve(health()?.responses?.['200']);
  assert.ok(isObject(response), 'GET /api/v1/health has a 200 response');
  return response.content?.['application/json'];
};
try {
  const scenarios = [
    ['AC-1', 'Given packages/api-schema, When reading the contract, Then it is a single OpenAPI 3.1 document whose operations and $refs are complete', () => {
      const doc = contract();
      assert.match(String(doc.openapi), /^3\.1\.\d+$/, 'openapi 3.1.x');
      assert.ok(isObject(doc.info) && typeof doc.info.title === 'string' && doc.info.title.trim(), 'info.title');
      assert.ok(typeof doc.info.version === 'string' && doc.info.version.trim(), 'info.version');
      assert.ok(isObject(doc.paths), 'paths');
      for (const [path, item] of Object.entries(doc.paths)) {
        assert.match(path, /^\//, `path starts with /: ${path}`);
        for (const method of methods.filter(m => item?.[m] !== undefined)) {
          const responses = item[method]?.responses;
          assert.ok(isObject(responses) && Object.keys(responses).length, `${method.toUpperCase()} ${path} has responses`);
        }
      }
      for (const ref of refs(doc)) resolve(ref);
    }],
    ['AC-2', 'Given the contract, When reading GET /api/v1/health, Then its 200 response is application/json', () => {
      assert.ok(isObject(health()), 'GET /api/v1/health');
      assert.ok(isObject(okJson()), '200 application/json');
    }],
    ['AC-3', 'Given the 200 response, When reading its schema, Then it is an object with a required string status that only allows ok', () => {
      const schema = resolve(okJson().schema);
      assert.equal(schema?.type, 'object');
      assert.ok(Array.isArray(schema.required) && schema.required.includes('status'), 'status is required');
      const status = resolve(schema.properties?.status);
      assert.equal(status?.type, 'string');
      assert.deepEqual(status.enum, ['ok']);
    }],
    ['AC-4', 'Given GET /api/v1/health, When reading its security, Then it is an explicit empty array', () => {
      assert.deepEqual(health().security, []);
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
