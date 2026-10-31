import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from './io.mjs';
import { maestroEvidence, githubActionsCli } from './maestro-evidence.mjs';
import { githubCli } from './planner-github.mjs';
import { githubMock } from './test-github.mjs';

const ref = { owner: 'acme', repo: 'app', number: 8, url: 'https://github.com/acme/app/issues/8' };
const head = 'a'.repeat(40);
const sha256 = text => createHash('sha256').update(text).digest('hex');
const sbi = (overrides = {}) => ({ id: 'SBI-001', kind: 'implementation', number: 11, issueUrl: 'https://github.com/acme/app/issues/11', ...overrides });
const pull = { number: 21, head: { sha: head } };
// The snapshot the merged Harness PR committed: CI checked it against the approved SBI Issue when the PR was judged.
const snapshot = (overrides = {}, sbiOverrides = {}) => ({
  version: 1, source: { repo: 'acme/app', number: 11, url: 'https://github.com/acme/app/issues/11' }, runId: 'run-1', titleDigest: 'c'.repeat(64), bodyDigest: 'd'.repeat(64),
  sbi: {
    id: 'ISSUE-11', kind: 'implementation', title: 'ログイン画面', description: '受講生がログインできる。',
    gherkin: 'Feature: ログイン\n  Scenario: ログイン\n    Given 登録済み\n    When ログインする\n    Then ホームが表示される',
    acceptanceCriteria: [{ id: 'AC-1', description: 'ログインできる', verifier: 'issue-11-acceptance' }], allowedFiles: [], allowedDirs: ['apps/mobile/'], risks: [],
    ambiguous: false, requiresDesignDecision: false, securityImpact: [], requiredSecurityRules: [], requiredVerifiers: [], affectedAreas: [], preImplementationGate: false,
    minimumRiskLevel: 2, estimatedFiles: 2, e2e: 'Maestro（モックAPI）', issueUrl: 'https://github.com/acme/app/issues/11', pbiUrl: ref.url, ...sbiOverrides,
  },
  ...overrides,
});
const result = (overrides = {}) => ({ version: 1, lane: 'mock', headSha: head, status: 'PASS', flows: [{ name: 'login', status: 'PASS' }], artifacts: ['maestro-evidence'], ...overrides });

function world(overrides = {}) {
  const state = {
    snapshot: JSON.stringify(snapshot()),
    checkRuns: [{ id: 5, name: 'harness', status: 'completed', conclusion: 'success', check_suite: { id: 77 }, started_at: '2026-10-30T01:00:00Z' }],
    runs: [{ id: 900, path: '.github/workflows/harness.yml', head_sha: head, event: 'pull_request' }],
    artifacts: [{ id: 1, name: 'maestro-results', expired: false, created_at: '2026-10-30T00:50:00Z' }],
    files: { 'mock.json': JSON.stringify(result()) },
    calls: [],
    ...overrides,
  };
  const github = { async fileAt(_ref, path, at) { state.calls.push(['fileAt', path, at]); return state.snapshot; } };
  const actions = {
    async checkRuns(_ref, sha) { state.calls.push(['checkRuns', sha]); return state.checkRuns; },
    async workflowRuns(_ref, suite) { state.calls.push(['workflowRuns', suite]); return state.runs; },
    async artifacts(_ref, run) { state.calls.push(['artifacts', run]); return state.artifacts; },
    async download(_ref, artifactId) { state.calls.push(['download', artifactId]); return state.files; },
  };
  return { state, adapter: maestroEvidence({ ref, github, actions }) };
}

