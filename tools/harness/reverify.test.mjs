import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, update, human, commitFixture } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { runHarness, resumeRun, approveRun, reverifyPullRequest } from './index.mjs';
import { githubPrCli } from './github-pr.mjs';
import { readRunState } from './run-store.mjs';
import { review } from './reviewer.mjs';
import { verifyReverifyLink } from './reverify.mjs';
import { git } from './workspace.mjs';
import { exists, readJson } from './io.mjs';
import { renderSbiBody } from './planner.mjs';

// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
// without the implementation agent, and the same PR is updated by a normal push. A and B start from the same main; A is merged first.
const issueUrl = 'https://github.com/acme/app/issues/7';
const pbi = { number: 3, url: 'https://github.com/acme/app/issues/3', title: '管理画面のホーム' };
const planned = (overrides = {}) => ({
  id: 'SBI-001', kind: 'implementation', title: 'ホームに見出しを表示する', purpose: '管理者がホームを開くと見出しが表示される。',
  scope: { included: ['apps/admin ホーム画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: 'ホームに見出しが表示される' }],
  scenarios: [{ name: 'ホームを開く', given: ['管理者がログインしている'], when: ['ホームを開く'], then: ['見出しが表示される'], acceptanceIds: ['AC-1'], test: 'Vitest: apps/admin/src/features/home/index.test.tsx' }],
  dependsOn: [], changeAreas: ['apps/admin'], layers: ['画面Component'], estimatedFiles: 1, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'Vitest', acceptance: 'Trusted Acceptance', e2e: '不要' }, ...overrides });
const sbiIssue = (sbi = planned()) => ({ number: 7, title: `${sbi.id} ${sbi.title}`, body: renderSbiBody(sbi, pbi), html_url: issueUrl, state: 'open', labels: [{ name: 'sbi' }, { name: 'ready' }] });
const home = 'apps/admin/src/home.txt';
const acceptance = expected => `import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{join}from"node:path";assert.equal(readFileSync(join(process.argv[2],${JSON.stringify(home)}),"utf8"),${JSON.stringify(expected)});console.log(JSON.stringify({acceptance:["AC-1"]}));`;
// The implementation agent of B. Re-verification must never call it.
const spy = () => { const calls = []; return { calls, agent: async (...args) => { calls.push(args); return { files: [{ path: home, content: 'ホーム' }] }; } }; };
const mockGitHub = githubMock({ permissions: { alice: 'write', bob: 'write', 'harness-operator': 'admin' }, livePulls: true });

async function registered(root) {
  await writeFile(join(root, '.harness/verification/issue-7.mjs'), acceptance('ホーム'));
  await mkdir(join(root, '.harness/acceptance'), { recursive: true });
  await writeFile(join(root, '.harness/acceptance/sbi-7.json'), JSON.stringify({ version: 1, sbiIssue: 7, verifiers: [{ id: 'issue-7-acceptance', trustedScript: '.harness/verification/issue-7.mjs', planned: ['ホーム見出し'], acceptanceIds: ['AC-1'] }] }));
  await update(root, '.harness/config/harness.json', c => { c.verifiers.find(v => v.id === 'admin').commands = [['node', '-e', 'process.exit(0)']]; });
  await commitFixture(root);
}
// origin is github.com/acme/app for the Harness, while git pushes to a local bare repository. B already has its PR, opened by harness:run.
function withPullRequestB(root, test, { issue = sbiIssue() } = {}) {
  return registered(root).then(async () => {
    const bare = await realpath(await mkdtemp(join(tmpdir(), 'harness-remote-')));
    try {
      await git(bare, ['init', '--bare', '--initial-branch=main']);
      await git(root, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
      await git(root, ['config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git']);
      await git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
      await mockGitHub({ bare, issue }, async github => {
        const implementation = spy();
        let b = await runHarness({ root, quiet: true, provider: 'codex', agent: implementation.agent, publish: true, issueUrl });
        // An SBI with an implementation gate was approved once, for the baseline B started from.
        if (b.status === 'WAITING_FOR_HUMAN_GATE') b = await approveRun({ root, runId: b.id, purpose: 'implementation-gate', identityProvider: human('Designer'), agent: implementation.agent, quiet: true });
        await test({ bare, github, b, pullUrl: b.pullRequest?.url, implementation });
      });
    } finally { await rm(bare, { recursive: true, force: true }); }
  });
}
const remoteSha = async (bare, branch) => (await git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true)).stdout.trim();
const parents = async (root, sha) => (await git(root, ['rev-list', '--parents', '-n', '1', sha])).stdout.trim().split(' ').slice(1);
const isAncestor = async (root, ancestor, sha) => (await git(root, ['merge-base', '--is-ancestor', ancestor, sha], true)).ok;
// A is merged into main and the operator pulls it: the source checkout and origin/main both move to the new main.
async function mergeA(root, files = { 'docs/feature-a.md': '# Aの機能\n' }) {
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  await git(root, ['add', '--', ...Object.keys(files)]);
  await git(root, ['commit', '-m', 'Merge pull request A']);
  await git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
}
// A commit on a remote branch that the source checkout never sees.
async function pushOnto(root, branch, parent, message) {
  const next = (await git(root, ['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message])).stdout.trim();
  await git(root, ['push', '--quiet', 'origin', `${next}:refs/heads/${branch}`]);
  return next;
}
// A person resolves a conflict on the PR branch in their own clone and pushes it normally.
async function resolveOnBranch(bare, branch, files) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'harness-person-')));
  try {
    await git(dir, ['clone', '--quiet', bare, 'clone']);
    const clone = join(dir, 'clone');
    await git(clone, ['checkout', '--quiet', branch]);
    await git(clone, ['merge', '--no-edit', 'origin/main'], true);
    for (const [path, content] of Object.entries(files)) { await mkdir(join(clone, path, '..'), { recursive: true }); await writeFile(join(clone, path), content); }
    await git(clone, ['add', '--all']);
    await git(clone, ['commit', '--no-edit']);
    await git(clone, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
    return (await git(clone, ['rev-parse', 'HEAD'])).stdout.trim();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const succeed = (github, sha) => github.update(s => { s.checkRuns[sha] = [...(s.checkRuns[sha] || []), { id: (s.checkRuns[sha] || []).length + 1, name: 'harness', status: 'completed', conclusion: 'success', head_sha: sha, app: { id: 15368 } }]; });
const reviewBy = (github, number, login, state, commit) => github.update(s => { s.reviews[number] = [...(s.reviews[number] || []), { id: (s.reviews[number] || []).length + 1, user: { login, type: 'User' }, state, commit_id: commit }]; });
const runs = async root => (await readdir(join(root, '.harness/runs'))).filter(name => name !== '.gitkeep').sort();

describe('Re-verification of an existing PR after main moved', () => {
  describe('given A and B started from the same main and only A was merged', () => {
    it('when B is re-verified then its finished code is merged with the new main, verified without the implementation agent and pushed to the same PR as a fast-forward', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      const mainAfterA = await mergeA(root);
      const reverification = spy();
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true, agent: reverification.agent });
      assert.equal(reverification.calls.length, 0, 'the implementation agent is not called');
      assert.equal(run.executionStatus, 'DONE');
      assert.notEqual(run.id, b.id);
      assert.equal(run.kind, 'reverify');
      assert.equal(run.baselineSha, mainAfterA);
      assert.deepEqual(await parents(root, run.headSha), [mainAfterA, b.headSha], 'the candidate is a merge commit of the new main and the old tested SHA');
      assert.equal(await remoteSha(bare, `harness/${b.id}`), run.headSha);
      assert.ok(await isAncestor(root, b.headSha, run.headSha), 'the PR branch moved forward without a force push');
      assert.equal(run.reverify.parentRunId, b.id);
      assert.equal(run.reverify.previousTestedSha, b.headSha);
      assert.equal(run.reverify.publish, 'PR_UPDATED');
      assert.match(run.reverify.sbiSnapshotDigest, /^[0-9a-f]{64}$/);
      assert.deepEqual(run.pullRequest, b.pullRequest);
      const pulls = (await github.state()).pulls;
      assert.equal(pulls.length, 1, 'no second PR');
      for (const text of [`run=${run.id} sha=${run.headSha}`, `Run ID: ${run.id}`, `tested SHA: ${run.headSha}`, `親run: ${b.id}`, `旧tested SHA: ${b.headSha}`, `baseline: ${mainAfterA}`, 'Closes #7', issueUrl, '元PBI: https://github.com/acme/app/issues/3'])
        assert.ok(pulls[0].body.includes(text), `PR body includes ${text}`);
    })));
    it('when B is re-verified then the SBI snapshot and Run trailer of B are kept, as the CI SBI source check requires', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const snapshot = JSON.parse((await git(root, ['show', `${run.headSha}:.harness/state/sbi-7.json`])).stdout);
      assert.equal(snapshot.runId, b.id);
      assert.equal(run.snapshotVerification.verified, true, run.snapshotVerification.reasons.join('; '));
    })));
    it('when B is re-verified then the old run, its evidence and its tested SHA are left as they were', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      const before = await readJson(join(root, b.runDir, 'summary.json'));
      await mergeA(root);
      await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.deepEqual(await readJson(join(root, b.runDir, 'summary.json')), before);
      assert.equal((await readRunState(root, b.id)).headSha, b.headSha);
    })));
    it('when main gained an unrelated file then only the change of B is judged for scope, lane and risk', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await mergeA(root, { 'docs/feature-a.md': '# Aの機能\n', 'apps/admin/src/feature-a.txt': 'A' });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const changes = await readJson(join(root, run.runDir, 'changes.json'));
      assert.deepEqual(changes.files.map(f => f.path).sort(), [home, '.harness/state/sbi-7.json'].sort());
      assert.equal(run.risk.level, b.risk.level);
      assert.equal(run.lane.name, 'production');
    })));
    it('when the head is re-verified then the new run is named in the PR head commit so a check reading only Git can link them', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      const mainAfterA = await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const link = await verifyReverifyLink({ root, base: mainAfterA, head: run.headSha });
      assert.deepEqual(link, { status: 'PASS', runId: run.id, parentRunId: b.id, baselineSha: mainAfterA, previousTestedSha: b.headSha, reasons: [] });
    })));
  });

  describe('given the re-verified PR on GitHub', () => {
    it('when CI passes and a human approves the new head then MERGE_ALLOWED, while approvals of the old head never count', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await succeed(github, b.headSha);
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', b.headSha);
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.status, 'BLOCKED');
      assert.deepEqual(run.merge.reasons, ['required_ci_not_passed']);
      await succeed(github, run.headSha);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', run.headSha);
      const allowed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(allowed.status, 'MERGE_ALLOWED');
      assert.deepEqual(allowed.merge.validReviewers, ['github:alice']);
    })));
    it('when a request for changes was left on the old head then the new head is still rejected', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await reviewBy(github, b.pullRequest.number, 'bob', 'CHANGES_REQUESTED', b.headSha);
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      await succeed(github, run.headSha);
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', run.headSha);
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'REJECTED');
    })));
    it('when someone pushes onto the PR after the update then the run blocks on the SHA mismatch', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const pushed = await pushOnto(root, `harness/${b.id}`, run.headSha, 'someone else pushed');
      await succeed(github, pushed);
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', pushed);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'BLOCKED');
      assert.ok(resumed.merge.reasons.includes('tested_sha_mismatch'));
    })));
    it('when main moves again after the update then the run blocks until it is re-verified once more', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await mergeA(root);
      const first = await reverifyPullRequest({ root, pullUrl, quiet: true });
      await succeed(github, first.headSha);
      await reviewBy(github, b.pullRequest.number, 'alice', 'APPROVED', first.headSha);
      const mainAfterC = await mergeA(root, { 'docs/feature-c.md': '# Cの機能\n' });
      const second = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(second.id, first.id);
      assert.equal(second.reverify.parentRunId, b.id, 'the parent stays the run that implemented the SBI');
      assert.equal(second.reverify.previousTestedSha, first.headSha);
      assert.deepEqual(await parents(root, second.headSha), [mainAfterC, first.headSha]);
      assert.equal(second.status, 'BLOCKED');
    })));
  });

  describe('given B conflicts with the new main', () => {
    const conflicting = { [home]: 'Aのホーム' };
    it('when B is re-verified then it stops with the conflicting paths, keeps the PR branch and verifies nothing', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      await mergeA(root, conflicting);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.escalation.code, 'REVERIFY_CONFLICT');
      assert.deepEqual(run.reverify.conflicts, [home]);
      assert.ok(run.reason.includes(home));
      assert.equal(run.iterations.length, 0);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      assert.equal((await github.state()).pulls[0].body.includes(run.id), false);
    })));
    it('when a person resolves the conflict on the PR branch then the resolved head is verified again in a new run and pushed', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      const mainAfterA = await mergeA(root, conflicting);
      const stopped = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const resolved = await resolveOnBranch(bare, `harness/${b.id}`, { [home]: 'ホーム' });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.id, stopped.id);
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.iterations.length, 1);
      assert.equal(run.iterations[0].verification.status, 'PASS');
      assert.equal(run.reverify.previousTestedSha, resolved);
      assert.deepEqual(await parents(root, run.headSha), [resolved], 'the resolved head is kept and only the link commit is added on top');
      assert.equal((await git(root, ['rev-parse', `${run.headSha}^{tree}`])).stdout.trim(), (await git(root, ['rev-parse', `${resolved}^{tree}`])).stdout.trim());
      assert.equal(await remoteSha(bare, `harness/${b.id}`), run.headSha);
      assert.equal((await verifyReverifyLink({ root, base: mainAfterA, head: run.headSha })).status, 'PASS');
    })));
    it('when the resolution also changes a file outside the SBI scope then it stops before verification and pushes nothing', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root, conflicting);
      await reverifyPullRequest({ root, pullUrl, quiet: true });
      const resolved = await resolveOnBranch(bare, `harness/${b.id}`, { [home]: 'ホーム', 'docs/outside-scope.md': 'scope外' });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.escalation.code, 'SCOPE_VIOLATION');
      assert.ok(run.reason.includes('docs/outside-scope.md'));
      assert.equal(run.iterations.length, 0);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), resolved);
    })));
  });

  describe('given the latest trusted rules and verification code on main', () => {
    it('when the Trusted Acceptance on the new main fails for B then the run fails, nothing is pushed and the agent is not called', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      await mergeA(root, { '.harness/verification/issue-7.mjs': acceptance('ホーム（新しい見出し）') });
      const reverification = spy();
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true, agent: reverification.agent });
      assert.equal(run.executionStatus, 'FAILED');
      assert.equal(run.iterations.length, 1);
      assert.equal(reverification.calls.length, 0);
      assert.notEqual(run.reverify.publish, 'PR_UPDATED');
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      assert.equal((await github.state()).pulls[0].body.includes(run.id), false);
      assert.notEqual(run.status, 'MERGE_ALLOWED');
    })));
    it('when the SBI requires an implementation gate then the new baseline needs a new approval before anything is verified or pushed', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl, implementation }) => {
      assert.equal(b.gate.state, 'APPROVED');
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.status, 'WAITING_FOR_HUMAN_GATE');
      assert.equal(run.gate.headSha, run.baselineSha);
      assert.equal(run.iterations.length, 0);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      const before = implementation.calls.length;
      const approved = await approveRun({ root, issueUrl, purpose: 'implementation-gate', identityProvider: human('Designer'), agent: implementation.agent, quiet: true });
      assert.equal(approved.id, run.id);
      assert.equal(implementation.calls.length, before, 'approving the gate of a re-verification does not start the implementation agent');
      assert.equal(approved.executionStatus, 'DONE');
      assert.equal(await remoteSha(bare, `harness/${b.id}`), approved.headSha);
    }, { issue: sbiIssue(planned({ riskCandidate: 'L3' })) })));
  });

  describe('given the main or the PR moves while the re-verification runs', () => {
    // The Policy Reviewer runs after the candidate exists and before it is pushed.
    const during = action => ({ reviewer: async args => { await action(); return review(args); } });
    it('when main moves during verification then nothing is pushed and the PR is not updated', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      const mainAfterA = await mergeA(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, ...during(() => pushOnto(root, 'main', mainAfterA, 'another PR merged')) }), /origin\/main/);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      assert.equal((await github.state()).pulls[0].body.includes(`親run: ${b.id}`), false);
    })));
    it('when someone pushes to the PR during verification then the unverified head is not overwritten and nothing is pushed', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      let theirs;
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, ...during(async () => { theirs = await pushOnto(root, `harness/${b.id}`, b.headSha, 'review fix'); }) }), /harness\//);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), theirs);
    })));
    it('when the source checkout is not the latest main then refuses before creating a run', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await mergeA(root);
      await pushOnto(root, 'main', (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(), 'not pulled yet');
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /origin\/main/);
      assert.deepEqual(await runs(root), before);
      assert.ok(before.includes(b.id));
    })));
    it('when the SBI Issue was edited after B was implemented then refuses to re-verify and asks for a new implementation run', () => fixture(root => withPullRequestB(root, async ({ github, pullUrl }) => {
      await mergeA(root);
      await github.update(s => { s.issue.body += '\n追記'; });
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /SBI/);
      assert.deepEqual(await runs(root), before);
    })));
  });

  describe('given the same re-verification is repeated', () => {
    it('when it is run again after the PR was updated then the same run is reused and no second PR or push happens', () => fixture(root => withPullRequestB(root, async ({ github, pullUrl }) => {
      await mergeA(root);
      const first = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const before = await runs(root);
      const again = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(again.id, first.id);
      assert.equal(again.headSha, first.headSha);
      assert.deepEqual(await runs(root), before);
      assert.equal((await github.state()).pulls.length, 1);
    })));
    it('when the push succeeded but updating the PR failed then the retry skips the push and finishes the PR update', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      await mergeA(root);
      const failing = { ...githubPrCli, updatePull: async () => { throw new Error('gh api PATCH repos/acme/app/pulls: HTTP 502'); } };
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, github: failing }), /502/);
      const pushed = await remoteSha(bare, `harness/${b.id}`);
      assert.notEqual(pushed, b.headSha);
      const [stopped] = (await runs(root)).filter(id => id !== b.id);
      assert.equal((await readRunState(root, stopped)).reverify.publish, 'PUSHED');
      const retried = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(retried.id, stopped);
      assert.equal(retried.headSha, pushed);
      assert.equal(retried.reverify.publish, 'PR_UPDATED');
      assert.ok((await github.state()).pulls[0].body.includes(`run=${retried.id} sha=${pushed}`));
      assert.equal(await exists(join(root, '.harness/runs', stopped, 'workspace')), true);
    })));
  });
});

