import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readdir, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, update, human, commitFixture } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import * as harness from './index.mjs';
import { openPullRequest } from './index.mjs';
// These runs stand for the production path, so they connect a trusted AI Review adapter as #187 will (#175).
const aiReview = async () => ({ adapter: 'test-adapter', status: 'PASS', reasons: [] });
const withAiReview = fn => options => fn({ semanticReviewer: aiReview, ...options });
const runHarness = withAiReview(harness.runHarness), resumeRun = withAiReview(harness.resumeRun), approveRun = withAiReview(harness.approveRun), reverifyPullRequest = withAiReview(harness.reverifyPullRequest);
import { githubPrCli } from './github-pr.mjs';
import { readRunState, saveRun } from './run-store.mjs';
import { review } from './reviewer.mjs';
import { verifyReverifyLink } from './reverify.mjs';
import { git } from './workspace.mjs';
import { exists, readJson } from './io.mjs';
import { renderSbiBody } from './planner.mjs';
import { issueUrl, pbi, planned, sbiIssue, home, acceptance, spy, mockGitHub, registered, withPullRequestB, remoteSha, parents, isAncestor, mergeA, pushOnto, resolveOnBranch, commitOnBranch, withGlobalGitConfig, succeed, reviewBy, runs } from './test-reverify.mjs';


// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
describe('Re-verification of an existing PR after main moved', () => {
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
    // #175: the approved SBI decided its level 3 Risk, so neither the run nor its re-verification stops at an implementation gate.
    it('when the SBI is level 3 then the new baseline is verified and pushed without an implementation gate or the implementation agent', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl, implementation }) => {
      assert.equal(b.gate.required, false);
      await mergeA(root);
      const before = implementation.calls.length;
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.gate.required, false);
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.risk.level, 3);
      assert.equal(implementation.calls.length, before);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), run.headSha);
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

  describe('given the Git configuration and the content of the operator and the PR', () => {
    it('when the operator lets Git follow directory renames then the merge is still judged with fixed settings and stops on the conflict a default Git reports', () => withGlobalGitConfig('[merge]\n\tdirectoryRenames = true\n', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      // main adds a directory, B takes it in and adds a file there, then main renames the directory.
      await mergeA(root, { 'apps/admin/src/old/a.txt': 'a' });
      const head = await resolveOnBranch(bare, `harness/${b.id}`, { 'apps/admin/src/old/b.txt': 'b' });
      await git(root, ['mv', 'apps/admin/src/old', 'apps/admin/src/new']);
      await git(root, ['commit', '-m', 'rename the directory']);
      await git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.escalation?.code, 'REVERIFY_CONFLICT', run.reason ?? '');
      assert.match(run.reverify.gitVersion, /^git version /);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), head);
    }))));
    it('when the operator has merge.log enabled then the candidate still ends with the link trailers and is pushed', () => withGlobalGitConfig('[merge]\n\tlog = true\n', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      const mainAfterA = await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(run.reverify.publish, 'PR_UPDATED', run.reason ?? '');
      assert.equal(await remoteSha(bare, `harness/${b.id}`), run.headSha);
      assert.equal((await verifyReverifyLink({ root, base: mainAfterA, head: run.headSha })).status, 'PASS');
    }))));
    it('when the PR head adds a symlink then refuses before any run or worktree is created', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      const head = await commitOnBranch(bare, `harness/${b.id}`, {}, { 'apps/admin/src/link.txt': '../../../package.json' });
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /symlink/);
      assert.deepEqual(await runs(root), before);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), head);
    })));
    it('when the PR head adds operational evidence then refuses before any run or worktree is created', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      await commitOnBranch(bare, `harness/${b.id}`, { '.harness/state/human/forged.json': '{}' });
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /operational evidence/);
      assert.deepEqual(await runs(root), before);
    })));
    it('when a changed file of the PR head holds a credential outside its changed lines then refuses before any run is created', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      const before = await runs(root);
      // A binary file has no added lines in the diff; the whole file is inspected.
      await commitOnBranch(bare, `harness/${b.id}`, { 'apps/admin/src/blob.bin': `\u0000AKIA${'A'.repeat(16)}\u0000` });
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /credential|秘密値/);
      assert.deepEqual(await runs(root), before);
    })));
  });

  // The PASS run bound to this PR, this PR head and this base SHA is the only source; GitHub Reviews are not read for it.
});
