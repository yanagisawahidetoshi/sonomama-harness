import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, update } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { git } from './workspace.mjs';
import { analyzeImpact, describeImpact, judgeCi, runCompletionJudge } from './impact.mjs';
import { sbiSnapshotSchema } from './schemas.mjs';
import { describeSbiSource, judgeSbiSource, snapshotFromIssue, snapshotPath, verifySbiSource } from './sbi-source.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
const labels = (...names) => names.map(name => ({ name }));
const readyIssue = { number: 7, title: 'SBI-001: 管理画面のホーム', body: '## 目的\n\nホームを表示する', html_url: ref.url, state: 'open', labels: labels('sbi', 'ready') };
const runId = '2026-10-28T00-00-00-000Z-1a2b3c4d';
const sbi = {
  id: 'SBI-001', title: '管理画面のホーム', description: 'ホームを表示する',
  gherkin: 'Feature: ホーム\n  Scenario: 表示\n    Given 管理者である\n    When ホームを開く\n    Then 見出しが出る',
  acceptanceCriteria: [{ id: 'HOME-AC-1', description: '見出しが出る', verifier: 'home-acceptance' }],
  allowedFiles: ['apps/admin/src/features/home/index.ts'], risks: [], ambiguous: false, requiresDesignDecision: false, affectedAreas: ['admin'],
};
const snapshot = (overrides = {}) => ({ ...snapshotFromIssue({ ref, issue: readyIssue, runId, sbi }), ...overrides });
const trailers = (s = snapshot()) => `\n\nHarness-Run: ${s.runId}\nSBI-Issue: ${s.source.url}`;
const admin = 'apps/admin/src/features/home/index.ts';
const passingSecurity = { status: 'PASS', requiredVerifiers: [], checks: [], violations: [] };
const mockGitHub = githubMock({ issue: readyIssue });
const needs = { impact: { result: 'success' }, verifiers: { result: 'success' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };

// A bare Git repository with one base commit; the PR commits are added on top of it.
async function repository(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-sbi-source-')));
  try {
    await git(root, ['init', '--template=', '--initial-branch=main']);
    await git(root, ['config', 'gc.auto', '0']);
    await git(root, ['commit', '--allow-empty', '-m', 'base']);
    await git(root, ['branch', 'base']);
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}
async function commit(root, entries, message) {
  for (const [path, content] of Object.entries(entries)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--allow-empty', '-m', message]);
  return Object.keys(entries).map(path => ({ path }));
}
const verifyIn = (root, files, extra = {}) => verifySbiSource({ root, base: 'base', files, required: [`production:${admin}`], repository: 'acme/app', ...extra });

describe('SBI snapshot from an approved SBI Issue', () => {
  describe('given a ready SBI Issue, a Run ID and the SBI the Run works on', () => {
    it('when the snapshot is built then it records the source Issue, the title and body digests and the Run ID in a valid schema', () => {
      const value = snapshotFromIssue({ ref, issue: readyIssue, runId, sbi });
      assert.deepEqual(value.source, { repo: 'acme/app', number: 7, url: ref.url });
      assert.equal(value.runId, runId);
      assert.equal(value.titleDigest, sha256(readyIssue.title));
      assert.equal(value.bodyDigest, sha256(readyIssue.body));
      assert.equal(value.sbi.issueUrl, ref.url);
      assert.equal(sbiSnapshotSchema.safeParse(value).success, true);
    });

    it('when the snapshot path is asked for then it is .harness/state/sbi-<Issue number>.json', () => {
      assert.equal(snapshotPath(snapshotFromIssue({ ref, issue: readyIssue, runId, sbi })), '.harness/state/sbi-7.json');
    });
  });

  describe('given a snapshot a human or another tool edited', () => {
    for (const [name, broken] of [
      ['without a Run ID', s => { delete s.runId; }],
      ['with a Run ID that is not a Harness run ID', s => { s.runId = '../escape'; }],
      ['with a body digest that is not sha256', s => { s.bodyDigest = 'abc'; }],
      ['whose source URL is not the source repo and number', s => { s.source.url = 'https://github.com/acme/app/issues/8'; }],
      ['whose SBI points to another Issue', s => { s.sbi.issueUrl = 'https://github.com/acme/app/issues/8'; }],
      ['without the SBI the Run works on', s => { delete s.sbi; }],
    ]) {
      it(`when it is ${name} then the schema rejects it`, () => {
        const value = structuredClone(snapshot());
        broken(value);
        assert.equal(sbiSnapshotSchema.safeParse(value).success, false);
      });
    }
  });
});

describe('Source SBI Issue judgement', () => {
  const judge = (issue, extra = {}) => judgeSbiSource({ snapshot: snapshot(), issue, repository: 'acme/app', runs: [{ runId, url: ref.url }], ...extra });

  describe('given the current state of the source SBI Issue', () => {
    it('when it is open with sbi and ready and without needs-review then accepts it as the basis of the Production change', () => {
      assert.deepEqual(judge(readyIssue), []);
    });

    for (const [name, issue, reason] of [
      ['still has needs-review', { ...readyIssue, labels: labels('sbi', 'ready', 'needs-review') }, 'has needs-review'],
      ['has no ready label', { ...readyIssue, labels: labels('sbi', 'needs-review') }, 'has no ready label'],
      ['has no sbi label', { ...readyIssue, labels: labels('ready') }, 'has no sbi label'],
      ['is closed', { ...readyIssue, state: 'closed' }, 'is not open'],
      ['reports no state', { ...readyIssue, state: undefined }, 'is not open'],
    ]) {
      it(`when it ${name} then rejects it and names the Issue and the reason`, () => {
        assert.ok(judge(issue).some(r => r.includes(ref.url) && r.includes(reason)), JSON.stringify(judge(issue)));
      });
    }
  });

  describe('given the repository and the Run link of the PR', () => {
    it('when the source Issue belongs to another repository then rejects it', () => {
      assert.ok(judge(readyIssue, { repository: 'acme/other' }).some(r => r.includes('not in acme/other')));
    });

    it('when the repository is unknown then fails closed', () => {
      assert.ok(judge(readyIssue, { repository: undefined }).some(r => r.includes('GITHUB_REPOSITORY')));
    });

    it('when no PR commit carries the Run ID of the snapshot then rejects it', () => {
      assert.ok(judge(readyIssue, { runs: [] }).some(r => r.includes(`Harness-Run: ${runId}`)));
    });

    it('when the PR commits carry another Run ID or another Issue then rejects it', () => {
      assert.ok(judge(readyIssue, { runs: [{ runId: 'other-run', url: ref.url }] }).length > 0);
      assert.ok(judge(readyIssue, { runs: [{ runId, url: 'https://github.com/acme/app/issues/8' }] }).length > 0);
    });
  });
});

describe('Source SBI verification in the PR', () => {
  describe('given a Production change with the snapshot and the Run trailers', () => {
    it('when the source Issue is ready then passes and records the source and Run for the CI log', () => mockGitHub({}, () => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const source = await verifyIn(root, files);
      assert.equal(source.status, 'PASS', source.reasons.join('; '));
      assert.ok(describeSbiSource(source).some(l => l.includes(ref.url) && l.includes(runId)));
    })));

    it('when the Issue was edited after the Run started then still passes and notes the change in the CI log', () => mockGitHub({ issue: { ...readyIssue, body: 'edited' } }, () => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const source = await verifyIn(root, files);
      assert.equal(source.status, 'PASS');
      assert.ok(describeSbiSource(source).some(l => l.includes('edited after the Run snapshot')));
    })));

    it('when the source Issue still has needs-review then fails', () => mockGitHub({ issue: { ...readyIssue, labels: labels('sbi', 'needs-review') } }, () => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const source = await verifyIn(root, files);
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('needs-review')));
    })));

    it('when the GitHub API cannot read the source Issue then fails closed with the API error', () => mockGitHub({ issue: { ...readyIssue, number: 99 } }, () => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const source = await verifyIn(root, files);
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes('HTTP 404')), source.reasons.join('; '));
    })));
  });

  describe('given a Production change without a valid snapshot', () => {
    it('when no snapshot is in the PR then fails without calling GitHub and names the Production path', () => mockGitHub({}, async github => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};' }, 'feat: home');
      const source = await verifyIn(root, files);
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes(`production:${admin}`) && r.includes('.harness/state/sbi-<Issue number>.json')));
      assert.deepEqual(await github.calls(), []);
    })));

    it('when only a hand-written SBI JSON without a source Issue changed then does not count it', () => mockGitHub({}, () => repository(async root => {
      const legacy = { ...sbi, id: 'SBI-ADMIN-HOME' };
      delete legacy.issueUrl;
      const files = await commit(root, { [admin]: 'export {};', '.harness/state/sbi-admin-home.json': legacy }, 'feat: home');
      const source = await verifyIn(root, files);
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('.harness/state/sbi-admin-home.json') && r.includes('no source SBI Issue')));
    })));

    it('when the snapshot breaks the schema then fails and names the file', () => mockGitHub({}, () => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};', '.harness/state/sbi-7.json': { ...snapshot(), runId: undefined } }, `feat: home${trailers()}`);
      const source = await verifyIn(root, files);
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('.harness/state/sbi-7.json') && r.includes('invalid')));
    })));

    it('when the snapshot file number is not its source Issue then fails', () => mockGitHub({}, () => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};', '.harness/state/sbi-8.json': snapshot() }, `feat: home${trailers()}`);
      assert.equal((await verifyIn(root, files)).status, 'FAIL');
    })));

    it('when no PR commit links the Run then fails', () => mockGitHub({}, () => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};', [snapshotPath(snapshot())]: snapshot() }, 'feat: home');
      const source = await verifyIn(root, files);
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes(`Harness-Run: ${runId}`)));
    })));
  });

  describe('given a change that does not require an SBI', () => {
    it('when no Production path changed then passes without reading GitHub', () => mockGitHub({}, async github => repository(async root => {
      const files = await commit(root, { 'docs/architecture/README.md': '# docs' }, 'docs: update');
      const source = await verifySbiSource({ root, base: 'base', files, required: [], repository: undefined });
      assert.equal(source.status, 'PASS');
      assert.deepEqual(await github.calls(), []);
    })));
  });
});

