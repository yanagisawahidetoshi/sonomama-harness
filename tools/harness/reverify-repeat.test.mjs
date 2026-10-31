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
  describe('given main has not moved since the PR head was verified', () => {
    it('when B is re-verified then it reports the run the head is bound to and creates no run, commit, push or PR update', () => fixture(root => withPullRequestB(root, async ({ bare, github, b, pullUrl }) => {
      const before = { runs: await runs(root), body: (await github.state()).pulls[0].body };
      const result = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(result.alreadyVerified, true);
      assert.equal(result.id, b.id);
      assert.equal(result.headSha, b.headSha);
      assert.deepEqual(await runs(root), before.runs);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      assert.equal((await github.state()).pulls[0].body, before.body);
      assert.equal((await github.calls()).some(c => c.args.includes('PATCH')), false);
    })));
    it('when someone pushed onto the PR head then the new head is verified in a new run', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      const head = await commitOnBranch(bare, `harness/${b.id}`, { 'apps/admin/src/extra.txt': '追加' });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.alreadyVerified, true);
      assert.notEqual(run.id, b.id);
      assert.equal(run.reverify.previousTestedSha, head);
    })));
    it('when the run of the head stopped as ESCALATED then the head is verified in a new run', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await git(root, ['commit', '--allow-empty', '-m', 'local only']);
      assert.equal((await resumeRun({ root, runId: b.id, quiet: true })).status, 'ESCALATED');
      await git(root, ['checkout', '--quiet', '--detach', b.baselineSha]);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.alreadyVerified, true);
      assert.notEqual(run.id, b.id);
    })));
    it('when the signed state of the run cannot be verified then the head is verified in a new run', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await update(root, `${b.runDir}/summary.json`, s => { s.reason = '手で書き換えた'; });
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.alreadyVerified, true);
      assert.notEqual(run.id, b.id);
    })));
    it('when the run ref no longer points at the PR head then the binding is not trusted and the head is verified in a new run', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await git(root, ['update-ref', `refs/harness/runs/${b.id}`, b.baselineSha]);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.alreadyVerified, true);
      assert.notEqual(run.id, b.id);
    })));
  });

  describe('given the PR is not the one the run belongs to', () => {
    it('when the PR head comes from a fork then refuses before any run is created', () => fixture(root => withPullRequestB(root, async ({ github, pullUrl }) => {
      await mergeA(root);
      await github.update(s => { s.pulls[0].head.repo = { full_name: 'someone/app' }; });
      const before = await runs(root);
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /someone\/app/);
      assert.deepEqual(await runs(root), before);
    })));
    it('when the PR head repository was deleted then refuses before any run is created', () => fixture(root => withPullRequestB(root, async ({ github, pullUrl }) => {
      await mergeA(root);
      await github.update(s => { s.pulls[0].head.repo = null; });
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true }), /fork/);
    })));
    it('when the PR was closed and the branch reopened as another PR then the run of the closed PR is not reused and its body is left alone', () => fixture(root => withPullRequestB(root, async ({ github, b, pullUrl }) => {
      await mergeA(root);
      const failing = { ...githubPrCli, updatePull: async () => { throw new Error('gh api PATCH repos/acme/app/pulls: HTTP 502'); } };
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, github: failing }), /502/);
      const [stopped] = (await runs(root)).filter(id => id !== b.id);
      const closedBody = (await github.state()).pulls[0].body;
      await github.update(s => { s.pulls[0].state = 'closed'; s.pulls.push({ ...s.pulls[0], number: 202, state: 'open', html_url: 'https://github.com/acme/app/pull/202', body: '' }); });
      const run = await reverifyPullRequest({ root, pullUrl: 'https://github.com/acme/app/pull/202', quiet: true });
      assert.notEqual(run.id, stopped);
      assert.equal(run.pullRequest.number, 202);
      const pulls = (await github.state()).pulls;
      assert.equal(pulls[0].body, closedBody);
      assert.ok(pulls[1].body.includes(`run=${run.id}`));
    })));
  });

  describe('given the same re-verification is repeated', () => {
    it('when an earlier run stopped while preparing its candidate then it is not reused and a new run starts', () => fixture(root => withPullRequestB(root, async ({ b, pullUrl }) => {
      await mergeA(root);
      const waiting = await reverifyPullRequest({ root, pullUrl, quiet: true });
      // The state a run is left in when it stops between creating its candidate and the preflight: no lane yet.
      const state = await readRunState(root, waiting.id);
      delete state.lane;
      state.status = 'PENDING'; state.executionStatus = 'PENDING'; state.iterations = []; state.reverify.publish = 'PREPARED';
      state.headSha = state.baselineSha;
      await saveRun(root, state);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(run.id, waiting.id);
      assert.equal(run.gate.required, false);
    }, { issue: sbiIssue(planned({ riskCandidate: 'L3' })) })));
    it('when the earlier run failed then running it again starts a new run instead of returning the stopped one', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root, { '.harness/verification/issue-7.mjs': acceptance('ホーム（新しい見出し）') });
      const failed = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(failed.executionStatus, 'FAILED');
      const again = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.notEqual(again.id, failed.id);
      assert.equal(again.iterations.length, 1);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
    })));
    it('when it is run again after the PR was updated then the same run is reused and no second PR or push happens', () => fixture(root => withPullRequestB(root, async ({ github, pullUrl }) => {
      await mergeA(root);
      const first = await reverifyPullRequest({ root, pullUrl, quiet: true });
      const before = await runs(root);
      const again = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(again.id, first.id);
      assert.equal(again.headSha, first.headSha);
      assert.equal(again.alreadyVerified, true);
      assert.deepEqual(await runs(root), before);
      assert.equal((await github.state()).pulls.length, 1);
    })));
    it('when harness:pr is run for the re-verification run then it refuses, so no second branch or PR is created', () => fixture(root => withPullRequestB(root, async ({ bare, github, pullUrl }) => {
      await mergeA(root);
      const run = await reverifyPullRequest({ root, pullUrl, quiet: true });
      await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /harness:reverify/);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.equal((await github.state()).pulls.length, 1);
    })));
    it('when the push itself failed then the retry pushes the same verified candidate without verifying again', () => fixture(root => withPullRequestB(root, async ({ bare, b, pullUrl }) => {
      await mergeA(root);
      const offline = { ...githubPrCli, push: async () => { throw new Error('git push: Could not resolve host: github.com'); } };
      await assert.rejects(reverifyPullRequest({ root, pullUrl, quiet: true, github: offline }), /Could not resolve host/);
      assert.equal(await remoteSha(bare, `harness/${b.id}`), b.headSha);
      const [stopped] = (await runs(root)).filter(id => id !== b.id);
      const before = await readRunState(root, stopped);
      assert.equal(before.reverify.publish, 'PUSHING');
      const retried = await reverifyPullRequest({ root, pullUrl, quiet: true });
      assert.equal(retried.id, stopped);
      assert.equal(retried.iterations.length, 1, 'the candidate is not verified a second time');
      assert.equal(await remoteSha(bare, `harness/${b.id}`), before.headSha);
      assert.equal(retried.reverify.publish, 'PR_UPDATED');
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
