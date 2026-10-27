import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewApprovals, ciStatus } from './github-pr.mjs';
import { mergeDecision } from './merge-policy.mjs';
import { fixture, update, human, runFixture as runHarness } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { openPullRequest, resumeRun } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { git } from './workspace.mjs';
import { readJson } from './io.mjs';

const head = 'a'.repeat(40), old = 'b'.repeat(40);
let nextId = 1;
const review = (login, state, commit = head, type = 'User') => ({ id: nextId++, user: { login, type }, state, commit_id: commit });
const run = (name, status, conclusion = null, id = nextId++) => ({ id, name, status, conclusion, head_sha: head });

describe('GitHub Review approvals', () => {
  describe('given reviews on the pull request', () => {
    it('when distinct humans approve the head SHA then each counts once', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'APPROVED'), review('bob', 'APPROVED'), review('alice', 'APPROVED')], headSha: head, author: 'author' });
      assert.deepEqual(result.approvedHumans, ['alice', 'bob']);
      assert.equal(result.changesRequested, false);
    });
    it('when an approval was given to an older commit then it is not counted', () => {
      assert.deepEqual(reviewApprovals({ reviews: [review('alice', 'APPROVED', old)], headSha: head, author: 'author' }).approvedHumans, []);
    });
    it('when a bot or a GitHub App approves then it is not a human approval', () => {
      const reviews = [review('ci-helper', 'APPROVED', head, 'Bot'), review('copilot[bot]', 'APPROVED')];
      assert.deepEqual(reviewApprovals({ reviews, headSha: head, author: 'author' }).approvedHumans, []);
    });
    it('when the pull request author approves then it is not counted', () => {
      assert.deepEqual(reviewApprovals({ reviews: [review('author', 'APPROVED')], headSha: head, author: 'author' }).approvedHumans, []);
    });
    it('when a reviewer comments after approving then the approval still stands', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'APPROVED'), review('alice', 'COMMENTED')], headSha: head, author: 'author' });
      assert.deepEqual(result.approvedHumans, ['alice']);
    });
    it('when a reviewer requests changes on an older commit and never re-reviews then changes are still requested', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'CHANGES_REQUESTED', old), review('bob', 'APPROVED')], headSha: head, author: 'author' });
      assert.equal(result.changesRequested, true);
      assert.deepEqual(result.changesRequestedBy, ['alice']);
    });
    it('when a reviewer approves after requesting changes then only the latest review counts', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'CHANGES_REQUESTED'), review('alice', 'APPROVED')], headSha: head, author: 'author' });
      assert.deepEqual([result.approvedHumans, result.changesRequested], [['alice'], false]);
    });
    it('when a request for changes is dismissed then it no longer blocks and grants nothing', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'CHANGES_REQUESTED'), review('alice', 'DISMISSED')], headSha: head, author: 'author' });
      assert.deepEqual([result.approvedHumans, result.changesRequested], [[], false]);
    });
    it('when a pending review exists then it is ignored', () => {
      assert.deepEqual(reviewApprovals({ reviews: [review('alice', 'PENDING')], headSha: head, author: 'author' }).approvedHumans, []);
    });
  });
});

describe('GitHub CI status', () => {
  describe('given the required checks for the head SHA', () => {
    it('when every required check succeeded then passes', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success')], required: ['harness'] }).status, 'PASS');
    });
    it('when a required check is still running then is pending', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'in_progress')], required: ['harness'] }).status, 'PENDING');
    });
    for (const conclusion of ['failure', 'timed_out', 'action_required', 'cancelled', 'skipped', 'neutral', 'stale']) {
      it(`when a required check concluded ${conclusion} then fails`, () => {
        assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', conclusion)], required: ['harness'] }).status, 'FAIL');
      });
    }
    it('when a required check never ran then reports it missing and fails', () => {
      const result = ciStatus({ checkRuns: [run('lint', 'completed', 'success')], required: ['harness'] });
      assert.equal(result.status, 'FAIL');
      assert.deepEqual(result.checks, [{ name: 'harness', status: 'MISSING' }]);
    });
    it('when no check is required then reports NOT_CONFIGURED instead of passing', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success')], required: [] }).status, 'NOT_CONFIGURED');
    });
    it('when a check was re-run then only the latest run counts', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success', 11), run('harness', 'completed', 'failure', 10)], required: ['harness'] }).status, 'PASS');
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success', 10), run('harness', 'completed', 'failure', 11)], required: ['harness'] }).status, 'FAIL');
    });
  });
});