describe('Maestro Evidence adapter', () => {
  describe('given an implementation SBI whose merged Harness PR ran the mock lane in CI', () => {
    it('when the evidence is read then the mock result of the run behind the passing harness check of the merged head is returned with its digest', async () => {
      const { state, adapter } = world();
      assert.deepEqual(await adapter.read({ sbi: sbi(), pull }), { connected: true, e2e: { status: 'PASS', api: 'mock' }, evidenceDigest: sha256(state.files['mock.json']),
        source: { workflowRunId: 900, artifactId: 1, lane: 'mock', resultDigest: sha256(state.files['mock.json']) } });
      assert.deepEqual(state.calls, [['fileAt', '.harness/state/sbi-11.json', head], ['checkRuns', head], ['workflowRuns', 77], ['artifacts', 900], ['download', 1]]);
    });
    it('when a flow failed then the E2E result is FAIL', async () => {
      const { adapter } = world({ files: { 'mock.json': JSON.stringify(result({ status: 'FAIL', flows: [{ name: 'login', status: 'FAIL', message: 'not found' }] })) } });
      assert.deepEqual((await adapter.read({ sbi: sbi(), pull })).e2e, { status: 'FAIL', api: 'mock' });
    });
  });

  describe('given a re-run CI run that kept several maestro-results artifacts', () => {
    const artifacts = [
      { id: 1, name: 'maestro-results', expired: false, created_at: '2026-10-30T00:10:00Z' },
      { id: 2, name: 'maestro-results', expired: false, created_at: '2026-10-30T00:50:00Z' },
      { id: 3, name: 'maestro-results', expired: false, created_at: '2026-10-30T01:30:00Z' },
    ];
    it('when the evidence is read then the newest artifact made before the passing harness check started is checked and downloaded by its ID', async () => {
      const { state, adapter } = world({ artifacts });
      await adapter.read({ sbi: sbi(), pull });
      assert.deepEqual(state.calls.at(-1), ['download', 2]);
    });
    it('when artifact IDs do not follow creation order, as GitHub returned for a re-run, then the creation time decides', async () => {
      const { state, adapter } = world({ artifacts: [
        { id: 12925670351, name: 'maestro-results', expired: false, created_at: '2026-10-30T00:00:54Z' },
        { id: 12924608890, name: 'maestro-results', expired: false, created_at: '2026-10-30T00:07:44Z' },
      ] });
      await adapter.read({ sbi: sbi(), pull });
      assert.deepEqual(state.calls.at(-1), ['download', 12924608890]);
    });
    it('when that artifact expired then reading fails closed instead of falling back to an older one', async () => {
      const { state, adapter } = world({ artifacts: artifacts.map(a => a.id === 2 ? { ...a, expired: true } : a) });
      await assert.rejects(adapter.read({ sbi: sbi(), pull }), /期限切れ/);
      assert.ok(!state.calls.some(([call]) => call === 'download'));
    });
    it('when every artifact was made after the harness check started then reading fails closed', async () => {
      const { adapter } = world({ artifacts: [artifacts[2]] });
      await assert.rejects(adapter.read({ sbi: sbi(), pull }), /artifact/);
    });
  });

  describe('given a validation SBI whose merged Harness PR ran the real lane in CI', () => {
    it('when the evidence is read then only the real lane result counts', async () => {
      const real = JSON.stringify(result({ lane: 'real' }));
      const { adapter } = world({
        snapshot: JSON.stringify(snapshot({ source: { repo: 'acme/app', number: 13, url: 'https://github.com/acme/app/issues/13' } }, { kind: 'validation', issueUrl: 'https://github.com/acme/app/issues/13' })),
        files: { 'mock.json': JSON.stringify(result()), 'real.json': real },
      });
      assert.deepEqual(await adapter.read({ sbi: sbi({ id: 'SBI-003', kind: 'validation', number: 13, issueUrl: 'https://github.com/acme/app/issues/13' }), pull }), { connected: true, e2e: { status: 'PASS', api: 'real' }, evidenceDigest: sha256(real),
        source: { workflowRunId: 900, artifactId: 1, lane: 'real', resultDigest: sha256(real) } });
    });
  });

  describe('given an SBI that is not an E2E target in its approved snapshot', () => {
    for (const [name, sbiOverrides] of [['its Issue says E2E is not needed', { e2e: '不要' }], ['it does not touch apps/mobile', { allowedDirs: ['apps/admin/'] }]]) {
      it(`when ${name} then it has no E2E result and no artifact is read`, async () => {
        const { state, adapter } = world({ snapshot: JSON.stringify(snapshot({}, sbiOverrides)) });
        assert.deepEqual(await adapter.read({ sbi: sbi(), pull }), { connected: true, e2e: null });
        assert.ok(!state.calls.some(([call]) => call === 'download'));
      });
    }
    it('when the Issue has no E2E line then it is still an E2E target', async () => {
      const { state, adapter } = world({ snapshot: JSON.stringify(snapshot({}, { e2e: null })) });
      assert.equal((await adapter.read({ sbi: sbi(), pull })).e2e.api, 'mock');
      assert.ok(state.calls.some(([call]) => call === 'download'));
    });
  });

  describe('given a raw artifact that is gone', () => {
    for (const [name, overrides] of [
      ['it expired', { artifacts: [{ id: 1, name: 'maestro-results', expired: true, created_at: '2026-10-30T00:50:00Z' }] }],
      ['it is missing', { artifacts: [] }],
    ]) {
      it(`when ${name} then reading fails with an artifact-unavailable error, so a signed manifest may stand in`, async () => {
        const { adapter } = world(overrides);
        await assert.rejects(adapter.read({ sbi: sbi(), pull }), error => error.artifactUnavailable === true);
      });
    }
    const failingDownload = error => {
      const { state } = world();
      return maestroEvidence({ ref, github: { fileAt: async () => state.snapshot }, actions: { checkRuns: async () => state.checkRuns, workflowRuns: async () => state.runs, artifacts: async () => state.artifacts, download: async () => { throw error; } } });
    };
    for (const status of ['404', '410']) {
      it(`when the download answers HTTP ${status} then the artifact is gone, and the error names the run and the artifact`, async () => {
        await assert.rejects(failingDownload(Object.assign(new Error(`artifact 1 をダウンロードできません（HTTP ${status}）`), { httpStatus: status })).read({ sbi: sbi(), pull }),
          error => error.artifactUnavailable === true && error.workflowRunId === 900 && error.artifactId === 1);
      });
    }
    for (const [name, error] of [
      ['a server error', Object.assign(new Error('HTTP 502'), { httpStatus: '502' })],
      ['a rate limit', Object.assign(new Error('HTTP 403 rate limit'), { httpStatus: '403' })],
      ['an expired login', Object.assign(new Error('HTTP 401'), { httpStatus: '401' })],
      ['a network failure', new Error('connect ETIMEDOUT')],
      ['an unzip failure', new Error('artifact 1 を展開できません')],
    ]) {
      it(`when the download fails with ${name} then the error is not artifact-unavailable, so no manifest stands in`, async () => {
        await assert.rejects(failingDownload(error).read({ sbi: sbi(), pull }), e => !e.artifactUnavailable);
      });
    }
    it('when the artifact expired then the error names the run and the expired artifact', async () => {
      const { adapter } = world({ artifacts: [{ id: 1, name: 'maestro-results', expired: true, created_at: '2026-10-30T00:50:00Z' }] });
      await assert.rejects(adapter.read({ sbi: sbi(), pull }), error => error.artifactUnavailable === true && error.workflowRunId === 900 && error.artifactId === 1);
    });
    it('when the result was read but is for another lane then the error is not artifact-unavailable', async () => {
      const { adapter } = world({ files: { 'mock.json': JSON.stringify(result({ lane: 'real' })) } });
      await assert.rejects(adapter.read({ sbi: sbi(), pull }), error => !error.artifactUnavailable);
    });
  });

  describe('given an SBI without a merged Harness PR', () => {
    it('when the evidence is read then it is not connected and says why', async () => {
      const { adapter } = world();
      const answer = await adapter.read({ sbi: sbi({ kind: 'validation' }), pull: null });
      assert.equal(answer.connected, false);
      assert.match(answer.reason, /merge/);
    });
  });

  describe('given evidence that cannot be trusted', () => {
    const cases = [
      ['the snapshot is missing from the merged head', { snapshot: null }, /snapshot/],
      ['the snapshot is not valid', { snapshot: '{"version":1}' }, /snapshot/],
      ['the snapshot belongs to another SBI Issue', { snapshot: JSON.stringify(snapshot({ source: { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/issues/12' } }, { issueUrl: 'https://github.com/acme/app/issues/12' })) }, /snapshot/],
      ['the Issue now says validation but the approved snapshot says implementation', { kind: 'validation' }, /kind/],
      ['the snapshot belongs to another PBI', { snapshot: JSON.stringify(snapshot({}, { pbiUrl: 'https://github.com/acme/app/issues/9' })) }, /PBI/],
      ['the harness check of the merged head did not pass', { checkRuns: [{ id: 5, name: 'harness', status: 'completed', conclusion: 'failure', check_suite: { id: 77 } }] }, /harness check/],
      ['there is no harness check on the merged head', { checkRuns: [] }, /harness check/],
      ['the harness check has no start time to tell which artifact it read', { checkRuns: [{ id: 5, name: 'harness', status: 'completed', conclusion: 'success', check_suite: { id: 77 } }] }, /started_at/],
      ['the check suite has no Harness workflow run', { runs: [{ id: 900, path: '.github/workflows/other.yml', head_sha: head, event: 'pull_request' }] }, /workflow run/],
      ['the workflow run is for another commit', { runs: [{ id: 900, path: '.github/workflows/harness.yml', head_sha: 'b'.repeat(40), event: 'pull_request' }] }, /workflow run/],
      ['the result artifact expired', { artifacts: [{ id: 1, name: 'maestro-results', expired: true }] }, /artifact/],
      ['the result artifact is missing', { artifacts: [] }, /artifact/],
      ['the lane result file is missing', { files: {} }, /mock\.json/],
      ['the lane result file is not JSON', { files: { 'mock.json': 'oops' } }, /mock\.json/],
      ['the result lacks the flows', { files: { 'mock.json': JSON.stringify({ version: 1, lane: 'mock', headSha: head, status: 'PASS', artifacts: ['x'] }) } }, /mock\.json/],
      ['the result is for another lane', { files: { 'mock.json': JSON.stringify(result({ lane: 'real' })) } }, /lane/],
      ['the result is for another commit', { files: { 'mock.json': JSON.stringify(result({ headSha: 'b'.repeat(40) })) } }, /headSha|commit/],
      ['no flow ran', { files: { 'mock.json': JSON.stringify(result({ flows: [] })) } }, /flow/],
      ['no log or screenshot was kept', { files: { 'mock.json': JSON.stringify(result({ artifacts: [] })) } }, /artifact/],
    ];
    for (const [name, overrides, pattern] of cases) {
      it(`when ${name} then reading fails closed`, async () => {
        const { kind, ...state } = overrides;
        const { adapter } = world(state);
        await assert.rejects(adapter.read({ sbi: sbi(kind ? { kind } : {}), pull }), pattern);
      });
    }
  });
});

describe('GitHub adapter for the Maestro Evidence', () => {
  describe('given the gh CLI', () => {
    it('when a file is read at a commit then the contents API is decoded, and a missing file is null', () => githubMock({})({ contents: { [head]: { '.harness/state/sbi-11.json': '{"a":1}' } } }, async () => {
      assert.equal(await githubCli.fileAt(ref, '.harness/state/sbi-11.json', head), '{"a":1}');
      assert.equal(await githubCli.fileAt(ref, '.harness/state/sbi-12.json', head), null);
    }));
    it('when the CI run of a check suite and its artifacts are read then the Actions API is used and the artifact is downloaded by its ID', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'harness-zip-'));
      try {
        await writeFile(join(dir, 'mock.json'), '{"lane":"mock"}');
        assert.ok((await execute('zip', ['-q', '-j', join(dir, 'a.zip'), join(dir, 'mock.json')])).ok);
        await githubMock({})({
          workflowRuns: { 77: [{ id: 900, path: '.github/workflows/harness.yml', head_sha: head, event: 'pull_request' }] },
          runArtifacts: { 900: [{ id: 1, name: 'maestro-results', expired: false, created_at: '2026-10-30T00:50:00Z' }] },
          artifactZips: { 1: (await readFile(join(dir, 'a.zip'))).toString('base64') },
        }, async github => {
          assert.deepEqual((await githubActionsCli.workflowRuns(ref, 77)).map(r => r.id), [900]);
          assert.deepEqual((await githubActionsCli.artifacts(ref, 900)).map(a => [a.id, a.created_at]), [[1, '2026-10-30T00:50:00Z']]);
          assert.deepEqual(await githubActionsCli.download(ref, 1), { 'mock.json': '{"lane":"mock"}' });
          const calls = (await github.calls()).map(c => c.args[1]);
          assert.ok(calls.some(c => c.startsWith('repos/acme/app/actions/runs?') && c.includes('check_suite_id=77')));
          assert.ok(calls.includes('repos/acme/app/actions/artifacts/1/zip'));
        });
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it('when the artifact cannot be downloaded then reading fails with the HTTP status', () => githubMock({})({}, async () => {
      await assert.rejects(githubActionsCli.download(ref, 1), error => /artifact 1/.test(error.message) && error.httpStatus === '404');
    }));
  });
});
