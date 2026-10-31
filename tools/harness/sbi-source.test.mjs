import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, update } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { git } from './workspace.mjs';
import { githubCli } from './planner-github.mjs';
import { analyzeImpact, describeImpact, judgeCi, runCompletionJudge } from './impact.mjs';
import { renderSbiBody } from './planner.mjs';
import { sbiSnapshotSchema } from './schemas.mjs';
import { sbiFromIssue } from './sbi-issue.mjs';
import * as sbiSource from './sbi-source.mjs';
import { describeSbiSource, judgeSbiSource, riskView, snapshotFromIssue, snapshotPath, verifySbiSource } from './sbi-source.mjs';
import { assessRisk } from './risk-classifier.mjs';
import { classifySecurity } from './security-enforcement.mjs';
import { readFileSync } from 'node:fs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
const labels = (...names) => names.map(name => ({ name }));
const pbi = { owner: 'acme', repo: 'app', number: 3, url: 'https://github.com/acme/app/issues/3', title: '管理画面のホーム' };
// The SBI Issue as the Planner wrote it and a human marked it ready, with its Trusted Acceptance registered in harness.json.
const planned = {
  id: 'SBI-001', kind: 'implementation', title: '管理画面のホーム', purpose: 'ホームを表示する',
  scope: { included: ['apps/admin ホーム画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'HOME-AC-1', description: '見出しが出る' }],
  scenarios: [{ name: '表示', given: ['管理者である'], when: ['ホームを開く'], then: ['見出しが出る'], acceptanceIds: ['HOME-AC-1'], test: 'Vitest: apps/admin/src/features/home/index.test.tsx' }],
  dependsOn: [], changeAreas: ['apps/admin'], layers: ['画面Component'], estimatedFiles: 2, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'Vitest', acceptance: 'Trusted Acceptance', e2e: '不要' },
};
const readyIssue = { number: 7, title: 'SBI-001 管理画面のホーム', body: renderSbiBody(planned, pbi), html_url: ref.url, state: 'open', labels: labels('sbi', 'ready') };
const homeAcceptance = { id: 'home-acceptance', trust: 'acceptance', trustedScript: '.harness/verification/home.mjs', directory: '.', planned: ['Trusted Acceptance'], commands: [], acceptanceIds: ['HOME-AC-1'], sbiIssue: 7, appliesTo: ['^never/'] };
const config = { verifiers: [homeAcceptance] };
const runId = '2026-10-28T00-00-00-000Z-1a2b3c4d';
// What the Run took from the Issue when it started.
const sbi = sbiFromIssue({ ref, issue: readyIssue, config });
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
const verifyIn = (root, files, extra = {}) => verifySbiSource({ root, base: 'base', files, required: [`production:${admin}`], repository: 'acme/app', config, ...extra });
// Commits a Production change with the given snapshot and the Run trailers of the original snapshot, then verifies it.
const verifySnapshot = async (root, value) => verifyIn(root, await commit(root, { [admin]: 'export {};', [snapshotPath(snapshot())]: value }, `feat: home${trailers()}`));

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

    it('when the Issue body was edited after the Run started then fails because the snapshot no longer matches the current Issue', () => mockGitHub({ issue: { ...readyIssue, body: readyIssue.body.replace('ホームを表示する', 'ホームと一覧を表示する') } }, () => repository(async root => {
      const source = await verifySnapshot(root, snapshot());
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes('bodyDigest')), source.reasons.join('; '));
      assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes('description')), source.reasons.join('; '));
      assert.ok(!describeSbiSource(source).some(l => l.includes('edited after the Run snapshot')));
    })));

    // #194: the snapshot only proves the Issue did not change after the Run; ready must also still cover the content the Run took.
    it('when the Issue body was edited after ready and before the Run took its snapshot then fails, though the snapshot matches the current Issue', () => mockGitHub({ issueEdits: { 7: [{ editedAt: '2026-01-02T00:00:00Z', deletedAt: null, diff: readyIssue.body }] } }, () => repository(async root => {
      const source = await verifySnapshot(root, snapshot());
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes('edited after ready')), source.reasons.join('; '));
    })));

    it('when a person with read access added ready then fails, since only a human with write access approves the Issue', () => mockGitHub({ issueTimelines: { 7: [{ event: 'labeled', label: { name: 'ready' }, created_at: '2026-01-01T00:00:00Z', actor: { login: 'carol', type: 'User' } }] }, permissions: { carol: 'read' } }, () => repository(async root => {
      const source = await verifySnapshot(root, snapshot());
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes('ready was added by carol')), source.reasons.join('; '));
    })));

    it('when the edit history of the Issue cannot be read then fails closed', () => mockGitHub({}, () => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const github = { fetchIssue: async () => readyIssue, issueTimeline: async () => [{ event: 'labeled', label: { name: 'ready' }, created_at: '2026-01-01T00:00:00Z', actor: { login: 'alice', type: 'User' } }], collaboratorPermission: async () => ({ permission: 'write', role_name: 'write' }), bodyHistory: async () => { throw new Error('GraphQL: edit history of acme/app#7 is unavailable'); } };
      const source = await verifyIn(root, files, { github });
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes('edit history')), source.reasons.join('; '));
    })));

    it('when the Issue title was edited after the Run started then fails on the title digest and the SBI title', () => mockGitHub({ issue: { ...readyIssue, title: 'SBI-001 管理画面のホーム（改）' } }, () => repository(async root => {
      const source = await verifySnapshot(root, snapshot());
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('titleDigest')), source.reasons.join('; '));
      assert.ok(source.reasons.some(r => r.includes('title') && !r.includes('titleDigest')), source.reasons.join('; '));
    })));

    it('when only a checkbox in the Issue body was ticked then still fails because any edit of the approved Issue fails', () => mockGitHub({ issue: { ...readyIssue, body: readyIssue.body.replace('- [ ] HOME-AC-1', '- [x] HOME-AC-1') } }, () => repository(async root => {
      const source = await verifySnapshot(root, snapshot());
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes('bodyDigest')), source.reasons.join('; '));
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

  describe('given a snapshot whose SBI or digests were replaced after the Run while the Issue stayed as approved', () => {
    for (const [name, change, key] of [
      ['the directory scopes widened', s => { s.sbi.allowedDirs = ['apps/']; }, 'allowedDirs'],
      ['files allowed by name in addition', s => { s.sbi.allowedFiles = ['apps/api/app/models/user.rb']; }, 'allowedFiles'],
      ['the acceptance verifier swapped', s => { s.sbi.acceptanceCriteria[0].verifier = 'other-acceptance'; }, 'acceptanceCriteria'],
      ['the risks rewritten', s => { s.sbi.risks = ['none']; }, 'risks'],
      ['the SBI description rewritten', s => { s.sbi.description = '何でも変更してよい'; }, 'description'],
    ]) {
      it(`when the snapshot has ${name} then fails and names the field that differs from the SBI rebuilt from the Issue`, () => mockGitHub({}, () => repository(async root => {
        const value = structuredClone(snapshot());
        change(value);
        assert.equal(sbiSnapshotSchema.safeParse(value).success, true);
        const source = await verifySnapshot(root, value);
        assert.equal(source.status, 'FAIL');
        assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes('does not match') && r.includes(key)), source.reasons.join('; '));
      })));
    }

    for (const field of ['titleDigest', 'bodyDigest']) {
      it(`when the snapshot ${field} is not the digest of the current Issue then fails and names it`, () => mockGitHub({}, () => repository(async root => {
        const source = await verifySnapshot(root, { ...snapshot(), [field]: sha256('another Issue') });
        assert.equal(source.status, 'FAIL');
        assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes(field)), source.reasons.join('; '));
      })));
    }
  });

  describe('given a current Issue the Harness cannot rebuild an SBI from', () => {
    it('when a required section was removed from the Issue body then fails with the reason instead of throwing', () => mockGitHub({ issue: { ...readyIssue, body: readyIssue.body.replace('## Gherkin\n', '## 削除済み\n') } }, () => repository(async root => {
      const source = await verifySnapshot(root, snapshot());
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes('Gherkin')), source.reasons.join('; '));
    })));

    it('when the Trusted Acceptance of the Issue is no longer registered then fails', () => mockGitHub({}, () => repository(async root => {
      const files = await commit(root, { [admin]: 'export {};', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const source = await verifyIn(root, files, { config: { verifiers: [{ ...homeAcceptance, sbiIssue: 8 }] } });
      assert.equal(source.status, 'FAIL');
      assert.ok(source.reasons.some(r => r.includes(ref.url) && r.includes('Trusted Acceptance')), source.reasons.join('; '));
    })));
  });

  // #220: harness:reverify and harness:resume explain why the snapshot no longer matches the SBI Issue as loadSbiIssue reads it now.
  // A spec-approved Issue has no registration until its run generates one, so the explanation rebuilds it as the run did (generate).
  describe('given the snapshot of a run from a spec-approved SBI Issue without a registered Trusted Acceptance', () => {
    const unregistered = { verifiers: [] };
    const generated = snapshotFromIssue({ ref, issue: readyIssue, runId, sbi: sbiFromIssue({ ref, issue: readyIssue, config: unregistered, generate: true }) });
    it('when the spec was edited then the explanation names the changed digest and SBI field, not a missing registration', () => {
      const issue = { ...readyIssue, body: readyIssue.body.replace('ホームを表示する', 'ホームと一覧を表示する') };
      const reasons = sbiSource.snapshotMismatch({ snapshot: generated, source: { ref, issue, mode: 'generate' }, config: unregistered });
      assert.ok(reasons.some(r => r.includes('bodyDigest')), reasons.join('; '));
      assert.ok(reasons.some(r => r.includes('description')), reasons.join('; '));
      assert.ok(!reasons.some(r => r.includes('cannot be rebuilt')), reasons.join('; '));
    });
    it('when nothing changed then there is nothing to explain', () => {
      assert.deepEqual(sbiSource.snapshotMismatch({ snapshot: generated, source: { ref, issue: readyIssue, mode: 'generate' }, config: unregistered }), []);
    });
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
      await update(root, '.harness/config/harness.json', c => { c.verifiers.push(homeAcceptance); });
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'base']);
      await git(root, ['branch', 'base']);
    };

    it('when the Production change comes from a ready SBI Issue then the snapshot drives Impact Analysis and Trusted Acceptance and the Judge passes', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const judged = await run(root);
      assert.deepEqual(judged.impact.sbis, ['ISSUE-7']);
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

    it('when the Production change comes from a ready SBI Issue then the log names the verified source SBI', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const judged = await run(root);
      assert.equal(judged.impact.changeType, 'ambiguous');
      assert.ok(describeSbiSource(judged.source).includes('Source: SBI #7'), describeSbiSource(judged.source).join('\n'));
    })));

    // ADR-0006: the change type comes from the diff alone. An Engineering Issue, a commit message or a trailer cannot lift the SBI.
    const engineeringUrl = 'https://github.com/acme/app/issues/9';
    const engineeringIssue = { number: 9, title: 'Sparkle Designを導入する', body: '## 背景\n技術基盤を更新する。\n', html_url: engineeringUrl, state: 'open', labels: labels('engineering', 'ready') };
    const engineering = `\n\nEngineering-Issue: ${engineeringUrl}`;
    const readme = 'apps/admin/README.md';

    it('when only an app README changes then the diff is engineering and the Judge passes without an SBI, an Issue or a GitHub read', () => mockGitHub({}, async github => fixture(async root => {
      await prepare(root);
      await commit(root, { [readme]: '# admin\n認証ProviderはAmazon Cognito（User Pool）を使う。\n' }, 'docs: name the auth provider');
      const judged = await run(root);
      assert.equal(judged.impact.changeType, 'engineering');
      assert.equal(judged.impact.requiresSbi, false);
      assert.ok(describeImpact(judged.impact).includes('Change type: engineering / SBI not required'), describeImpact(judged.impact).join('\n'));
      assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
      assert.deepEqual(await github.calls(), []);
    })));

    it('when an engineering diff fails its Verifier matrix then the Judge still fails', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [readme]: '# admin\n' }, 'docs: update');
      const judged = await run(root, { needs: { ...needs, verifiers: { result: 'failure' } } });
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.includes('verifiers: failure'));
    })));

    it('when a runtime file changes with a ready engineering Issue linked then the diff stays ambiguous and the Judge fails without an SBI', () => mockGitHub({ issue: engineeringIssue }, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;' }, `chore: adopt design system${engineering}`);
      const judged = await run(root);
      assert.equal(judged.impact.changeType, 'ambiguous');
      assert.equal(judged.impact.requiresSbi, true);
      assert.ok(describeImpact(judged.impact).includes('Change type: ambiguous / SBI required (fail-closed)'), describeImpact(judged.impact).join('\n'));
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.startsWith('sbi source missing')), judged.reasons.join('; '));
    })));

    it('when a runtime file change calls itself a refactor or engineering then the Judge still requires an SBI', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;' }, 'refactor: engineering only, no behaviour change');
      const judged = await run(root);
      assert.equal(judged.impact.changeType, 'ambiguous');
      assert.equal(judged.status, 'FAIL');
    })));

    it('when an engineering diff carries stale Run trailers without a snapshot then it stays engineering and the Judge passes', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [readme]: '# admin\n' }, `docs: update${trailers()}`);
      const judged = await run(root);
      assert.equal(judged.impact.changeType, 'engineering');
      assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
      assert.ok(!describeSbiSource(judged.source).some(l => l.startsWith('Source: SBI')));
    })));

    it('when an ambiguous diff carries only the Run trailers without a snapshot then the trailers are not a valid source and the Judge fails', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;' }, `feat: home${trailers()}`);
      const judged = await run(root);
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.startsWith('sbi source missing')), judged.reasons.join('; '));
    })));

    it('when an engineering diff adds a broken SBI snapshot then the snapshot is still verified and the Judge fails', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [readme]: '# admin\n', [snapshotPath(snapshot())]: '{ broken' }, `docs: update${trailers()}`);
      const judged = await run(root);
      assert.equal(judged.impact.changeType, 'engineering');
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.startsWith('sbi source invalid')), judged.reasons.join('; '));
    })));

    it('when a diff outside the Production paths adds a broken SBI snapshot then the snapshot is still verified and the Judge fails', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { 'prototypes/web/src/main.tsx': 'export {};', [snapshotPath(snapshot())]: '{ broken' }, `feat: prototype${trailers()}`);
      const judged = await run(root);
      assert.equal(judged.impact.changeType, null);
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.startsWith('sbi source invalid')), judged.reasons.join('; '));
    })));

    it('when an engineering diff deletes an SBI snapshot then the deletion is verified as an SBI source and the Judge fails', () => mockGitHub({}, () => fixture(async root => {
      await writeFile(join(root, '.harness/state/sbi-7.json'), JSON.stringify(snapshot(), null, 2));
      await prepare(root);
      await git(root, ['rm', '--quiet', '.harness/state/sbi-7.json']);
      await commit(root, { [readme]: '# admin\n' }, 'docs: update');
      const judged = await run(root);
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.startsWith('sbi source')), judged.reasons.join('; '));
    })));

    // #220: harness/<run-id> is the branch harness:run opens its PR from. Whatever the diff, such a PR passes only with the snapshot of that
    // same run from an approved SBI Issue, so a PR that a regression opened from --sbi PATH, or a hand-made harness/* branch, cannot be merged.
    const pull = branch => ({ number: 201, merged_at: null, body: '', user: { login: 'harness-operator', type: 'User' },
      head: { ref: branch, sha: 'f'.repeat(40), repo: { full_name: 'acme/app' } }, base: { ref: 'main', sha: 'e'.repeat(40) } });
    const otherRunId = '2026-10-29T00-00-00-000Z-5e6f7a8b';
    const prototypePage = 'prototypes/web/src/main.tsx';

    it('when a Harness PR changes only a prototype and carries no SBI snapshot then the Judge fails, though the diff alone needs no SBI', () => mockGitHub({ pulls: [pull(`harness/${runId}`)] }, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [prototypePage]: 'export {};' }, 'SBI SBI-001, iteration 1');
      const judged = await run(root, { pullNumber: '201' });
      assert.equal(judged.impact.sbiRequired, false);
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.includes(`harness/${runId}`)), judged.reasons.join('; '));
    })));

    it('when a Harness PR carries the snapshot and Run trailers of its own run from a ready SBI Issue then the Judge passes', () => mockGitHub({ pulls: [pull(`harness/${runId}`)] }, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const judged = await run(root, { pullNumber: '201' });
      assert.equal(judged.source.status, 'PASS', judged.source.reasons.join('; '));
      assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
    })));

    it('when a Harness PR changes only a prototype with the snapshot of its own run from a ready SBI Issue then the Judge passes', () => mockGitHub({ pulls: [pull(`harness/${runId}`)] }, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [prototypePage]: 'export {};', [snapshotPath(snapshot())]: snapshot() }, `feat: prototype${trailers()}`);
      const judged = await run(root, { pullNumber: '201' });
      assert.equal(judged.source.status, 'PASS', judged.source.reasons.join('; '));
    })));

    it('when a Harness PR carries the snapshot of another run than its branch names then the Judge fails', () => mockGitHub({ pulls: [pull(`harness/${otherRunId}`)] }, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const judged = await run(root, { pullNumber: '201' });
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.includes(`harness/${otherRunId}`) && r.includes(runId)), judged.reasons.join('; '));
    })));

    // A second, valid snapshot of another ready Issue does not make the PR the change of another run; the Harness PR is held to its own run only.
    it('when a Harness PR carries the snapshot of its own run and a valid snapshot of another ready SBI Issue then the Judge fails on the count alone', () => {
      const otherRef = { owner: 'acme', repo: 'app', number: 8, url: 'https://github.com/acme/app/issues/8' };
      const otherIssue = { number: 8, title: 'SBI-002 管理画面の一覧', body: renderSbiBody({ ...planned, id: 'SBI-002', title: '管理画面の一覧', purpose: '一覧を表示する',
        acceptanceCriteria: [{ id: 'LIST-AC-1', description: '一覧が出る' }], scenarios: [{ ...planned.scenarios[0], acceptanceIds: ['LIST-AC-1'] }] }, pbi), html_url: otherRef.url, state: 'open', labels: labels('sbi', 'ready') };
      const listAcceptance = { ...homeAcceptance, id: 'list-acceptance', trustedScript: '.harness/verification/list.mjs', acceptanceIds: ['LIST-AC-1'], sbiIssue: 8 };
      const other = snapshotFromIssue({ ref: otherRef, issue: otherIssue, runId: otherRunId, sbi: sbiFromIssue({ ref: otherRef, issue: otherIssue, config: { verifiers: [listAcceptance] } }) });
      // The gh stub serves one Issue by number; the second ready Issue is read through its created Issues (timeline and permission) and here.
      const github = { ...githubCli, fetchIssue: ref => ref.number === 8 ? Promise.resolve(otherIssue) : githubCli.fetchIssue(ref) };
      return mockGitHub({ pulls: [pull(`harness/${runId}`)], created: [otherIssue] }, () => fixture(async root => {
        await writeFile(join(root, '.harness/verification/list.mjs'), 'console.log(JSON.stringify({ acceptance: ["LIST-AC-1"] }));');
        await update(root, '.harness/config/harness.json', c => { c.verifiers.push(listAcceptance); });
        await prepare(root);
        await commit(root, { [admin]: 'export const home = 1;', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
        await commit(root, { [snapshotPath(other)]: other }, `feat: list${trailers(other)}`);
        const judged = await run(root, { pullNumber: '201', github });
        assert.deepEqual(judged.source.reasons.filter(r => !r.startsWith('harness pr:')), [], 'both snapshots are valid on their own');
        assert.equal(judged.source.status, 'FAIL');
        assert.ok(judged.reasons.some(r => r.includes(`harness/${runId}`) && r.includes('exactly one')), judged.reasons.join('; '));
      }));
    });

    it('when the pull request cannot be read then the Judge fails closed, since it cannot tell whether Harness opened it', () => mockGitHub({ pulls: [] }, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [prototypePage]: 'export {};' }, 'feat: prototype');
      const judged = await run(root, { pullNumber: '201' });
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.includes('#201') && r.includes('HTTP 404')), judged.reasons.join('; '));
    })));

    // A pull_request or pull_request_target event always has a PR number. Without it the Judge cannot tell a Harness PR apart, so it fails closed.
    for (const eventName of ['pull_request', 'pull_request_target']) {
      it(`when a ${eventName} event gives no pull request number then the Judge fails closed instead of skipping the Harness PR check`, () => mockGitHub({ pulls: [pull(`harness/${runId}`)] }, () => fixture(async root => {
        await prepare(root);
        await commit(root, { [prototypePage]: 'export {};' }, 'SBI SBI-001, iteration 1');
        const judged = await run(root, { eventName });
        assert.equal(judged.status, 'FAIL');
        assert.ok(judged.reasons.some(r => r.startsWith('harness pr:') && r.includes(eventName)), judged.reasons.join('; '));
      })));
    }
    it('when a push event gives no pull request number then there is no PR to check and the Judge passes as before', () => mockGitHub({}, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [prototypePage]: 'export {};' }, 'feat: prototype');
      const judged = await run(root, { eventName: 'push' });
      assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
    })));

    it('when a PR from another branch changes only a prototype then the Judge passes without an SBI, as before', () => mockGitHub({ pulls: [pull('claude/prototype-home')] }, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [prototypePage]: 'export {};' }, 'feat: prototype');
      const judged = await run(root, { pullNumber: '201' });
      assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
    })));

    // The Issue a variant of the plan renders and the snapshot a Run takes from it.
    const variant = (overrides = {}, edit = body => body) => {
      const issue = { ...readyIssue, body: edit(renderSbiBody({ ...planned, ...overrides }, pbi)) };
      return { issue, snapshot: snapshotFromIssue({ ref, issue, runId, sbi: sbiFromIssue({ ref, issue, config: { verifiers: [homeAcceptance] } }) }) };
    };
    const appFiles = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [`apps/admin/src/features/home/part-${i}.ts`, `export const part${i} = ${i};`]));
    const judgeFiles = async (root, count, s) => {
      await prepare(root);
      await commit(root, { ...appFiles(count), [snapshotPath(s)]: s }, `feat: home${trailers(s)}`);
      return run(root);
    };
    const countReasons = judged => judged.reasons.filter(r => r.includes('変更ファイル数'));

    describe('given the number of files the PR changes against the expected number in its SBI Issue', () => {
      it('when 11 files change against an expected 2 then the Judge fails with both numbers, not counting the Run snapshot', () => mockGitHub({}, () => fixture(async root => {
        const judged = await judgeFiles(root, 11, snapshot());
        assert.equal(judged.status, 'FAIL');
        assert.deepEqual(countReasons(judged), ['変更ファイル数が11ファイルで、目安10ファイルとSBIの想定2ファイルを超えています']);
      })));
      it('when 10 files change against an expected 2 then the Judge passes because the PR stays within 10 files', () => mockGitHub({}, () => fixture(async root => {
        const judged = await judgeFiles(root, 10, snapshot());
        assert.deepEqual(countReasons(judged), []);
        assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
      })));
      it('when 14 files change and the Planner justified 14 then the Judge passes', () => {
        const { issue, snapshot: s } = variant({ estimatedFiles: 14, oversizeReason: '生成コードを含むため分割できない' });
        return mockGitHub({ issue }, () => fixture(async root => {
          const judged = await judgeFiles(root, 14, s);
          assert.deepEqual(countReasons(judged), []);
          assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
        }));
      });
      it('when the SBI Issue has no expected number then the Judge fails closed', () => {
        const { issue, snapshot: s } = variant({}, body => body.replace(/## 想定変更ファイル数\n\n2\n\n/, ''));
        return mockGitHub({ issue }, () => fixture(async root => {
          const judged = await judgeFiles(root, 1, s);
          assert.equal(judged.status, 'FAIL');
          assert.deepEqual(countReasons(judged), ['SBIの想定変更ファイル数がないため、変更ファイル数を判定できません']);
        }));
      });
      it('when it is a validation SBI then the number of changed files is not judged', () => {
        const { issue, snapshot: s } = variant({ kind: 'validation', estimatedFiles: 2, verification: { applicationTest: '不要', acceptance: 'Trusted Acceptance', e2e: 'Maestro: 実API' } });
        return mockGitHub({ issue }, () => fixture(async root => {
          const judged = await judgeFiles(root, 11, s);
          assert.deepEqual(countReasons(judged), []);
          assert.equal(judged.status, 'PASS', judged.reasons.join('; '));
        }));
      });
    });

    it('when the source SBI Issue still needs review then the Judge fails', () => mockGitHub({ issue: { ...readyIssue, labels: labels('sbi', 'needs-review') } }, () => fixture(async root => {
      await prepare(root);
      await commit(root, { [admin]: 'export const home = 1;', [snapshotPath(snapshot())]: snapshot() }, `feat: home${trailers()}`);
      const judged = await run(root);
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => r.includes('needs-review')));
    })));
  });
});