describe('Merge Policy Judge with GitHub PR state', () => {
  const checks = ['verification', 'policy-review', 'security', 'completion'].map(id => ({ id, required: true, status: 'PASS' }));
  const securityVerification = { status: 'PASS', violations: [], requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }] };
  const github = (overrides = {}) => ({
    pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: head, state: 'open', merged: false, testedShaMatches: true, ...overrides.pullRequest },
    ci: { status: 'PASS', checks: [], ...overrides.ci },
    reviews: { approvedHumans: [], changesRequested: false, changesRequestedBy: [], ...overrides.reviews },
  });
  const decide = (level, state, extra = {}) => mergeDecision({ risk: { level, requiredHumanApprovals: level === 3 ? 2 : level === 2 ? 1 : 0 }, checks, approvals: [], securityVerification,
    headSha: head, contextDigest: 'context', gateApproved: true, humanGate: false, github: state, ...extra });

  describe('given the tested SHA is the pull request head and CI passes', () => {
    it('when the risk is level 3 and two different humans approved then allows merge', () => {
      const result = decide(3, github({ reviews: { approvedHumans: ['alice', 'bob'] } }));
      assert.equal(result.decision, 'MERGE_ALLOWED');
      assert.deepEqual([result.validApprovals, result.requiredApprovals], [2, 2]);
    });
    it('when the risk is level 3 and only one human approved then waits for review', () => {
      assert.equal(decide(3, github({ reviews: { approvedHumans: ['alice'] } })).decision, 'WAITING_FOR_HUMAN_REVIEW');
    });
    it('when the risk is level 2 and one human approved then allows merge', () => {
      assert.equal(decide(2, github({ reviews: { approvedHumans: ['alice'] } })).decision, 'MERGE_ALLOWED');
    });
    it('when the risk is level 1 then needs no approval', () => {
      assert.equal(decide(1, github()).decision, 'MERGE_ALLOWED');
    });
    it('when a local merge approval exists but GitHub has none then the local record is not counted', () => {
      const local = [{ kind: 'human', purpose: 'merge', reviewer: 'os:1:me', commitSha: head, contextDigest: 'context', decision: 'APPROVE' }];
      const result = decide(2, github(), { approvals: local });
      assert.equal(result.decision, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(result.validApprovals, 0);
    });
    it('when someone requested changes then rejects even with enough approvals', () => {
      const result = decide(2, github({ reviews: { approvedHumans: ['alice'], changesRequested: true, changesRequestedBy: ['bob'] } }));
      assert.equal(result.decision, 'REJECTED');
      assert.ok(result.reasons.includes('github_changes_requested'));
    });
  });

  describe('given a pull request that does not match what Harness verified', () => {
    it('when a new commit was pushed after verification then blocks even with approvals', () => {
      const result = decide(2, github({ pullRequest: { headSha: old, testedShaMatches: false }, reviews: { approvedHumans: ['alice'] } }));
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(result.reasons.includes('tested_sha_mismatch'));
    });
    for (const status of ['PENDING', 'FAIL', 'NOT_CONFIGURED']) {
      it(`when CI is ${status} then blocks`, () => {
        const result = decide(1, github({ ci: { status } }));
        assert.equal(result.decision, 'BLOCKED');
        assert.ok(result.reasons.includes('required_ci_not_passed'));
      });
    }
    it('when the pull request was already merged on GitHub then blocks and never reports MERGED', () => {
      const result = decide(1, github({ pullRequest: { state: 'closed', merged: true } }));
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(result.reasons.includes('pull_request_not_open'));
    });
    it('when the GitHub state could not be read then blocks instead of trusting an earlier state', () => {
      const result = decide(1, { unavailable: 'gh api GET repos/acme/app/pulls/7: timeout' });
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(result.reasons.includes('github_state_unavailable'));
    });
    it('when the head SHA differs but the state claims it matches then still blocks', () => {
      assert.equal(decide(1, github({ pullRequest: { headSha: old, testedShaMatches: true } })).decision, 'BLOCKED');
    });
    it('when Harness checks failed then GitHub approvals cannot allow merge', () => {
      const failed = checks.map(c => c.id === 'verification' ? { ...c, status: 'FAIL' } : c);
      assert.equal(decide(2, github({ reviews: { approvedHumans: ['alice'] } }), { checks: failed }).decision, 'BLOCKED');
    });
  });
});

