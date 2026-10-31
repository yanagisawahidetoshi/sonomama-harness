import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderSbiBody } from './planner.mjs';
import { sbiFromIssue, loadSbiIssue } from './sbi-issue.mjs';
import { withAcceptance } from './acceptance-registry.mjs';
import { configSchema } from './schemas.mjs';
import { generateAcceptance, generatedVerifierId } from './acceptance-generation.mjs';
import { specApprovalLine, specDigest } from './spec-approval.mjs';

const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
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
const issue = { number: 7, title: 'SBI-001 担当講師だけが講座を閲覧できる', body, html_url: ref.url, state: 'open', labels: [{ name: 'sbi' }] };
const path = 'apps/api/spec/acceptance/sbi_7/courses_spec.rb';
const content = 'require "rails_helper"\n\nRSpec.describe "講座の閲覧", type: :request do\n  it "担当講師が閲覧する: 200を返す" do\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:ok)\n  end\n\n  it "担当外の講師が閲覧する: 403を返す" do\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:forbidden)\n  end\nend\n';
const answer = { files: [{ path, content }], escalation: null, mapping: [
  { scenario: '担当講師が閲覧する', acceptanceIds: ['AC-1'], examples: [{ path, description: '担当講師が閲覧する: 200を返す' }] },
  { scenario: '担当外の講師が閲覧する', acceptanceIds: ['AC-2'], examples: [{ path, description: '担当外の講師が閲覧する: 403を返す' }] },
] };
const baseConfig = JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
async function workspace(fn) { const root = await mkdtemp(join(tmpdir(), 'harness-flow-')); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }

describe('The SBI of a generated-acceptance run matches its CI rebuild', () => {
  it('when the run starts without a registration then every AC is owned by the generated acceptance verifier of the SBI', () => {
    const sbi = sbiFromIssue({ ref, issue, config: { verifiers: [] }, generate: true });
    assert.deepEqual(sbi.acceptanceCriteria.map(a => a.verifier), [generatedVerifierId(7), generatedVerifierId(7)]);
  });
  it('when CI rebuilds the SBI from the Issue with the version 2 registration of the PR then it equals what the run took at start', () => workspace(async root => {
    const atStart = sbiFromIssue({ ref, issue, config: { verifiers: [] }, generate: true });
    assert.equal((await generateAcceptance({ workspace: root, issue, provider: 'claude', runId: 'run-1', agent: async () => answer })).status, 'REGISTERED');
    const config = await withAcceptance(root, configSchema.parse(baseConfig), [7]);
    assert.deepEqual(sbiFromIssue({ ref, issue, config }), atStart);
  }));
  it('when the version 2 registration is read then it adds one generated acceptance verifier owning every mapped AC', () => workspace(async root => {
    await generateAcceptance({ workspace: root, issue, provider: 'claude', runId: 'run-1', agent: async () => answer });
    const config = await withAcceptance(root, configSchema.parse(baseConfig), [7]);
    const generated = config.verifiers.filter(v => v.sbiIssue === 7);
    assert.deepEqual(generated.map(v => [v.id, v.trust, v.generated, v.acceptanceIds]), [[generatedVerifierId(7), 'acceptance', true, ['AC-1', 'AC-2']]]);
  }));
  it('when the run starts without generate and without a registration then building the SBI still fails closed', () => {
    assert.throws(() => sbiFromIssue({ ref, issue, config: { verifiers: [] } }), /Trusted Acceptance/);
  });
});

describe('Starting a run from a spec-approved SBI Issue', () => {
  const at = '2026-10-30T00:00:00Z';
  const github = (comments) => ({
    fetchIssue: async () => issue, issueTimeline: async () => [],
    listComments: async () => comments, permission: async () => 'admin',
  });
  it('when the spec is approved for the current digest then the run starts in the generate mode with the generated verifier', async () => {
    const comments = [{ id: 1, body: specApprovalLine(specDigest(issue)), html_url: `${ref.url}#c1`, user: { login: 'alice', type: 'User' }, created_at: at, updated_at: at }];
    const loaded = await loadSbiIssue({ issueUrl: ref.url, config: { verifiers: [] }, github: github(comments) });
    assert.equal(loaded.mode, 'generate');
    assert.equal(loaded.sbi.acceptanceCriteria[0].verifier, generatedVerifierId(7));
    assert.deepEqual(loaded.spec.approvers, ['alice']);
  });
});
