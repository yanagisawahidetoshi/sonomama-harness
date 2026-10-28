import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { fixture, commitFixture, human } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { planApiSchema, approvedLabel } from './api-schema-planner.mjs';
import { recordApiSchemaDecision } from './api-schema-approval.mjs';
import { githubCli } from './planner-github.mjs';
import { parseIssueUrl } from './planner.mjs';
import { startApiMock, mockSchemaPath } from './api-mock.mjs';
import { checkApiMock } from './api-mock-check.mjs';

const issueUrl = 'https://github.com/acme/app/issues/12';
const issue = { number: 12, title: 'プロフィールAPIを追加する', body: '## 背景\n受講生が自分のプロフィールを取得する。', html_url: issueUrl, state: 'open', labels: [] };
const mockGitHub = githubMock({ issue });
const noConstraints = { minLength: null, maxLength: null, minimum: null, maximum: null, pattern: null };
const prop = (name, overrides = {}) => ({ name, type: 'string', format: null, enum: null, ref: null, items: null, required: true, nullable: false, description: `${name}の値`, example: null, constraints: noConstraints, ...overrides });
const response = (status, component = null, array = false) => ({ status, description: `HTTP ${status}`, body: component ? { component, array } : null });
// An authenticated endpoint with nullable and enum properties, and a public endpoint returning an array: the shapes the mock must serve.
const proposal = {
  title: 'プロフィールAPI', summary: '受講生が自分のプロフィールを取得する', version: 'v1', securityImpact: ['APIAuthentication', 'APIAuthorization', 'PII'],
  endpoints: [
    { method: 'GET', path: '/api/v1/me/profile', operationId: 'getMyProfile', summary: 'ログイン中の受講生のプロフィールを取得する', tags: ['profile'], change: 'add',
      authN: 'cognito-jwt', authZ: { roles: [], rule: 'JWTのsubに対応する本人のプロフィールだけを返す' }, pii: true, logCaution: ['displayNameをログへ出さない'],
      parameters: [], requestBody: null, responses: [response(200, 'Profile'), response(401, 'Error'), response(500, 'Error')] },
    { method: 'GET', path: '/api/v1/courses', operationId: 'listCourses', summary: '講座一覧を取得する', tags: ['course'], change: 'add',
      authN: 'public', authZ: { roles: [], rule: null }, pii: false, logCaution: [],
      parameters: [], requestBody: null, responses: [response(200, 'Course', true), response(500, 'Error')] },
  ],
  components: [
    { name: 'Profile', description: '受講生プロフィール', pii: true, properties: [prop('id', { format: 'uuid' }), prop('displayName'), prop('bio', { nullable: true }), prop('role', { enum: ['student', 'mentor'] })] },
    { name: 'Course', description: '講座', pii: false, properties: [prop('id'), prop('title')] },
  ],
};
const plan = (root, options = {}) => planApiSchema({ root, issueUrl, provider: 'claude', quiet: true, agent: async () => ({ proposal, escalation: null }), ...options });
const approve = (root, id) => recordApiSchemaDecision({ root, issueUrl, decision: 'APPROVE', identityProvider: human(id) });
const proposalYaml = root => join(root, '.harness/api-schema/12/openapi.yaml');
// What the human does after approval: copy the approved OpenAPI byte-for-byte into the Source of Truth.
const reflect = root => copyFile(proposalYaml(root), join(root, mockSchemaPath));
async function approved(root, { reflected = true } = {}) {
  await plan(root); await commitFixture(root);
  await approve(root, 'alice'); await approve(root, 'bob');
  if (reflected) await reflect(root);
}
const recorder = () => {
  const calls = [];
  return { calls, spawner: (command, args, options) => { calls.push({ command, args, options }); return { pid: 1 }; } };
};
const refused = async (root, pattern, options = {}) => {
  const { calls, spawner } = recorder();
  await assert.rejects(startApiMock({ root, issueUrl, spawner, ...options }), pattern);
  assert.deepEqual(calls, [], 'Prism must not start');
};