describe('Link between a PR head and its re-verification run', () => {
  it('when the PR head is an ordinary Harness commit then it is reported as no re-verification, not as a failure', () => fixture(root => withPullRequestB(root, async ({ b }) => {
    const link = await verifyReverifyLink({ root, base: b.baselineSha, head: b.headSha });
    assert.equal(link.status, 'NONE');
  })));
  it('when a commit claims a parent run other than the one in the committed SBI snapshot then the link fails', () => fixture(root => withPullRequestB(root, async ({ b }) => {
    const forged = (await git(root, ['commit-tree', `${b.headSha}^{tree}`, '-p', b.headSha, '-m', 'Reverify\n\nHarness-Reverify-Run: 2026-10-29T00-00-00-000Z-aaaaaaaa\nHarness-Parent-Run: 2026-10-29T00-00-00-000Z-bbbbbbbb'])).stdout.trim();
    const link = await verifyReverifyLink({ root, base: b.baselineSha, head: forged });
    assert.equal(link.status, 'FAIL');
    assert.match(link.reasons.join('; '), /Harness-Parent-Run/);
  })));
  it('when a commit names a re-verification run but not its parent then the link fails', () => fixture(root => withPullRequestB(root, async ({ b }) => {
    const forged = (await git(root, ['commit-tree', `${b.headSha}^{tree}`, '-p', b.headSha, '-m', 'Reverify\n\nHarness-Reverify-Run: 2026-10-29T00-00-00-000Z-aaaaaaaa'])).stdout.trim();
    assert.equal((await verifyReverifyLink({ root, base: b.baselineSha, head: forged })).status, 'FAIL');
  })));
});
