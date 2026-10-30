import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderSbiBody } from './planner.mjs';
import { assertWritablePath } from './workspace.mjs';
import { generatedRegistrationSchema } from './schemas.mjs';
import { specDigest } from './spec-approval.mjs';
import { approvedSpec, generateAcceptance, verifyGeneratedRegistration } from './acceptance-generation.mjs';

const pbi = { owner: 'acme', repo: 'app', number: 3, url: 'https://github.com/acme/app/issues/3', title: '講座' };
const body = renderSbiBody({
  id: 'SBI-001', kind: 'implementation', title: '担当講師だけが講座を閲覧できる', purpose: '担当外の講師は拒否される。',
  scope: { included: ['apps/api 講座の閲覧'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: '担当講師は閲覧できる' }, { id: 'AC-2', description: '担当外の講師は403になる' }],
  scenarios: [
    { name: '担当講師が閲覧する', given: ['担当講師である'], when: ['講座を開く'], then: ['200になる'], acceptanceIds: ['AC-1'], test: 'RSpec' },
    { name: '担当外の講師が閲覧する', given: ['担当外の講師である'], when: ['講座を開く'], then: ['403になる'], acceptanceIds: ['AC-2'], test: 'RSpec' },
  ],
  dependsOn: [], changeAreas: ['apps/api'], layers: ['Rails Controller'], estimatedFiles: 3, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'RSpec', acceptance: 'Trusted Acceptance（生成）', e2e: '不要' },
}, pbi);
const issue = { number: 7, title: 'SBI-001 担当講師だけが講座を閲覧できる', body, html_url: 'https://github.com/acme/app/issues/7' };
const path = 'apps/api/spec/acceptance/sbi_7/courses_spec.rb';
const content = `require "rails_helper"

RSpec.describe "講座の閲覧", type: :request do
  it "担当講師が閲覧する: 200を返す" do
    get "/api/v1/courses/1", headers: auth(owner)
    expect(response).to have_http_status(:ok)
  end

  it "担当外の講師が閲覧する: 403を返す" do
    get "/api/v1/courses/1", headers: auth(stranger)
    expect(response).to have_http_status(:forbidden)
  end
end
`;
const answer = (overrides = {}) => ({
  files: [{ path, content }],
  mapping: [
    { scenario: '担当講師が閲覧する', acceptanceIds: ['AC-1'], examples: [{ path, description: '担当講師が閲覧する: 200を返す' }] },
    { scenario: '担当外の講師が閲覧する', acceptanceIds: ['AC-2'], examples: [{ path, description: '担当外の講師が閲覧する: 403を返す' }] },
  ],
  escalation: null, ...overrides,
});
const sha256 = text => createHash('sha256').update(text).digest('hex');
async function workspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'harness-acceptance-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const generate = (root, reply, extra = {}) => generateAcceptance({ workspace: root, issue, provider: 'claude', runId: 'run-1', agent: async () => reply, ...extra });

describe('Protection of generated acceptance tests', () => {
  for (const reserved of ['apps/api/spec/acceptance/sbi_7/courses_spec.rb', 'apps/api/spec/acceptance/support.rb', 'apps/mobile/src/__acceptance__/home.test.tsx']) {
    it(`when the implementation agent writes ${reserved} then it is rejected as reserved`, () => assert.throws(() => assertWritablePath(reserved), /reserved/));
  }
  it('when the implementation agent writes its own request spec then it is allowed', () => assert.doesNotThrow(() => assertWritablePath('apps/api/spec/requests/courses_spec.rb')));
});

describe('Approved spec of an SBI Issue', () => {
  it('when the Issue is read then the spec carries its digest, acceptance criteria and Scenario names', () => {
    const spec = approvedSpec(issue);
    assert.equal(spec.digest, specDigest(body));
    assert.deepEqual(spec.acceptanceCriteria.map(a => a.id), ['AC-1', 'AC-2']);
    assert.deepEqual(spec.scenarios, ['担当講師が閲覧する', '担当外の講師が閲覧する']);
    assert.equal(spec.sbiIssue, 7);
  });
});