describe('GitHub PR Adapter', () => {
  const sbiPath = '.harness/state/sample-sbi.json';
  const mockGitHub = githubMock({ issue: { number: 1, title: 'unused', body: '', html_url: 'https://github.com/acme/app/issues/1', state: 'open', labels: [] } });
  // origin points at github.com/acme/app as configured, while git itself pushes to a local bare repository.
  async function withRemote(root, test, { publishBaseline = true } = {}) {
    const bare = await realpath(await mkdtemp(join(tmpdir(), 'harness-remote-')));
    try {
      await git(bare, ['init', '--bare', '--initial-branch=main']);
      await git(root, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
      await git(root, ['config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git']);
      if (publishBaseline) await git(root, ['push', 'origin', 'HEAD:refs/heads/main']);
      await mockGitHub({ bare }, github => test({ bare, github }));
    } finally { await rm(bare, { recursive: true, force: true }); }
  }
  const remoteSha = async (bare, branch) => (await git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true)).stdout.trim();
  const succeed = (github, sha, name = 'harness') => github.update(s => { s.checkRuns[sha] = [...(s.checkRuns[sha] || []), { id: Object.keys(s.checkRuns).length + 1, name, status: 'completed', conclusion: 'success', head_sha: sha }]; });
  const reviewBy = (github, number, login, state, commit) => github.update(s => { s.reviews[number] = [...(s.reviews[number] || []), { id: (s.reviews[number] || []).length + 1, user: { login, type: 'User' }, state, commit_id: commit }]; });

  describe('given a completed level 2 run whose baseline is on origin/main', () => {
    it('when harness:pr runs then pushes exactly the tested SHA and opens a PR whose head is that SHA', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.status, 'WAITING_FOR_HUMAN_REVIEW');
      await withRemote(root, async ({ bare, github }) => {
        const result = await openPullRequest({ root, runId: run.id, quiet: true });
        assert.equal(await remoteSha(bare, `harness/${run.id}`), run.headSha);
        const [pull] = (await github.state()).pulls;
        assert.equal(pull.head.sha, run.headSha);
        assert.equal(pull.base.ref, 'main');
        assert.deepEqual(result.pullRequest, { number: pull.number, url: pull.html_url, branch: `harness/${run.id}`, base: 'main', repository: 'acme/app' });
        for (const text of [run.id, run.headSha, run.sbi, 'LEVEL 2', '1人']) assert.ok(pull.body.includes(text), `PR body includes ${text}`);
        const sbi = await readJson(join(root, sbiPath));
        for (const criterion of sbi.acceptanceCriteria) assert.ok(pull.body.includes(criterion.id));
      });
    }));
    it('when CI has not reported yet then the merge decision is blocked on CI, not allowed', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async () => {
        const result = await openPullRequest({ root, runId: run.id, quiet: true });
        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.merge.reasons.includes('required_ci_not_passed'));
      });
    }));
    it('when CI passes and a human approves the head SHA then resume reaches MERGE_ALLOWED and records the GitHub state', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
        await succeed(github, run.headSha);
        await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
        const resumed = await resumeRun({ root, runId: run.id, quiet: true });
        assert.equal(resumed.status, 'MERGE_ALLOWED');
        assert.deepEqual(resumed.merge.validReviewers, ['github:alice']);
        const evidence = await readJson(join(root, run.runDir, 'github-state.json'));
        assert.deepEqual(evidence.pullRequest.testedShaMatches, true);
        assert.deepEqual(evidence.reviews.approvedHumans, ['alice']);
        assert.equal(evidence.ci.status, 'PASS');
        assert.equal(resumed.events.some(e => e.status === 'MERGED'), false);
      });
    }));
    it('when a commit is pushed to the PR after verification then resume blocks even though it was approved', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
        const pushed = 'c'.repeat(40);
        await github.update(s => { s.pulls[0].head.sha = pushed; });
        await succeed(github, pushed);
        await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', pushed);
        const resumed = await resumeRun({ root, runId: run.id, quiet: true });
        assert.equal(resumed.status, 'BLOCKED');
        assert.ok(resumed.merge.reasons.includes('tested_sha_mismatch'));
      });
    }));
    it('when a reviewer requests changes then resume rejects the merge', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
        await succeed(github, run.headSha);
        await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
        await reviewBy(github, pullRequest.number, 'bob', 'CHANGES_REQUESTED', run.headSha);
        assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'REJECTED');
      });
    }));
    it('when only the PR author approves then it is not a human approval', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
        await succeed(github, run.headSha);
        await reviewBy(github, pullRequest.number, 'harness-operator', 'APPROVED', run.headSha);
        assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
      });
    }));
    it('when a GitHub ruleset requires another check then that check must pass too', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        await github.update(s => { s.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint' }] } }]; });
        const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
        await succeed(github, run.headSha);
        await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
        const blocked = await resumeRun({ root, runId: run.id, quiet: true });
        assert.equal(blocked.status, 'BLOCKED');
        await succeed(github, run.headSha, 'lint');
        assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'MERGE_ALLOWED');
      });
    }));
    it('when a local merge approval is attempted in PR mode then refuses it in favour of GitHub Review', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async () => {
        await openPullRequest({ root, runId: run.id, quiet: true });
        await assert.rejects(recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') }), /GitHub Review/);
      });
    }));
    it('when harness:pr runs again then reuses the open PR instead of creating another', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        const first = await openPullRequest({ root, runId: run.id, quiet: true });
        const second = await openPullRequest({ root, runId: run.id, quiet: true });
        assert.equal(second.pullRequest.number, first.pullRequest.number);
        assert.equal((await github.state()).pulls.length, 1);
      });
    }));
  });

  describe('given a run that cannot be published as is', () => {
    it('when the baseline is not on origin/main then refuses before pushing so the PR never carries untested commits', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ bare, github }) => {
        await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /origin\/main/);
        assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
        assert.deepEqual((await github.state()).pulls, []);
      }, { publishBaseline: false });
    }));
    it('when the PR branch already exists at another SHA then refuses instead of force pushing', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ bare, github }) => {
        await git(root, ['push', 'origin', `${run.baselineSha}:refs/heads/harness/${run.id}`]);
        await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /harness\/.*既に/);
        assert.equal(await remoteSha(bare, `harness/${run.id}`), run.baselineSha);
        assert.deepEqual((await github.state()).pulls, []);
      });
    }));
    it('when execution has not completed then refuses to open a PR', () => fixture(async root => {
      await update(root, sbiPath, s => s.risks = ['RLS']);
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.status, 'WAITING_FOR_HUMAN_GATE');
      await withRemote(root, async ({ github }) => {
        await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /DONE/);
        assert.deepEqual((await github.state()).pulls, []);
      });
    }));
  });
});