// The Run snapshot sits under .harness/ only because #71 put it there. Once it is verified against the ready SBI Issue, its location
// (harness_policy) and its key names (requiredSecurityRules) stop counting; what it says about the SBI still counts.
describe('Risk view of a verified SBI snapshot', () => {
  const policy = JSON.parse(readFileSync(new URL('../../.harness/rules/pr-risk.json', import.meta.url), 'utf8'));
  const securityPolicy = JSON.parse(readFileSync(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
  const app = { path: admin, status: 'A', added: 'export const home = 1;', deleted: '', binary: false };
  const stored = (s = snapshot(), path = snapshotPath(s)) => ({ path, status: 'A', added: JSON.stringify(s, null, 2), deleted: '', binary: false });
  const level = files => assessRisk({ files, metadata: {}, humanGate: false }, policy);
  it('when the snapshot is verified then its location no longer raises the change to LEVEL 3', () => {
    const view = riskView([app, stored()], { snapshot: snapshot(), verified: true });
    assert.equal(level(view).level, 1);
    assert.ok(!level(view).reasons.some(reason => ['harness_policy', 'policy_root'].includes(reason)));
  });
  it('when the snapshot is not verified then it stays LEVEL 3 through harness_policy', () => {
    assert.equal(level(riskView([app, stored()], { snapshot: snapshot(), verified: false })).level, 3);
  });
  for (const path of ['.harness/state/sbi-7.json.bak', '.harness/state/sbi-x.json', '.harness/state/other.json', '.harness/state/sub/sbi-7.json', '.harness/state/sbi-8.json', '.harness/rules/pr-risk.json']) {
    it(`when ${path} changes next to a verified snapshot then it stays LEVEL 3`, () => {
      const view = riskView([app, stored(), stored(snapshot(), path)], { snapshot: snapshot(), verified: true });
      assert.equal(level(view).level, 3);
      assert.ok(level(view).matches.some(m => m.reason === 'harness_policy' && m.path === path));
    });
  }
  it('when a verified snapshot only carries the requiredSecurityRules key then it is not security-sensitive, while the raw file is', () => {
    assert.equal(classifySecurity({ files: [app, stored()] }, securityPolicy).securitySensitive, true, 'the key name alone matches the lane securityPatterns');
    assert.equal(classifySecurity({ files: riskView([app, stored()], { snapshot: snapshot(), verified: true }) }, securityPolicy).securitySensitive, false);
  });
  it('when the verified snapshot describes security-sensitive work then the change stays security-sensitive at LEVEL 3', () => {
    const sensitive = snapshot({ sbi: { ...sbi, issueUrl: ref.url, description: 'security_rule を書き換える' } });
    const view = riskView([app, stored(sensitive)], { snapshot: sensitive, verified: true });
    const assessment = classifySecurity({ files: view }, securityPolicy);
    assert.equal(assessment.securitySensitive, true);
    assert.equal(assessRisk({ files: view, metadata: {}, humanGate: false, securityAssessment: assessment }, policy).level, 3);
  });
  it('when the committed snapshot differs from what the Harness wrote then it is not read as the verified snapshot', () => {
    const edited = { ...stored(), added: stored().added.replace('ホームを表示する', '手で書き換えた') };
    assert.equal(level(riskView([app, edited], { snapshot: snapshot(), verified: true })).level, 3);
  });
});
