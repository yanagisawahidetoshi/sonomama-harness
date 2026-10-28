import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { fixture, commitFixture, human } from './test-fixture.mjs';
import { git } from './workspace.mjs';
import { githubMock } from './test-github.mjs';
import { exists, readJson } from './io.mjs';
import { planApiSchema, proposalMarker, approvedLabel } from './api-schema-planner.mjs';
import { judgeApiSchema } from './api-schema-judge.mjs';
import { readExistingSchema } from './api-schema-reader.mjs';
import { diffContract } from './api-schema-diff.mjs';
import { recordApiSchemaDecision, apiSchemaApprovalStatus, unrevokedApiSchemaApprovals } from './api-schema-approval.mjs';
import { renderOpenApi } from './api-schema-render.mjs';

const issueUrl = 'https://github.com/acme/app/issues/12';
const issue = { number: 12, title: 'プロフィールAPIを追加する', body: '## 背景\n受講生が自分のプロフィールを取得・更新する。', html_url: issueUrl, state: 'open', labels: [] };
const mockGitHub = githubMock({ issue });
const securityCategories = ['AuthN', 'APIAuthentication', 'AuthZ', 'APIAuthorization', 'PII', 'Secret', 'Credential'];
const fakeJwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
const noConstraints = { minLength: null, maxLength: null, minimum: null, maximum: null, pattern: null };