describe('CI Completion Judge for the source SBI Issue', () => {
  const config = { verifiers: [], impact: {} };

  describe('given a Production change in each Production area', () => {
    for (const path of [admin, 'apps/mobile/src/features/home/index.ts', 'apps/api/app/models/lesson.rb', 'packages/api-schema/openapi.yaml']) {
      it(`when ${path} changes without an approved SBI Issue and Run then fails with the reason`, () => {
        const impact = analyzeImpact({ config, files: [{ path }] });
        const source = { status: 'FAIL', reasons: [`sbi source missing: production:${path}`] };
        const result = judgeCi({ impact, needs, acceptance: { status: 'PASS', missing: [] }, security: passingSecurity, source });
        assert.equal(result.status, 'FAIL');
        assert.ok(result.reasons.includes(`sbi source missing: production:${path}`));
      });
    }

    it('when the source SBI Issue was not evaluated then fails closed', () => {
      const impact = analyzeImpact({ config, files: [{ path: admin }] });
      const result = judgeCi({ impact, needs, acceptance: { status: 'PASS', missing: [] }, security: passingSecurity });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reasons.includes('sbi source: not evaluated'));
    });
  });

  describe('given the Harness job on a pull request', () => {
    const run = (root, extra = {}) => runCompletionJudge({ root, base: 'base', needs, repository: 'acme/app', ...extra });
    const prepare = async root => {
      await writeFile(join(root, '.harness/verification/home.mjs'), 'console.log(JSON.stringify({ acceptance: ["HOME-AC-1"] }));');
      await update(root, '.harness/config/harness.json', c => { c.verifiers.push({ id: 'home-acceptance', trust: 'acceptance', trustedScript: '.harness/verification/home.mjs', directory: '.', planned: ['Trusted Acceptance'], commands: [], acceptanceIds: ['HOME-AC-1'], appliesTo: ['^never/'] }); });
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'base']);
      await git(root, ['branch', 'base']);
    };

    it('when the Production change comes from a ready SBI Issue then the snapshot drives Impact Analysis and Trusted Acceptance and the Judge passes', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const judged = await run(root);
      assert.deepEqual(judged.impact.sbis, ['SBI-001']);
      assert.ok(describeImpact(judged.impact).includes('Acceptance (Completion Judge): home-acceptance'));
      assert.deepEqual(judged.checks.map(c => [c.id, c.status]), [['home-acceptance', 'PASS']]);
      assert.equal(judged.source.status, 'PASS');
      assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
    })));

    it('when the Production change has no SBI Issue or Run then the Judge fails with the reason', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;' }, 'feat: home');
      const judged = await run(root);
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.startsWith('sbi source missing')), judged.reasons.join('; '));
    })));

    it('when the source SBI Issue still needs review then the Judge fails', () => mockGitHub({ issue: { ...readyIssue, labels: labels('sbi', 'needs-review') } }, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const judged = await run(root);
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.includes('needs-review')));
    })));
  });
});