describe('Generating Trusted Acceptance from an approved spec', () => {
  it('when the generated tests pass the quality checks then the Harness writes them and a version 2 registration bound to the spec and test digests', () => workspace(async root => {
    const result = await generate(root, answer());
    assert.equal(result.status, 'REGISTERED');
    assert.equal(await readFile(join(root, path), 'utf8'), content);
    const registration = generatedRegistrationSchema.parse(JSON.parse(await readFile(join(root, '.harness/acceptance/sbi-7.json'), 'utf8')));
    assert.equal(registration.specDigest, specDigest(body));
    assert.deepEqual(registration.tests, [{ path, sha256: sha256(content) }]);
    assert.deepEqual(registration.mapping.map(m => m.scenario), ['担当講師が閲覧する', '担当外の講師が閲覧する']);
    assert.deepEqual(registration.generator, { provider: 'claude', runId: 'run-1' });
  }));
  it('when the generated tests fail the quality checks then nothing is written and the findings are returned', () => workspace(async root => {
    const result = await generate(root, answer({ mapping: [answer().mapping[0]] }));
    assert.equal(result.status, 'REJECTED');
    assert.match(result.findings.map(f => f.message).join('\n'), /AC-2/);
    await assert.rejects(readFile(join(root, path), 'utf8'));
    await assert.rejects(readFile(join(root, '.harness/acceptance/sbi-7.json'), 'utf8'));
  }));
  it('when the generation agent escalates because the spec is ambiguous then nothing is written and the reason is returned', () => workspace(async root => {
    const result = await generate(root, { files: [], mapping: [], escalation: '担当の定義が仕様にありません' });
    assert.deepEqual(result, { status: 'ESCALATED', reason: '担当の定義が仕様にありません' });
  }));
  it('when the agent tries to write outside the acceptance directory then nothing is written', () => workspace(async root => {
    const result = await generate(root, answer({ files: [{ path, content }, { path: 'apps/api/app/controllers/courses_controller.rb', content: 'class X; end' }] }));
    assert.equal(result.status, 'REJECTED');
    await assert.rejects(readFile(join(root, 'apps/api/app/controllers/courses_controller.rb'), 'utf8'));
  }));
  it('when the agent is asked to generate then it receives the approved spec and the acceptance directory, and no tool to write files', () => workspace(async root => {
    let seen;
    await generate(root, answer(), { agent: async request => { seen = request; return answer(); } });
    assert.match(seen.prompt, /AC-2: 担当外の講師は403になる/);
    assert.match(seen.prompt, /apps\/api\/spec\/acceptance\/sbi_7\//);
    assert.equal(seen.writes, undefined);
  }));
});

describe('Re-verifying a generated registration', () => {
  const registered = async root => (await generate(root, answer())).registration;
  it('when the Issue spec and the test files are unchanged then it is valid', () => workspace(async root => {
    assert.deepEqual(await verifyGeneratedRegistration({ root, registration: await registered(root), issue }), []);
  }));
  it('when the Gherkin of the Issue changed then the old registration is not reused', () => workspace(async root => {
    const registration = await registered(root);
    const edited = { ...issue, body: issue.body.replace('then 403になる', 'then 404になる').replace('Then 403になる', 'Then 404になる') };
    assert.match((await verifyGeneratedRegistration({ root, registration, issue: edited })).join('\n'), /spec digest/);
  }));
  it('when a registered test was changed after registration then it fails', () => workspace(async root => {
    const registration = await registered(root);
    await writeFile(join(root, path), content.replace(':forbidden', ':ok'));
    assert.match((await verifyGeneratedRegistration({ root, registration, issue })).join('\n'), /courses_spec\.rb/);
  }));
  it('when a registered test was deleted then it fails', () => workspace(async root => {
    const registration = await registered(root);
    await rm(join(root, path));
    assert.match((await verifyGeneratedRegistration({ root, registration, issue })).join('\n'), /courses_spec\.rb/);
  }));
  it('when a file was added to the acceptance directory after registration then it fails', () => workspace(async root => {
    const registration = await registered(root);
    await mkdir(join(root, 'apps/api/spec/acceptance/sbi_7'), { recursive: true });
    await writeFile(join(root, 'apps/api/spec/acceptance/sbi_7/helper.rb'), 'def auth(_) = {}');
    assert.match((await verifyGeneratedRegistration({ root, registration, issue })).join('\n'), /helper\.rb/);
  }));
});