const prop = (name, overrides = {}) => ({ name, type: 'string', format: null, enum: null, ref: null, items: null, required: true, nullable: false, description: `${name}の値`, example: null, constraints: noConstraints, ...overrides });
const response = (status, component = null, array = false) => ({ status, description: `HTTP ${status}`, body: component ? { component, array } : null });
const errors = statuses => statuses.map(status => response(status, 'Error'));
function endpoint(overrides = {}) {
  return {
    method: 'GET', path: '/api/v1/me/profile', operationId: 'getMyProfile', summary: 'ログイン中の受講生のプロフィールを取得する', tags: ['profile'], change: 'add',
    authN: 'cognito-jwt', authZ: { roles: [], rule: 'JWTのsubに対応する本人のプロフィールだけを返す' }, pii: true, logCaution: ['displayNameをログへ出さない'],
    parameters: [], requestBody: null, responses: [response(200, 'Profile'), ...errors([401, 404, 500])],
    ...overrides,
  };
}
function proposal(overrides = {}) {
  return {
    title: 'プロフィールAPI', summary: '受講生が自分のプロフィールを取得・更新する', version: 'v1', securityImpact: ['APIAuthentication', 'APIAuthorization', 'PII'],
    endpoints: [
      endpoint(),
      endpoint({ method: 'PATCH', operationId: 'updateMyProfile', summary: 'ログイン中の受講生のプロフィールを更新する', requestBody: { component: 'ProfileUpdate', array: false, required: true }, responses: [response(200, 'Profile'), ...errors([400, 401, 422, 500])] }),
    ],
    components: [
      { name: 'Profile', description: '受講生プロフィール', pii: true, properties: [prop('id', { format: 'uuid' }), prop('displayName', { constraints: { ...noConstraints, maxLength: 50 } }), prop('bio', { required: false, nullable: true }), prop('role', { enum: ['student', 'mentor'] })] },
      { name: 'ProfileUpdate', description: 'プロフィール更新内容', pii: true, properties: [prop('displayName', { constraints: { ...noConstraints, minLength: 1, maxLength: 50 } }), prop('bio', { required: false, nullable: true })] },
    ],
    ...overrides,
  };
}
const judge = (value, options = {}) => judgeApiSchema(value, { securityCategories, existing: null, ...options });
const rules = result => result.findings.map(f => f.rule);
const agentWith = value => async () => ({ proposal: value, escalation: null });
const plan = (root, options = {}) => planApiSchema({ root, issueUrl, provider: 'claude', quiet: true, agent: agentWith(proposal()), ...options });
const proposalDir = root => join(root, '.harness/api-schema/12');
const writes = async github => (await github.calls()).filter(call => call.args.includes('-X'));
const existingYaml = toYaml({
  openapi: '3.1.0', info: { title: 'SONOMAMA API', version: '0.3.0' },
  paths: {
    '/api/v1/courses': { get: { operationId: 'listCourses', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Course' } } } } } } } },
    '/api/v1/me/profile': { get: { operationId: 'getMyProfile', security: [{ cognitoJwt: [] }], responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Profile' } } } } } } },
  },
  components: { schemas: {
    Course: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    Profile: { type: 'object', required: ['id', 'displayName'], properties: { id: { type: 'string', format: 'uuid' }, displayName: { type: 'string' }, nickname: { type: 'string' }, role: { type: 'string', enum: ['student', 'mentor', 'admin'] } } },
  } },
});
async function withExisting(root, text = existingYaml, file = 'openapi.yaml') {
  await writeFile(join(root, 'packages/api-schema', file), text);
  return readExistingSchema(root);
}

describe('API Schema Quality Judge', () => {
  describe('given a proposal generated from an Issue', () => {
    it('when every endpoint, schema and security declaration is consistent then passes', () => {
      assert.deepEqual(judge(proposal()).findings, []);
      assert.equal(judge(proposal()).status, 'PASS');
    });
    const failing = {
      'the proposal has no endpoint': [p => { p.endpoints = []; }, 'empty-proposal'],
      'the version is not like v1': [p => { p.version = '1.0'; }, 'version-format'],
      'the path is blank': [p => { p.endpoints[0].path = ' '; }, 'path-format'],
      'the path is outside the /api/v1 prefix': [p => { p.endpoints[0].path = '/me/profile'; }, 'path-format'],
      'the operationId is blank': [p => { p.endpoints[0].operationId = ''; }, 'operation-id-format'],
      'the operationId is not camelCase': [p => { p.endpoints[0].operationId = 'Get_Profile'; }, 'operation-id-format'],
      'two endpoints share an operationId': [p => { p.endpoints[1].operationId = 'getMyProfile'; }, 'operation-id-duplicate'],
      'two endpoints share method and path': [p => { p.endpoints[1].method = 'GET'; p.endpoints[1].requestBody = null; }, 'endpoint-duplicate'],
      'the path has a placeholder without a path parameter': [p => { p.endpoints[0].path = '/api/v1/profiles/{profileId}'; }, 'path-parameters'],
      'a path parameter has no placeholder in the path': [p => { p.endpoints[0].parameters = [{ name: 'profileId', in: 'path', required: true, description: 'ID', type: 'string', format: 'uuid', enum: null, example: null }]; }, 'path-parameters'],
      'a path parameter is optional': [p => { p.endpoints[0].path = '/api/v1/profiles/{profileId}'; p.endpoints[0].parameters = [{ name: 'profileId', in: 'path', required: false, description: 'ID', type: 'string', format: 'uuid', enum: null, example: null }]; }, 'path-parameters'],
      'a response refers to an undefined schema': [p => { p.endpoints[0].responses[0].body.component = 'Missing'; }, 'ref-missing'],
      'a request body refers to an undefined schema': [p => { p.endpoints[1].requestBody.component = 'Missing'; }, 'ref-missing'],
      'a property refers to an undefined schema': [p => { p.components[0].properties.push(prop('course', { type: 'object', ref: 'Course' })); }, 'ref-missing'],
      'an object property has no ref': [p => { p.components[0].properties.push(prop('course', { type: 'object' })); }, 'property-type'],
      'an array property has no items': [p => { p.components[0].properties.push(prop('tags', { type: 'array' })); }, 'property-type'],
      'an enum is empty': [p => { p.components[0].properties[3].enum = []; }, 'enum-empty'],
      'an example does not match its enum': [p => { p.components[0].properties[3].example = 'admin'; }, 'example-type'],
      'an integer example is not a number': [p => { p.components[0].properties.push(prop('age', { type: 'integer', example: 'twenty' })); }, 'example-type'],
      'two components share a name': [p => { p.components[1].name = 'Profile'; }, 'component-duplicate'],
      'a component redefines the shared Error schema': [p => { p.components.push({ name: 'Error', description: '独自エラー', pii: false, properties: [prop('message')] }); }, 'component-reserved'],
      'a component has two properties with the same name': [p => { p.components[0].properties.push(prop('id')); }, 'property-duplicate'],
      'a status code is outside the supported list': [p => { p.endpoints[0].responses.push(response(418, 'Error')); }, 'status-invalid'],
      'a status code is declared twice': [p => { p.endpoints[0].responses.push(response(404, 'Error')); }, 'status-duplicate'],
      'there is no success response': [p => { p.endpoints[0].responses = errors([401, 404, 500]); }, 'success-missing'],
      'a 204 response has a body': [p => { p.endpoints[0].responses[0] = response(204, 'Profile'); }, 'no-content-body'],
      'an error response does not reuse the shared Error schema': [p => { p.endpoints[0].responses[2] = response(404, 'Profile'); }, 'error-schema'],
      'a success response returns the Error schema': [p => { p.endpoints[0].responses[0] = response(200, 'Error'); }, 'error-schema'],
      'a GET endpoint has a request body': [p => { p.endpoints[0].requestBody = { component: 'ProfileUpdate', array: false, required: true }; }, 'request-body-method'],
      'an authenticated endpoint does not declare 401': [p => { p.endpoints[0].responses = [response(200, 'Profile'), ...errors([404, 500])]; }, 'auth-responses'],
      'a public endpoint declares 401': [p => { p.endpoints[0].authN = 'public'; p.endpoints[0].authZ = { roles: [], rule: null }; }, 'auth-responses'],
      'a public endpoint requires roles': [p => { p.endpoints[0].authN = 'public'; p.endpoints[0].responses = [response(200, 'Profile'), ...errors([404, 500])]; p.endpoints[0].authZ = { roles: ['admin'], rule: null }; }, 'auth-responses'],
      'a role-restricted endpoint does not declare 403': [p => { p.endpoints[0].authZ = { roles: ['admin'], rule: null }; }, 'auth-responses'],
      'an endpoint declares 403 without any authorization condition': [p => { p.endpoints[0].authZ = { roles: [], rule: null }; p.endpoints[0].responses.push(response(403, 'Error')); }, 'auth-responses'],
      'an authenticated endpoint is missing AuthN in Security Impact': [p => { p.securityImpact = ['APIAuthorization', 'PII']; }, 'security-impact'],
      'an authorization rule is missing AuthZ in Security Impact': [p => { p.securityImpact = ['APIAuthentication', 'PII']; }, 'security-impact'],
      'a PII schema is missing PII in Security Impact': [p => { p.securityImpact = ['APIAuthentication', 'APIAuthorization']; }, 'security-impact'],
      'Security Impact names a category outside security.json': [p => { p.securityImpact.push('Telepathy'); }, 'security-impact'],
      'an endpoint returns a PII schema without declaring PII': [p => { p.endpoints[0].pii = false; }, 'pii-classification'],
      'an example contains a JWT': [p => { p.components[0].properties[1].example = fakeJwt; }, 'secret-value'],
      'a parameter example contains a GitHub token': [p => { p.endpoints[0].parameters = [{ name: 'q', in: 'query', required: false, description: '検索語', type: 'string', format: null, enum: null, example: 'ghp_' + 'k'.repeat(36) }]; }, 'secret-value'],
      'a success response returns a password property': [p => { p.components[0].properties.push(prop('password')); }, 'credential-response'],
    };
    for (const [condition, [mutate, rule]] of Object.entries(failing)) {
      it(`when ${condition} then fails with the ${rule} rule`, () => {
        const value = proposal(); mutate(value);
        const result = judge(value);
        assert.equal(result.status, 'FAIL');
        assert.ok(rules(result).includes(rule), `expected ${rule}, got ${JSON.stringify(result.findings)}`);
        for (const finding of result.findings) assert.ok(finding.reason.trim(), 'every finding explains itself');
      });
    }
    it('when a property is named token and has no example then passes', () => {
      const value = proposal(); value.components[0].properties.push(prop('token', { required: false, nullable: true, description: '外部連携のページングtoken' }));
      assert.deepEqual(judge(value).findings, []);
    });
    it('when a public endpoint declares neither 401 nor 403 then passes', () => {
      const value = proposal({ securityImpact: [] });
      value.endpoints = [endpoint({ path: '/api/v1/courses', operationId: 'listCourses', authN: 'public', authZ: { roles: [], rule: null }, pii: false, logCaution: [], responses: [response(200, 'Course', true), ...errors([500])] })];
      value.components = [{ name: 'Course', description: '講座', pii: false, properties: [prop('id'), prop('title')] }];
      assert.deepEqual(judge(value).findings, []);
    });
  });

  describe('given an existing OpenAPI schema', () => {
    it('when an added endpoint uses an existing method and path then fails with the collision', () => fixture(async root => {
      const existing = await withExisting(root);
      const result = judge(proposal(), { existing });
      assert.ok(result.findings.some(f => f.rule === 'existing-collision' && f.reason.includes('GET /api/v1/me/profile')));
    }));
    it('when an endpoint marked modify or remove does not exist then fails', () => fixture(async root => {
      const existing = await withExisting(root);
      const value = proposal(); value.endpoints[0].change = 'modify'; value.endpoints[1].change = 'remove';
      const result = judge(value, { existing });
      assert.deepEqual(rules(result), ['existing-collision']);
      assert.match(result.findings[0].reason, /PATCH \/api\/v1\/me\/profile/);
    }));
    it('when an added endpoint reuses an operationId of another existing endpoint then fails', () => fixture(async root => {
      const existing = await withExisting(root);
      const value = proposal(); value.endpoints[0].change = 'modify'; value.endpoints[1].operationId = 'listCourses';
      assert.ok(rules(judge(value, { existing })).includes('operation-id-duplicate'));
    }));
    it('when a proposal refers to an existing component then the reference resolves', () => fixture(async root => {
      const existing = await withExisting(root);
      const value = proposal(); value.endpoints[0].change = 'modify';
      value.components[0].properties.push(prop('course', { type: 'object', ref: 'Course', required: false, nullable: true }));
      value.components[0].properties.push(prop('nickname', { required: false }));
      value.components[0].properties[3].enum = ['student', 'mentor', 'admin'];
      assert.deepEqual(judge(value, { existing }).findings, []);
    }));
    it('when the proposal removes or narrows existing contract then lists breaking candidates without failing', () => fixture(async root => {
      const existing = await withExisting(root);
      const value = proposal(); value.endpoints[0].change = 'modify';
      value.endpoints.push(endpoint({ path: '/api/v1/courses', operationId: 'listCourses', change: 'remove' }));
      const result = judge(value, { existing });
      assert.equal(result.status, 'PASS', JSON.stringify(result.findings));
      const breaking = result.changes.breaking.join('\n');
      assert.match(breaking, /DELETE|削除/);
      assert.match(breaking, /GET \/api\/v1\/courses/);
      assert.match(breaking, /Profile\.nickname/);
      assert.match(breaking, /Profile\.role.*admin/);
      assert.match(result.changes.nonBreaking.join('\n'), /PATCH \/api\/v1\/me\/profile/);
    }));
    it('when nothing exists yet then every endpoint is a non-breaking addition', () => {
      const result = judge(proposal());
      assert.deepEqual(result.changes.breaking, []);
      assert.equal(result.changes.nonBreaking.length, 4);
    });
  });
});

describe('Existing API Schema Reader', () => {
  it('when packages/api-schema has no OpenAPI file then returns null', () => fixture(async root => {
    assert.equal(await readExistingSchema(root), null);
  }));
  it('when openapi.yaml exists then extracts endpoints and components without credentials', () => fixture(async root => {
    const existing = await withExisting(root);
    assert.equal(existing.path, 'packages/api-schema/openapi.yaml');
    assert.deepEqual(existing.endpoints.map(e => `${e.method} ${e.path} ${e.operationId}`), ['GET /api/v1/courses listCourses', 'GET /api/v1/me/profile getMyProfile']);
    assert.deepEqual(existing.components.find(c => c.name === 'Profile').properties.find(p => p.name === 'role'), { name: 'role', type: 'string', enum: ['student', 'mentor', 'admin'], required: false, nullable: false });
  }));
  it('when openapi.json exists then reads it the same way', () => fixture(async root => {
    const existing = await withExisting(root, JSON.stringify(parseYaml(existingYaml)), 'openapi.json');
    assert.equal(existing.path, 'packages/api-schema/openapi.json');
    assert.equal(existing.endpoints.length, 2);
  }));
  it('when both openapi.yaml and openapi.json exist then refuses to guess the source of truth', () => fixture(async root => {
    await writeFile(join(root, 'packages/api-schema/openapi.json'), JSON.stringify(parseYaml(existingYaml)));
    await assert.rejects(withExisting(root), /openapi\.yaml.*openapi\.json|Source of Truth/);
  }));
  it('when the existing schema is not OpenAPI 3.1 then rejects it', () => fixture(async root => {
    await assert.rejects(withExisting(root, toYaml({ swagger: '2.0', paths: {} })), /OpenAPI 3\.1/);
    await assert.rejects(withExisting(root, toYaml({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} })), /OpenAPI 3\.1/);
  }));
});

describe('OpenAPI rendering', () => {
  it('when a proposal passes then renders an OpenAPI 3.1 document with Cognito JWT, Rails AuthZ and a shared Error schema', () => {
    const document = renderOpenApi(proposal(), null);
    assert.equal(document.openapi, '3.1.0');
    assert.deepEqual(document.components.securitySchemes.cognitoJwt, { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: document.components.securitySchemes.cognitoJwt.description });
    const get = document.paths['/api/v1/me/profile'].get;
    assert.equal(get.operationId, 'getMyProfile');
    assert.deepEqual(get.security, [{ cognitoJwt: [] }]);
    assert.deepEqual(get['x-sonomama-authz'], { enforcedBy: 'rails', roles: [], rule: 'JWTのsubに対応する本人のプロフィールだけを返す' });
    assert.deepEqual(get['x-sonomama-data'], { pii: true, logCaution: ['displayNameをログへ出さない'] });
    assert.equal(get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/Profile');
    for (const status of ['401', '404', '500']) assert.equal(get.responses[status].content['application/json'].schema.$ref, '#/components/schemas/Error');
    const profile = document.components.schemas.Profile;
    assert.deepEqual(profile.required, ['id', 'displayName', 'role']);
    for (const name of profile.required) assert.ok(profile.properties[name], `required property ${name} exists`);
    assert.deepEqual(profile.properties.bio.type, ['string', 'null']);
    assert.deepEqual(profile.properties.role.enum, ['student', 'mentor']);
    assert.equal(profile.properties.id.format, 'uuid');
    assert.equal(document.components.schemas.ProfileUpdate.properties.displayName.maxLength, 50);
    assert.deepEqual(document.components.schemas.Error.required, ['code', 'message']);
    assert.equal(document.paths['/api/v1/me/profile'].patch.requestBody.required, true);
  });
  it('when a nullable property refers to a component then renders anyOf with null', () => {
    const value = proposal(); value.components[0].properties.push(prop('mentor', { type: 'object', ref: 'ProfileUpdate', required: false, nullable: true }));
    assert.deepEqual(renderOpenApi(value, null).components.schemas.Profile.properties.mentor, { anyOf: [{ $ref: '#/components/schemas/ProfileUpdate' }, { type: 'null' }], description: 'mentorの値' });
  });
  it('when a public endpoint is rendered then it has no security requirement', () => {
    const value = proposal(); value.endpoints[0] = endpoint({ authN: 'public', authZ: { roles: [], rule: null }, responses: [response(200, 'Profile'), ...errors([500])] });
    assert.deepEqual(renderOpenApi(value, null).paths['/api/v1/me/profile'].get.security, []);
  });
  it('when an existing schema is given then merges added, modified and removed endpoints into it', () => fixture(async root => {
    const existing = await withExisting(root);
    const value = proposal(); value.endpoints[0].change = 'modify';
    value.endpoints.push(endpoint({ path: '/api/v1/courses', operationId: 'listCourses', change: 'remove' }));
    const document = renderOpenApi(value, existing);
    assert.equal(document.info.version, '0.3.0');
    assert.equal(document.paths['/api/v1/courses'], undefined);
    assert.ok(document.paths['/api/v1/me/profile'].patch);
    assert.ok(document.components.schemas.Course, 'existing components are kept');
  }));
});

describe('API Schema Planner', () => {
  describe('given a GitHub Issue URL', () => {
    for (const url of ['https://example.com/acme/app/issues/12', 'https://github.com/acme/app/pull/12', 'not a url']) {
      it(`when the URL is ${JSON.stringify(url)} then rejects it before any GitHub call`, () => fixture(root => mockGitHub({}, async github => {
        await assert.rejects(plan(root, { issueUrl: url }), /GitHub Issue URL/);
        assert.deepEqual(await github.calls(), []);
      })));
    }
    it('when the provider is fake then refuses to publish a proposal', () => fixture(root => mockGitHub({}, async github => {
      await assert.rejects(plan(root, { provider: 'fake' }), /codex or claude/);
      assert.deepEqual(await writes(github), []);
    })));
    it('when the number refers to a pull request then rejects it', () => fixture(root => mockGitHub({ issue: { ...issue, pull_request: { url: 'x' } } }, async github => {
      await assert.rejects(plan(root), /pull request/i);
      assert.deepEqual(await writes(github), []);
    })));
  });

  describe('given an Issue and a provider that returns a valid proposal', () => {
    it('when the quality judge passes then writes OpenAPI, machine-readable JSON and a human summary for review', () => fixture(root => mockGitHub({}, async () => {
      const result = await plan(root);
      assert.equal(result.status, 'REVIEW_READY');
      assert.equal(result.quality.status, 'PASS');
      const document = parseYaml(await readFile(join(proposalDir(root), 'openapi.yaml'), 'utf8'));
      assert.equal(document.openapi, '3.1.0');
      assert.ok(document.paths['/api/v1/me/profile'].get);
      const machine = await readJson(join(proposalDir(root), 'proposal.json'));
      assert.equal(machine.issue.url, issueUrl);
      assert.equal(machine.status, 'NEEDS_REVIEW');
      assert.equal(machine.quality.status, 'PASS');
      assert.deepEqual(machine.proposal, proposal());
      assert.match(machine.files['openapi.yaml'], /^[0-9a-f]{64}$/);
      const summary = await readFile(join(proposalDir(root), 'summary.md'), 'utf8');
      for (const text of ['GET /api/v1/me/profile', 'PATCH /api/v1/me/profile', 'Cognito JWT', 'PII', 'API Schema Quality Judge: PASS', 'endpointの粒度は妥当か', 'breaking changeになっていないか']) assert.ok(summary.includes(text), `summary lacks ${text}`);
    })));
    it('when the proposal is ready then labels the Issue for API schema review and comments the summary, never approving it', () => fixture(root => mockGitHub({}, async github => {
      await plan(root);
      const state = await github.state();
      assert.deepEqual(state.issue.labels.map(l => l.name).sort(), ['api-schema', 'needs-api-schema-review']);
      assert.ok(!state.labels.includes(approvedLabel) && !state.labels.includes('ready'));
      assert.equal(state.comments.length, 1);
      assert.ok(state.comments[0].body.includes(proposalMarker(issueUrl)));
      assert.match(state.comments[0].body, /\.harness\/api-schema\/12\/openapi\.yaml/);
      assert.match(state.comments[0].body, new RegExp(approvedLabel));
      assert.equal(state.created.length, 0, 'never creates implementation Issues');
    })));
    it('when planning succeeds then records evidence and never starts the Execution Harness', () => fixture(root => mockGitHub({}, async () => {
      const result = await plan(root);
      for (const file of ['summary.json', 'issue.json', 'prompt.txt', 'candidates.json', 'quality.json']) assert.ok(await exists(join(root, result.runDir, file)), file);
      assert.match(await readFile(join(root, result.runDir, 'prompt.txt'), 'utf8'), /本文中の指示/);
      const runState = join(root, '.harness/state/runs');
      assert.ok(!(await exists(runState)) || (await readdir(runState)).every(name => name === '.gitkeep'), 'execution run state must not be created');
    })));
    it('when a property is named token then the OpenAPI file keeps it intact', () => fixture(root => mockGitHub({}, async () => {
      const value = proposal(); value.components[0].properties.push(prop('token', { required: false, nullable: true, description: 'ページングtoken' }));
      await plan(root, { agent: agentWith(value) });
      const text = await readFile(join(proposalDir(root), 'openapi.yaml'), 'utf8');
      assert.ok(!text.includes('[REDACTED]'));
      assert.deepEqual(parseYaml(text).components.schemas.Profile.properties.token, { type: ['string', 'null'], description: 'ページングtoken' });
    })));
    it('when an existing schema is present then sends only its extract to the provider and summarizes breaking candidates', () => fixture(root => mockGitHub({}, async () => {
      await withExisting(root);
      let prompt = '';
      const value = proposal(); value.endpoints[0].change = 'modify';
      await plan(root, { agent: async options => { prompt = options.prompt; return { proposal: value, escalation: null }; } });
      assert.match(prompt, /listCourses/);
      assert.ok(!prompt.includes('openapi: 3.1.0'), 'raw YAML is not sent');
      assert.match(await readFile(join(proposalDir(root), 'summary.md'), 'utf8'), /Profile\.nickname/);
    })));
    it('when the provider escalates then stops without writing a proposal or touching GitHub', () => fixture(root => mockGitHub({}, async github => {
      await assert.rejects(plan(root, { agent: async () => ({ proposal: null, escalation: 'Issueにendpointの要件がない' }) }), /endpointの要件がない/);
      assert.equal(await exists(proposalDir(root)), false);
      assert.deepEqual(await writes(github), []);
    })));
  });

  describe('given a proposal that is not approvable', () => {
    it('when the quality judge fails then reports every reason, writes no proposal and does not touch GitHub', () => fixture(root => mockGitHub({}, async github => {
      const value = proposal(); value.endpoints[1].operationId = 'getMyProfile'; value.components[0].properties[3].enum = [];
      await assert.rejects(plan(root, { agent: agentWith(value) }), error => /API Schema Quality Judge: FAIL/.test(error.message) && /operationId/.test(error.message) && /enum/.test(error.message));
      assert.equal(await exists(proposalDir(root)), false);
      assert.deepEqual(await writes(github), []);
      const runs = (await readdir(join(root, '.harness/runs'))).filter(name => name.startsWith('api-schema-'));
      assert.equal((await readJson(join(root, '.harness/runs', runs[0], 'quality.json'))).status, 'FAIL');
      assert.equal((await readJson(join(root, '.harness/runs', runs[0], 'summary.json'))).status, 'FAILED');
    })));
    it('when an example contains a credential then rejects it before writing any file or GitHub data', () => fixture(root => mockGitHub({}, async github => {
      const value = proposal(); value.components[0].properties[1].example = fakeJwt;
      await assert.rejects(plan(root, { agent: agentWith(value) }), /Secret|Credential/);
      assert.equal(await exists(proposalDir(root)), false);
      assert.deepEqual(await writes(github), []);
      for (const name of await readdir(join(root, '.harness/runs'))) {
        if (!name.startsWith('api-schema-')) continue;
        for (const file of await readdir(join(root, '.harness/runs', name))) assert.ok(!(await readFile(join(root, '.harness/runs', name, file), 'utf8')).includes(fakeJwt), `${file} leaks the credential`);
      }
    })));
  });

  describe('given a proposal that already exists', () => {
    it('when re-run while still awaiting review then replaces the files and updates the Issue comment in place', () => fixture(root => mockGitHub({}, async github => {
      await plan(root);
      const value = proposal({ summary: '受講生が自分のプロフィールを取得・更新する（改訂）' });
      await plan(root, { agent: agentWith(value) });
      assert.equal((await readJson(join(proposalDir(root), 'proposal.json'))).proposal.summary, value.summary);
      const state = await github.state();
      assert.equal(state.comments.length, 1);
      assert.equal(state.comments[0].updated, 1);
    })));
    it('when a human edited the generated files then stops without overwriting them', () => fixture(root => mockGitHub({}, async github => {
      await plan(root);
      await writeFile(join(proposalDir(root), 'openapi.yaml'), 'openapi: 3.1.0\n# human edit\n');
      const before = (await writes(github)).length;
      await assert.rejects(plan(root), /人間|edited|編集/);
      assert.equal(await readFile(join(proposalDir(root), 'openapi.yaml'), 'utf8'), 'openapi: 3.1.0\n# human edit\n');
      assert.equal((await writes(github)).length, before);
    })));
    it('when a human edited only proposal.json then stops without overwriting it', () => fixture(root => mockGitHub({}, async () => {
      await plan(root);
      const file = join(proposalDir(root), 'proposal.json'), meta = JSON.parse(await readFile(file, 'utf8'));
      meta.proposal.securityImpact = []; await writeFile(file, JSON.stringify(meta));
      await assert.rejects(plan(root), /人間|edited|編集/);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).proposal.securityImpact, []);
    })));
    it('when the Issue is already approved then refuses to regenerate the contract', () => fixture(root => mockGitHub({ issue: { ...issue, labels: [{ name: approvedLabel }] } }, async github => {
      await assert.rejects(plan(root), new RegExp(approvedLabel));
      assert.equal(await exists(proposalDir(root)), false);
      assert.deepEqual(await writes(github), []);
    })));
    it('when the directory holds a proposal for another repository Issue with the same number then stops', () => fixture(root => mockGitHub({}, async github => {
      await mkdir(proposalDir(root), { recursive: true });
      await writeFile(join(proposalDir(root), 'proposal.json'), JSON.stringify({ issue: { url: 'https://github.com/other/repo/issues/12' }, files: {} }));
      await assert.rejects(plan(root), /other\/repo/);
      assert.deepEqual(await writes(github), []);
    })));
  });
});

// Review follow-up: an existing contract must never disappear silently, and an approval must be bound to the exact proposal content.
const json = schema => ({ 'application/json': { schema } });
const schemaRef = name => ({ $ref: `#/components/schemas/${name}` });
function richProposal(change = 'add') {
  const value = proposal();
  value.endpoints[0] = endpoint({
    change, parameters: [{ name: 'locale', in: 'query', required: false, description: '表示言語', type: 'string', format: 'bcp47', enum: ['ja', 'en'], example: null }],
    responses: [{ status: 200, description: 'OK', body: { component: 'Profile', array: true } }, ...errors([401, 404, 500])],
  });
  value.endpoints[1].change = change;
  value.components[0].properties = [
    prop('id', { format: 'uuid' }), prop('mentor', { type: 'object', ref: 'Mentor', required: false }),
    prop('tags', { type: 'array', items: { type: 'string', format: null, enum: null, ref: null }, required: false }),
    prop('nickname', { required: false, constraints: { ...noConstraints, maxLength: 20 } }),
  ];
  value.components.push({ name: 'Mentor', description: 'メンター', pii: false, properties: [prop('id', { format: 'uuid' })] });
  return value;
}
// The existing document is what an earlier approved proposal rendered, plus an extension the proposal model cannot express.
function richExisting() {
  const document = renderOpenApi(richProposal(), null);
  document.paths['/api/v1/me/profile'].get['x-rate-limit'] = 10;
  return document;
}
function droppingProposal() {
  const value = proposal();
  value.endpoints[0] = endpoint({ change: 'modify', responses: [response(200, 'Profile'), ...errors([401, 500])] });
  value.endpoints[1] = { ...value.endpoints[1], change: 'modify', requestBody: null };
  value.components[0].properties = [prop('id'), prop('displayName', { required: false })];
  return value;
}
const writeExisting = (root, document) => withExisting(root, toYaml(document));

describe('Existing contract diff', () => {
  describe('given an existing OpenAPI document and the merged proposal', () => {
    it('when a modify drops request body, responses, parameter, extension and property details then lists every one as a breaking candidate', () => {
      const before = richExisting();
      const after = renderOpenApi(droppingProposal(), { document: before });
      const breaking = diffContract(before, after).breaking.join('\n');
      for (const pointer of [
        'paths./api/v1/me/profile.get.x-rate-limit', 'paths./api/v1/me/profile.get.parameters[query:locale]', 'paths./api/v1/me/profile.get.responses.404',
        'paths./api/v1/me/profile.get.responses.200.content.application/json.schema', 'paths./api/v1/me/profile.patch.requestBody',
        'components.schemas.Profile.properties.id.format', 'components.schemas.Profile.properties.mentor', 'components.schemas.Profile.properties.tags',
        'components.schemas.Profile.properties.nickname',
      ]) assert.ok(breaking.includes(pointer), `${pointer} is missing from\n${breaking}`);
    });
    it('when a modify restates the existing contract and only rewords descriptions then reports no breaking candidate', () => {
      const before = renderOpenApi(richProposal(), null);
      const value = richProposal('modify');
      value.endpoints[0].summary = 'プロフィールを取得する（文言修正）';
      value.components[0].description = '受講生プロフィール（文言修正）';
      const result = diffContract(before, renderOpenApi(value, { document: before }));
      assert.deepEqual(result.breaking, []);
      assert.match(result.nonBreaking.join('\n'), /paths\.\/api\/v1\/me\/profile\.get\.summary/);
      assert.match(result.nonBreaking.join('\n'), /components\.schemas\.Profile\.description/);
    });
    const base = () => ({ openapi: '3.1.0', info: { title: 'x', version: '1' }, paths: { '/api/v1/items': { get: { operationId: 'listItems', parameters: [], responses: { 200: { description: 'OK', content: json(schemaRef('Item')) } } } } }, components: { schemas: { Item: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] } } } } } });
    const cases = {
      'a property becomes required': [d => { d.components.schemas.Item.required.push('state'); }, 'breaking', 'components.schemas.Item.required'],
      'a maxLength is added': [d => { d.components.schemas.Item.properties.id.maxLength = 10; }, 'breaking', 'components.schemas.Item.properties.id.maxLength'],
      'an enum is added to a free string': [d => { d.components.schemas.Item.properties.id.enum = ['a']; }, 'breaking', 'components.schemas.Item.properties.id.enum'],
      'an enum value is removed': [d => { d.components.schemas.Item.properties.state.enum = ['open']; }, 'breaking', 'components.schemas.Item.properties.state.enum'],
      'a security requirement is added': [d => { d.paths['/api/v1/items'].get.security = [{ cognitoJwt: [] }]; }, 'breaking', 'paths./api/v1/items.get.security'],
      'a required parameter is added': [d => { d.paths['/api/v1/items'].get.parameters.push({ name: 'q', in: 'query', required: true, schema: { type: 'string' } }); }, 'breaking', 'paths./api/v1/items.get.parameters[query:q]'],
      'a required request body is added': [d => { d.paths['/api/v1/items'].get.requestBody = { required: true, content: json(schemaRef('Item')) }; }, 'breaking', 'paths./api/v1/items.get.requestBody'],
      'a type changes': [d => { d.components.schemas.Item.properties.id.type = 'integer'; }, 'breaking', 'components.schemas.Item.properties.id.type'],
      'an optional parameter is added': [d => { d.paths['/api/v1/items'].get.parameters.push({ name: 'q', in: 'query', required: false, schema: { type: 'string' } }); }, 'nonBreaking', 'paths./api/v1/items.get.parameters[query:q]'],
      'an optional property is added': [d => { d.components.schemas.Item.properties.note = { type: 'string' }; }, 'nonBreaking', 'components.schemas.Item.properties.note'],
      'an enum value is added': [d => { d.components.schemas.Item.properties.state.enum.push('archived'); }, 'nonBreaking', 'components.schemas.Item.properties.state.enum'],
      'a description changes': [d => { d.components.schemas.Item.description = '品目'; }, 'nonBreaking', 'components.schemas.Item.description'],
    };
    for (const [condition, [mutate, kind, pointer]] of Object.entries(cases)) {
      it(`when ${condition} then reports it as ${kind}`, () => {
        const before = base(), after = structuredClone(before); mutate(after);
        const result = diffContract(before, after);
        assert.ok(result[kind].some(line => line.includes(pointer)), `${pointer} not in ${kind}: ${JSON.stringify(result)}`);
        assert.ok(![...result.breaking, ...result.nonBreaking].every(line => !line.includes(pointer)));
        if (kind === 'nonBreaking') assert.deepEqual(result.breaking, []);
      });
    }
  });

  describe('given the planner modifies an existing OpenAPI document', () => {
    it('when existing contract would be dropped then the summary counts and lists the breaking candidates near the top and proposal.json records them', () => fixture(root => mockGitHub({}, async () => {
      await writeExisting(root, richExisting());
      await plan(root, { agent: agentWith(droppingProposal()) });
      const machine = await readJson(join(proposalDir(root), 'proposal.json'));
      assert.ok(machine.contractDiff.breaking.some(line => line.includes('paths./api/v1/me/profile.patch.requestBody')));
      const summary = await readFile(join(proposalDir(root), 'summary.md'), 'utf8');
      const count = /破壊的変更の候補: (\d+)件/.exec(summary.split('## Endpoint')[0]);
      assert.ok(count && Number(count[1]) >= machine.contractDiff.breaking.length, 'the count appears before the endpoint table');
      assert.ok(summary.includes('paths./api/v1/me/profile.get.x-rate-limit'));
    })));
    it('when an existing schema is present then the provider sees its full contract without descriptions and without redaction damage', () => fixture(root => mockGitHub({}, async () => {
      const document = richExisting();
      document.components.schemas.Profile.properties.token = { type: 'string', description: '旧ページングtoken', example: 'not-for-the-provider' };
      await writeExisting(root, document);
      let prompt = '';
      await plan(root, { agent: async options => { prompt = options.prompt; return { proposal: richProposal('modify'), escalation: null }; } });
      for (const text of ['x-rate-limit', 'bcp47', 'maxLength', '"name": "token"', '#/components/schemas/ProfileUpdate']) assert.ok(prompt.includes(text), `prompt lacks ${text}`);
      assert.ok(!prompt.includes('[REDACTED]'));
      assert.ok(!prompt.includes('not-for-the-provider') && !prompt.includes('旧ページングtoken'));
    })));
  });
});