describe('API Mock Server', () => {
  describe('given an approved proposal reflected byte-for-byte into packages/api-schema/openapi.yaml', () => {
    it('when api:mock starts then Prism mocks the Source of Truth on 127.0.0.1:4010 in static mode without proxy', () => fixture(root => mockGitHub({}, async () => {
      await approved(root);
      const { calls, spawner } = recorder();
      const result = await startApiMock({ root, issueUrl, spawner });
      assert.equal(calls.length, 1);
      const [{ command, args }] = calls;
      assert.match(command, /prism$/);
      assert.deepEqual(args, ['mock', join(root, mockSchemaPath), '-h', '127.0.0.1', '-p', '4010']);
      assert.ok(!args.includes('proxy') && !args.includes('-d') && !args.includes('--dynamic'));
      assert.equal(result.schemaPath, mockSchemaPath);
      assert.match(result.digest, /^[0-9a-f]{64}$/);
    })));
    it('when dynamic mode is requested then Prism generates random values from the schema', () => fixture(root => mockGitHub({}, async () => {
      await approved(root);
      const { calls, spawner } = recorder();
      await startApiMock({ root, issueUrl, spawner, dynamic: true });
      assert.deepEqual(calls[0].args.slice(-1), ['-d']);
    })));
  });

  describe('given an approved OpenAPI and no Prism installed', () => {
    it('when api:mock starts then refuses and tells to run pnpm install instead of exiting silently', () => fixture(root => mockGitHub({}, async () => {
      await approved(root);
      await refused(root, /pnpm install/, { prism: join(root, 'node_modules/.bin/prism') });
    })));
  });

  describe('given a proposal that is not approved', () => {
    it('when api:mock starts then refuses and explains that the API schema is not approved', () => fixture(root => mockGitHub({}, async () => {
      await plan(root); await commitFixture(root); await reflect(root);
      await refused(root, /承認されていません[\s\S]*0\/2/);
    })));
    it('when only one of the two required humans approved then refuses', () => fixture(root => mockGitHub({}, async () => {
      await plan(root); await commitFixture(root); await approve(root, 'alice'); await reflect(root);
      await refused(root, /承認されていません[\s\S]*1\/2/);
    })));
    it('when the Issue carries the api-schema-approved label but the signed ledger has no approval then refuses', () => fixture(root => mockGitHub({}, async github => {
      await plan(root); await commitFixture(root); await reflect(root);
      await githubCli.ensureLabels(parseIssueUrl(issueUrl), [approvedLabel]);
      await githubCli.addLabels(parseIssueUrl(issueUrl), [approvedLabel]);
      assert.ok((await github.state()).issue.labels.some(l => l.name === approvedLabel));
      await refused(root, /承認されていません/);
    })));
    it('when no proposal exists for the Issue then refuses', () => fixture(root => mockGitHub({}, async () => {
      await refused(root, /承認されていません[\s\S]*proposalがありません/);
    })));
  });

  describe('given an approved proposal and a Source of Truth that does not match it', () => {
    it('when packages/api-schema/openapi.yaml differs from the approved OpenAPI then refuses and names the digest mismatch', () => fixture(root => mockGitHub({}, async () => {
      await approved(root);
      await writeFile(join(root, mockSchemaPath), toYaml({ openapi: '3.1.0', info: { title: 'SONOMAMA API', version: '0.1.0' }, paths: {} }));
      await refused(root, /digest/);
    })));
    it('when packages/api-schema/openapi.yaml has not been reflected yet then refuses', () => fixture(root => mockGitHub({}, async () => {
      await approved(root, { reflected: false });
      await refused(root, /packages\/api-schema\/openapi\.yaml/);
    })));
    it('when the Source of Truth is openapi.json instead of openapi.yaml then refuses', () => fixture(root => mockGitHub({}, async () => {
      await approved(root, { reflected: false });
      await writeFile(join(root, 'packages/api-schema/openapi.json'), JSON.stringify(parseYaml(await readFile(proposalYaml(root), 'utf8'))));
      await refused(root, /packages\/api-schema\/openapi\.yaml/);
    })));
    it('when both openapi.yaml and openapi.json exist then refuses', () => fixture(root => mockGitHub({}, async () => {
      await approved(root);
      await writeFile(join(root, 'packages/api-schema/openapi.json'), '{}');
      await refused(root, /複数/);
    })));
  });

  describe('given an approved OpenAPI that refers to a remote document', () => {
    it('when api:mock starts then refuses so that the mock never fetches anything outside the local file', () => fixture(root => mockGitHub({}, async () => {
      await writeFile(join(root, mockSchemaPath), toYaml({
        openapi: '3.1.0', info: { title: 'SONOMAMA API', version: '0.1.0' },
        paths: { '/api/v1/health': { get: { operationId: 'getHealth', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: 'https://example.com/schemas/health.json' } } } } } } } },
      }));
      await commitFixture(root);
      await approved(root);
      await refused(root, /\$ref[\s\S]*https:\/\/example\.com/);
    })));
  });

  describe('given the api:mock CLI', () => {
    // Argument errors stop before any file or GitHub access, so the CLI of this repository (with its dependencies) is used directly.
    const cli = args => new Promise(resolve => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'api-mock', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      child.on('close', code => resolve({ code, output }));
    });
    it('when a schema path is given instead of relying on the approval then rejects the option', async () => {
      const result = await cli([issueUrl, '--schema', mockSchemaPath]);
      assert.equal(result.code, 1);
      assert.match(result.output, /Invalid arguments for api-mock/);
    });
    it('when no Issue URL is given then explains that an Issue URL is required', async () => {
      const result = await cli([]);
      assert.equal(result.code, 1);
      assert.match(result.output, /Issue URL/);
    });
  });

  describe('given Prism serving an approved OpenAPI', () => {
    const freePort = () => new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
    async function serving(root, test) {
      await approved(root);
      const port = await freePort();
      let child;
      const spawner = (command, args, options) => { child = spawn(command, args, { ...options, stdio: 'ignore' }); return child; };
      await startApiMock({ root, issueUrl, spawner, port });
      const base = `http://127.0.0.1:${port}`;
      try {
        for (let i = 0; ; i++) {
          try { await fetch(`${base}/api/v1/courses`); break; } catch (error) { if (i > 100) throw error; await new Promise(r => setTimeout(r, 100)); }
        }
        await test(base);
      } finally { child?.kill(); }
    }
    it('when a client calls the authenticated endpoint without a bearer token then responds 401 with the shared Error schema', () => fixture(root => mockGitHub({}, () => serving(root, async base => {
      const res = await fetch(`${base}/api/v1/me/profile`);
      assert.equal(res.status, 401);
      assert.deepEqual(Object.keys(await res.json()).sort(), ['code', 'details', 'message']);
    }))));
    it('when a client calls it with a mock bearer token then responds a stable JSON matching the schema including nullable and enum', () => fixture(root => mockGitHub({}, () => serving(root, async base => {
      const call = () => fetch(`${base}/api/v1/me/profile`, { headers: { Authorization: 'Bearer mock-token' } });
      const res = await call();
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.match(body.id, /^[0-9a-f-]{36}$/);
      assert.equal(typeof body.displayName, 'string');
      assert.ok(body.bio === null || typeof body.bio === 'string');
      assert.ok(['student', 'mentor'].includes(body.role));
      assert.deepEqual(await (await call()).json(), body, 'static mode returns the same response every time');
    }))));
    it('when a client calls a public endpoint returning a list then responds a JSON array', () => fixture(root => mockGitHub({}, () => serving(root, async base => {
      const res = await fetch(`${base}/api/v1/courses`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
      for (const course of body) assert.deepEqual(Object.keys(course).sort(), ['id', 'title']);
    }))));
    it('when a client calls a path outside the OpenAPI then responds 404', () => fixture(root => mockGitHub({}, () => serving(root, async base => {
      assert.equal((await fetch(`${base}/api/v1/unknown`)).status, 404);
    }))));
  });
});