describe('API Schema Approval', () => {
  const approve = (root, id, decision = 'APPROVE') => recordApiSchemaDecision({ root, issueUrl, decision, identityProvider: human(id) });
  const status = root => apiSchemaApprovalStatus({ root, issueUrl });
  const generated = async (root, options) => { await plan(root, options); await commitFixture(root); };
  const head = async root => (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const issueLabels = async github => (await github.state()).issue.labels.map(l => l.name).sort();

  describe('given a generated and committed proposal', () => {
    it('when two different humans approve a security-impacting proposal then it is approved for that digest and commit', () => fixture(root => mockGitHub({}, async github => {
      await generated(root);
      const first = await approve(root, 'alice');
      assert.equal(first.status, 'NOT_APPROVED');
      assert.deepEqual([first.approvals, first.required], [1, 2]);
      const result = await approve(root, 'bob');
      assert.equal(result.status, 'APPROVED');
      assert.match(result.proposalDigest, /^[0-9a-f]{64}$/);
      assert.equal(result.commitSha, await head(root));
      assert.deepEqual(await status(root), result);
      assert.deepEqual(await issueLabels(github), ['api-schema', approvedLabel]);
    })));
    it('when the same human approves twice then it still counts as one approval', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      await approve(root, 'alice');
      const result = await approve(root, 'alice');
      assert.equal(result.status, 'NOT_APPROVED');
      assert.equal(result.approvals, 1);
    })));
    it('when the proposal has no security impact then one human approval is enough', () => fixture(root => mockGitHub({}, async () => {
      const value = proposal({ securityImpact: [] });
      value.endpoints = [endpoint({ path: '/api/v1/courses', operationId: 'listCourses', authN: 'public', authZ: { roles: [], rule: null }, pii: false, logCaution: [], responses: [response(200, 'Course', true), ...errors([500])] })];
      value.components = [{ name: 'Course', description: '講座', pii: false, properties: [prop('id')] }];
      await generated(root, { agent: agentWith(value) });
      const result = await approve(root, 'alice');
      assert.deepEqual([result.status, result.required], ['APPROVED', 1]);
    })));
    it('when an approver revokes then the proposal is no longer approved and the label projection follows', () => fixture(root => mockGitHub({}, async github => {
      await generated(root);
      await approve(root, 'alice'); await approve(root, 'bob');
      const result = await approve(root, 'alice', 'REVOKE');
      assert.equal(result.status, 'NOT_APPROVED');
      assert.equal(result.approvals, 1);
      assert.deepEqual(await issueLabels(github), ['api-schema', 'needs-api-schema-review']);
    })));
    it('when the proposal changes after approval then the approval no longer applies', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      await approve(root, 'alice'); await approve(root, 'bob');
      await writeFile(join(proposalDir(root), 'openapi.yaml'), 'openapi: 3.1.0\n# changed after approval\n');
      await commitFixture(root);
      const result = await status(root);
      assert.equal(result.status, 'NOT_APPROVED');
      assert.equal(result.approvals, 0);
      assert.ok(result.reasons.some(reason => /digest/.test(reason)), JSON.stringify(result.reasons));
    })));
    it('when the approved files are modified but not committed then the approval no longer applies', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      await approve(root, 'alice'); await approve(root, 'bob');
      await writeFile(join(proposalDir(root), 'summary.md'), '# edited\n');
      assert.equal((await status(root)).status, 'NOT_APPROVED');
    })));
    it('when only the Issue label says approved then the proposal is not approved', () => fixture(root => mockGitHub({}, async github => {
      await generated(root);
      const file = join(github.dir, 'state.json'), state = JSON.parse(await readFile(file, 'utf8'));
      state.issue.labels.push({ name: approvedLabel }); await writeFile(file, JSON.stringify(state));
      const result = await status(root);
      assert.deepEqual([result.status, result.approvals], ['NOT_APPROVED', 0]);
    })));
    it('when the approval ledger is tampered with then refuses to report any status', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      await approve(root, 'alice');
      const directory = join(root, '.harness/state/human/api-schema');
      const [name] = await readdir(directory);
      const ledger = JSON.parse(await readFile(join(directory, name), 'utf8'));
      ledger.records[0].reviewer = 'mallory';
      await writeFile(join(directory, name), JSON.stringify(ledger));
      await assert.rejects(status(root), /signature/);
    })));
    it('when a valid approval exists then the planner refuses to regenerate even if the label was removed', () => fixture(root => mockGitHub({}, async github => {
      await generated(root);
      await approve(root, 'alice'); await approve(root, 'bob');
      const file = join(github.dir, 'state.json'), state = JSON.parse(await readFile(file, 'utf8'));
      state.issue.labels = state.issue.labels.filter(l => l.name !== approvedLabel); await writeFile(file, JSON.stringify(state));
      await assert.rejects(plan(root), /承認/);
    })));
  });

  describe('given an approved proposal and a working tree that no longer matches the approval', () => {
    // The label is only a projection; it is removed so that the signed ledger alone has to stop the regeneration.
    const dropApprovedLabel = async github => {
      const file = join(github.dir, 'state.json'), state = JSON.parse(await readFile(file, 'utf8'));
      state.issue.labels = state.issue.labels.filter(l => l.name !== approvedLabel); await writeFile(file, JSON.stringify(state));
    };
    const approvedTwice = async (root, github) => { await generated(root); await approve(root, 'alice'); await approve(root, 'bob'); await dropApprovedLabel(github); };
    const unchanged = async (root, action) => {
      const before = await readFile(join(proposalDir(root), 'openapi.yaml'), 'utf8');
      await action();
      assert.equal(await readFile(join(proposalDir(root), 'openapi.yaml'), 'utf8'), before, 'the approved proposal is kept');
    };
    it('when an untracked file is added to the approved proposal directory then the planner still refuses to regenerate until a REVOKE', () => fixture(root => mockGitHub({}, async github => {
      await approvedTwice(root, github);
      await writeFile(join(proposalDir(root), 'notes.md'), 'reviewer memo\n');
      assert.equal((await status(root)).approvals, 0, 'the dirty directory lowers the approval status');
      await unchanged(root, () => assert.rejects(plan(root), /REVOKE/));
    })));
    it('when the approved proposal has an uncommitted edit then the planner refuses to regenerate because of the unrevoked approval', () => fixture(root => mockGitHub({}, async github => {
      await approvedTwice(root, github);
      await writeFile(join(proposalDir(root), 'summary.md'), '# edited\n');
      await assert.rejects(plan(root), /REVOKE/);
    })));
    it('when the approved proposal directory is gone then the planner still refuses to regenerate', () => fixture(root => mockGitHub({}, async github => {
      await approvedTwice(root, github);
      await rm(proposalDir(root), { recursive: true });
      await assert.rejects(plan(root), /REVOKE/);
      assert.equal(await exists(proposalDir(root)), false);
    })));
    it('when only one of the approvers revokes then the planner still refuses to regenerate', () => fixture(root => mockGitHub({}, async github => {
      await approvedTwice(root, github);
      await approve(root, 'alice', 'REVOKE');
      await assert.rejects(plan(root), /REVOKE/);
    })));
    it('when every approver revokes then the planner regenerates the proposal as before', () => fixture(root => mockGitHub({}, async github => {
      await approvedTwice(root, github);
      await approve(root, 'alice', 'REVOKE'); await approve(root, 'bob', 'REVOKE');
      assert.equal((await plan(root)).status, 'REVIEW_READY');
    })));
    it('when the working tree is dirty then the approval status counts no valid approval while the ledger still lists the unrevoked approvers', () => fixture(root => mockGitHub({}, async github => {
      await approvedTwice(root, github);
      await writeFile(join(proposalDir(root), 'notes.md'), 'reviewer memo\n');
      assert.deepEqual([(await status(root)).status, (await status(root)).approvals], ['NOT_APPROVED', 0]);
      assert.deepEqual((await unrevokedApiSchemaApprovals({ root, issueUrl })).map(record => record.reviewer).sort(), ['alice', 'bob']);
    })));
  });

  describe('given a proposal that cannot be approved', () => {
    it('when the proposal files are not committed then refuses to record the approval', () => fixture(root => mockGitHub({}, async () => {
      await plan(root);
      await assert.rejects(approve(root, 'alice'), /commit/);
      assert.equal(await exists(join(root, '.harness/state/human/api-schema')), false);
    })));
    it('when no proposal was generated for the Issue then refuses to record the approval', () => fixture(root => mockGitHub({}, async () => {
      await assert.rejects(approve(root, 'alice'), /proposal/i);
    })));
    it('when a human edited the generated files then refuses to record the approval', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      await writeFile(join(proposalDir(root), 'openapi.yaml'), 'openapi: 3.1.0\n# human edit\n');
      await commitFixture(root);
      await assert.rejects(approve(root, 'alice'), /digest|編集/);
    })));
    const editProposalJson = async (root, edit) => {
      const file = join(proposalDir(root), 'proposal.json'), meta = JSON.parse(await readFile(file, 'utf8'));
      edit(meta); await writeFile(file, `${JSON.stringify(meta, null, 2)}\n`);
      await commitFixture(root);
    };
    it('when a human cleared the security impact in proposal.json then refuses to record the approval', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      await editProposalJson(root, meta => { meta.proposal.securityImpact = []; });
      await assert.rejects(approve(root, 'alice'), /digest|編集/);
      assert.equal(await exists(join(root, '.harness/state/human/api-schema')), false);
    })));
    it('when a human edited only the proposal content in proposal.json then refuses to record the approval', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      await editProposalJson(root, meta => { meta.proposal.summary = '人間が書き換えた要約'; });
      await assert.rejects(approve(root, 'alice'), /digest|編集/);
    })));
    it('when a human rewrote the file hashes in proposal.json to hide an edit then refuses to record the approval', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      const yamlText = 'openapi: 3.1.0\n# human edit\n';
      await writeFile(join(proposalDir(root), 'openapi.yaml'), yamlText);
      await editProposalJson(root, meta => { meta.files['openapi.yaml'] = createHash('sha256').update(yamlText).digest('hex'); });
      await assert.rejects(approve(root, 'alice'), /digest|編集/);
    })));
    it('when a human edited proposal.json after two approvals then the proposal is no longer approved and needs the generated number of approvers', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      await approve(root, 'alice'); await approve(root, 'bob');
      await editProposalJson(root, meta => { meta.proposal.securityImpact = []; });
      const result = await status(root);
      assert.deepEqual([result.status, result.approvals, result.required], ['NOT_APPROVED', 0, 2]);
    })));
    it('when the identity is not a human then refuses to record the approval', () => fixture(root => mockGitHub({}, async () => {
      await generated(root);
      await assert.rejects(recordApiSchemaDecision({ root, issueUrl, decision: 'APPROVE', identityProvider: () => ({ id: 'codex', kind: 'ai', source: 'agent' }) }), /human/i);
    })));
  });
});