// Schema SBI: the api-contract Verifier also starts Prism from the OpenAPI of the run workspace and calls each documented GET.
describe('Prism Mock check of a Schema SBI', () => {
  const openapi = (paths, extra = {}) => toYaml({ openapi: '3.1.0', info: { title: 'SONOMAMA API', version: '0.1.0' }, paths, ...extra });
  const json = (schema, example) => ({ 'application/json': { schema, ...(example === undefined ? {} : { example }) } });
  const courses = { get: { operationId: 'listCourses', responses: { 200: { description: 'OK', content: json({ type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }, [{ id: 'c1' }]) } } } };
  const write = (root, text) => writeFile(join(root, mockSchemaPath), text);
  it('when the OpenAPI of the workspace is valid then Prism starts and each GET endpoint answers its documented status', () => fixture(async root => {
    const levels = { get: { operationId: 'listLevels', responses: { 200: { description: 'OK', content: json({ type: 'array', items: { type: 'string' } }, ['basic']) } } } };
    await write(root, openapi({ '/api/v1/courses': courses, '/api/v1/levels': levels }));
    const result = await checkApiMock({ root });
    assert.equal(result.status, 'PASS', result.errors.join('; '));
    assert.deepEqual(result.checked.sort(), ['GET /api/v1/courses 200', 'GET /api/v1/levels 200']);
  }));
  // A path parameter gets its value from the OpenAPI itself (example, enum, then type), so a typical GET /courses/{id} is really called.
  it('when an endpoint has a path parameter with an example then Prism is called with that value', () => fixture(async root => {
    const course = { get: { operationId: 'getCourse', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', example: 'c1' } }], responses: { 200: { description: 'OK', content: json({ type: 'object', properties: { id: { type: 'string' } } }, { id: 'c1' }) } } } };
    await write(root, openapi({ '/api/v1/courses/{id}': course }));
    const result = await checkApiMock({ root });
    assert.deepEqual([result.status, result.checked], ['PASS', ['GET /api/v1/courses/{id} 200']], result.errors.join('; '));
  }));
  it('when a path parameter has only an integer type or an enum then a value is made from it and Prism is called', () => fixture(async root => {
    const byType = { get: { operationId: 'getLesson', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'OK', content: json({ type: 'object' }, {}) } } } };
    const byEnum = { get: { operationId: 'getLevel', parameters: [{ name: 'level', in: 'path', required: true, schema: { type: 'string', enum: ['basic', 'advanced'] } }], responses: { 200: { description: 'OK', content: json({ type: 'object' }, {}) } } } };
    await write(root, openapi({ '/api/v1/lessons/{id}': byType, '/api/v1/levels/{level}': byEnum }));
    const result = await checkApiMock({ root });
    assert.deepEqual([result.status, result.checked.sort()], ['PASS', ['GET /api/v1/lessons/{id} 200', 'GET /api/v1/levels/{level} 200']], result.errors.join('; '));
  }));
  it('when no value can be made for a path parameter then that endpoint is listed as not called with the reason', () => fixture(async root => {
    await write(root, openapi({ '/api/v1/courses': courses, '/api/v1/courses/{id}': { get: { operationId: 'getCourse', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^c[0-9]+$' } }], responses: { 200: { description: 'OK' } } } } }));
    const result = await checkApiMock({ root });
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.skipped.map(s => s.endpoint), ['GET /api/v1/courses/{id}']);
    assert.match(result.skipped[0].reason, /path parameter id/);
  }));
  it('when an endpoint has a security requirement then it is listed as not called with the reason, since the Verifier sends no credential', () => fixture(async root => {
    await write(root, openapi({ '/api/v1/courses': courses, '/api/v1/me': { get: { operationId: 'getMe', security: [{ bearer: [] }], responses: { 200: { description: 'OK' } } } } }));
    const result = await checkApiMock({ root });
    assert.deepEqual([result.status, result.checked, result.skipped.map(s => s.endpoint)], ['PASS', ['GET /api/v1/courses 200'], ['GET /api/v1/me']]);
    assert.match(result.skipped[0].reason, /security/);
  }));
  // Nothing called is nothing confirmed: a Schema of only POST, unresolvable parameters and secured GETs does not pass.
  it('when no endpoint could be requested from Prism then fails instead of passing with nothing checked', () => fixture(async root => {
    await write(root, openapi({
      '/api/v1/users': { post: { operationId: 'createUser', responses: { 201: { description: 'Created' } } } },
      '/api/v1/users/{id}': { get: { operationId: 'getUser', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^u[0-9]+$' } }], responses: { 200: { description: 'OK' } } } },
      '/api/v1/me': { get: { operationId: 'getMe', security: [{ bearer: [] }], responses: { 200: { description: 'OK' } } } },
    }));
    const result = await checkApiMock({ root });
    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.checked, []);
    assert.match(result.errors.join('\n'), /1件も/);
    assert.deepEqual(result.skipped.map(s => s.endpoint).sort(), ['GET /api/v1/me', 'GET /api/v1/users/{id}', 'POST /api/v1/users']);
  }));
  it('when Prism cannot load the OpenAPI then fails', () => fixture(async root => {
    await write(root, 'openapi: 3.1.0\npaths: [not, a, map]\n');
    assert.equal((await checkApiMock({ root })).status, 'FAIL');
  }));
  it('when the OpenAPI refers to a remote document then fails before starting Prism', () => fixture(async root => {
    await write(root, openapi({ '/api/v1/health': { get: { responses: { 200: { description: 'OK', content: json({ $ref: 'https://example.com/health.json' }) } } } } }));
    const result = await checkApiMock({ root });
    assert.equal(result.status, 'FAIL');
    assert.match(result.errors.join('\n'), /example\.com/);
  }));
  it('when the repository configuration is read then the api-contract Verifier runs the Prism Mock check', async () => {
    const config = JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
    assert.ok(config.verifiers.find(v => v.id === 'api-contract').commands.some(c => c.join(' ') === 'node ../../tools/harness/api-mock-check.mjs'));
  });
});
