import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readdir, chmod, symlink, appendFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewApprovals, ciStatus, pullRequestBody } from './github-pr.mjs';
import { mergeDecision } from './merge-policy.mjs';
import { fixture, update, human, commitFixture, runFixture as runHarness } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { openPullRequest, resumeRun, runHarness as startRun, approveRun } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { git } from './workspace.mjs';
import { exists, readJson } from './io.mjs';
import { renderSbiBody } from './planner.mjs';
import { runLinks, verifySbiSource } from './sbi-source.mjs';
import { loadImpact } from './impact.mjs';

const head = 'a'.repeat(40), old = 'b'.repeat(40), base = 'd'.repeat(40);
let nextId = 1;
const review = (login, state, commit = head, type = 'User') => ({ id: nextId++, user: { login, type }, state, commit_id: commit });
const run = (name, status, conclusion = null, id = nextId++, appId = 15368) => ({ id, name, status, conclusion, head_sha: head, app: { id: appId } });
// Repository permission per reviewer, as GitHub reports it (maintain is reported as write).
const permissions = { alice: 'write', bob: 'write', author: 'admin', 'ci-helper': 'write', 'copilot[bot]': 'write' };

describe('GitHub Review approvals', () => {
  describe('given reviews on the pull request', () => {
    it('when distinct humans approve the head SHA then each counts once', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'APPROVED'), review('bob', 'APPROVED'), review('alice', 'APPROVED')], headSha: head, author: 'author', permissions });
      assert.deepEqual(result.approvedHumans, ['alice', 'bob']);
      assert.equal(result.changesRequested, false);
    });
    it('when an approval was given to an older commit then it is not counted', () => {
      assert.deepEqual(reviewApprovals({ reviews: [review('alice', 'APPROVED', old)], headSha: head, author: 'author', permissions }).approvedHumans, []);
    });
    it('when a bot or a GitHub App approves then it is not a human approval', () => {
      const reviews = [review('ci-helper', 'APPROVED', head, 'Bot'), review('copilot[bot]', 'APPROVED')];
      assert.deepEqual(reviewApprovals({ reviews, headSha: head, author: 'author', permissions }).approvedHumans, []);
    });
    it('when the pull request author approves then it is not counted', () => {
      assert.deepEqual(reviewApprovals({ reviews: [review('author', 'APPROVED')], headSha: head, author: 'author', permissions }).approvedHumans, []);
    });
    it('when a reviewer comments after approving then the approval still stands', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'APPROVED'), review('alice', 'COMMENTED')], headSha: head, author: 'author', permissions });
      assert.deepEqual(result.approvedHumans, ['alice']);
    });
    it('when a reviewer requests changes on an older commit and never re-reviews then changes are still requested', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'CHANGES_REQUESTED', old), review('bob', 'APPROVED')], headSha: head, author: 'author', permissions });
      assert.equal(result.changesRequested, true);
      assert.deepEqual(result.changesRequestedBy, ['alice']);
    });
    it('when a reviewer approves after requesting changes then only the latest review counts', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'CHANGES_REQUESTED'), review('alice', 'APPROVED')], headSha: head, author: 'author', permissions });
      assert.deepEqual([result.approvedHumans, result.changesRequested], [['alice'], false]);
    });
    it('when a request for changes is dismissed then it no longer blocks and grants nothing', () => {
      const result = reviewApprovals({ reviews: [review('alice', 'CHANGES_REQUESTED'), review('alice', 'DISMISSED')], headSha: head, author: 'author', permissions });
      assert.deepEqual([result.approvedHumans, result.changesRequested], [[], false]);
    });
    it('when a pending review exists then it is ignored', () => {
      assert.deepEqual(reviewApprovals({ reviews: [review('alice', 'PENDING')], headSha: head, author: 'author', permissions }).approvedHumans, []);
    });
  });
  describe('given reviewers with different repository permissions', () => {
    for (const permission of ['write', 'admin']) {
      it(`when a reviewer with ${permission} permission approves then the approval counts`, () => {
        assert.deepEqual(reviewApprovals({ reviews: [review('carol', 'APPROVED')], headSha: head, author: 'author', permissions: { carol: permission } }).approvedHumans, ['carol']);
      });
    }
    for (const permission of ['read', 'none']) {
      it(`when a reviewer with ${permission} permission approves then GitHub would not count it so neither does Harness`, () => {
        assert.deepEqual(reviewApprovals({ reviews: [review('carol', 'APPROVED')], headSha: head, author: 'author', permissions: { carol: permission } }).approvedHumans, []);
      });
    }
    it('when a reviewer without write permission requests changes then it does not block, as on GitHub', () => {
      const result = reviewApprovals({ reviews: [review('carol', 'CHANGES_REQUESTED'), review('alice', 'APPROVED')], headSha: head, author: 'author', permissions: { carol: 'read', alice: 'write' } });
      assert.deepEqual([result.approvedHumans, result.changesRequested], [['alice'], false]);
    });
    it('when a reviewer permission could not be read then the approval is not counted but a request for changes still blocks', () => {
      const approved = reviewApprovals({ reviews: [review('carol', 'APPROVED')], headSha: head, author: 'author', permissions: {} });
      const requested = reviewApprovals({ reviews: [review('carol', 'CHANGES_REQUESTED')], headSha: head, author: 'author', permissions: { carol: 'unknown' } });
      assert.deepEqual([approved.approvedHumans, requested.changesRequested], [[], true]);
    });
  });
});

describe('GitHub CI status', () => {
  describe('given the required checks for the head SHA', () => {
    it('when every required check succeeded then passes', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success')], required: [{ context: 'harness' }] }).status, 'PASS');
    });
    it('when a required check is still running then is pending', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'in_progress')], required: [{ context: 'harness' }] }).status, 'PENDING');
    });
    for (const conclusion of ['failure', 'timed_out', 'action_required', 'cancelled', 'skipped', 'neutral', 'stale']) {
      it(`when a required check concluded ${conclusion} then fails`, () => {
        assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', conclusion)], required: [{ context: 'harness' }] }).status, 'FAIL');
      });
    }
    it('when a required check never ran then reports it missing and fails', () => {
      const result = ciStatus({ checkRuns: [run('lint', 'completed', 'success')], required: [{ context: 'harness' }] });
      assert.equal(result.status, 'FAIL');
      assert.deepEqual(result.checks, [{ name: 'harness', status: 'MISSING' }]);
    });
    it('when the ruleset expects the check from a specific app and only another app reported it then fails', () => {
      const result = ciStatus({ checkRuns: [run('harness', 'completed', 'success', nextId++, 999)], required: [{ context: 'harness', integrationId: 15368 }] });
      assert.equal(result.status, 'FAIL');
      assert.deepEqual(result.checks, [{ name: 'harness', integrationId: 15368, status: 'MISSING' }]);
    });
    it('when the ruleset expects the check from a specific app and that app reported success then passes', () => {
      const checkRuns = [run('harness', 'completed', 'failure', nextId++, 15368), run('harness', 'completed', 'success', nextId++, 999)];
      assert.equal(ciStatus({ checkRuns, required: [{ context: 'harness', integrationId: 15368 }] }).status, 'FAIL');
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success', nextId++, 15368)], required: [{ context: 'harness', integrationId: 15368 }] }).status, 'PASS');
    });
    it('when no check is required then reports NOT_CONFIGURED instead of passing', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success')], required: [] }).status, 'NOT_CONFIGURED');
    });
    it('when a check was re-run then only the latest run counts', () => {
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success', 11), run('harness', 'completed', 'failure', 10)], required: [{ context: 'harness' }] }).status, 'PASS');
      assert.equal(ciStatus({ checkRuns: [run('harness', 'completed', 'success', 10), run('harness', 'completed', 'failure', 11)], required: [{ context: 'harness' }] }).status, 'FAIL');
    });
  });
});

describe('Merge Policy Judge with GitHub PR state', () => {
  const checks = ['verification', 'policy-review', 'security', 'completion'].map(id => ({ id, required: true, status: 'PASS' }));
  const securityVerification = { status: 'PASS', violations: [], requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }] };
  const github = (overrides = {}) => ({
    pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: head, state: 'open', merged: false, testedShaMatches: true, baseRef: 'main', baseSha: base, remoteBaseSha: base, ...overrides.pullRequest },
    ci: { status: 'PASS', checks: [], ...overrides.ci },
    reviews: { approvedHumans: [], changesRequested: false, changesRequestedBy: [], ...overrides.reviews },
  });
  const decide = (level, state, extra = {}) => mergeDecision({ risk: { level, requiredHumanApprovals: level === 3 ? 2 : level === 2 ? 1 : 0 }, checks, approvals: [], securityVerification,
    headSha: head, contextDigest: 'context', gateApproved: true, humanGate: false, github: state, baseline: { ref: 'main', sha: base }, ...extra });

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
    it('when the base branch moved past the run baseline then blocks because the merge result was never verified', () => {
      const result = decide(2, github({ pullRequest: { remoteBaseSha: old }, reviews: { approvedHumans: ['alice'] } }));
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(result.reasons.includes('base_not_baseline'));
    });
    it('when the pull request base SHA is not the run baseline then blocks', () => {
      assert.ok(decide(1, github({ pullRequest: { baseSha: old } })).reasons.includes('base_not_baseline'));
    });
    it('when the pull request targets another base branch then blocks', () => {
      assert.ok(decide(1, github({ pullRequest: { baseRef: 'develop' } })).reasons.includes('base_not_baseline'));
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

// Issue #91: the PR of a Schema SBI is traceable from its body alone: PBI, SBI, contract diff and what Prism did and did not call.
describe('Pull request body of a Schema SBI', () => {
  const sbi = { id: 'ISSUE-6', title: 'SBI-001 OpenAPI Schemaを作る', description: 'コース一覧APIの契約を定義する。', acceptanceCriteria: [{ id: 'AC-1', description: 'コース一覧の契約がある' }],
    issueUrl: 'https://github.com/acme/app/issues/6', pbiUrl: 'https://github.com/acme/app/issues/3' };
  const contract = { id: 'api-contract', status: 'PASS', processes: [
    { ok: true, stdout: 'CHANGE 追加: paths./api/v1/courses\nCHANGE 説明を変更: info.description\nAPI contract (base HEAD): PASS\n', stderr: '' },
    { ok: true, stdout: 'Prism Mock: PASS GET /api/v1/courses 200\nPrism Mock: SKIP GET /api/v1/me（security要件があり、Verifierは認証headerを送らないため）\nPrism Mock: SKIP POST /api/v1/courses（GET以外はPrismへrequestしていません）\nPrism Mock check: PASS\n', stderr: '' }] };
  const summary = (checks = [contract]) => ({ id: 'run-1', headSha: 'a'.repeat(40), runDir: '.harness/runs/run-1', sbiIssue: { repo: 'acme/app', number: 6, url: sbi.issueUrl },
    iterations: [{ verification: { status: 'PASS', checks }, security: { status: 'PASS' }, securityVerification: { status: 'PASS' } }], risk: { level: 2, reasons: [] }, merge: { requiredApprovals: 1 } });
  const section = (body, heading) => body.split(/^## /m).find(part => part.startsWith(heading)) ?? '';
  it('when the body is written then it links the PBI and the Schema SBI Issue', () => {
    const body = pullRequestBody({ summary: summary(), sbi });
    assert.ok(body.includes('元PBI: https://github.com/acme/app/issues/3'));
    assert.ok(body.includes('Issue: https://github.com/acme/app/issues/6'));
  });
  it('when the api-contract Verifier ran then the body lists the breaking and non-breaking contract diff item by item', () => {
    const api = section(pullRequestBody({ summary: summary(), sbi }), 'API Schema');
    assert.match(api, /breaking: なし/);
    assert.ok(api.includes('追加: paths./api/v1/courses') && api.includes('説明を変更: info.description'));
  });
  it('when Prism was run then the body lists the endpoints it called and those it did not call with the reason', () => {
    const api = section(pullRequestBody({ summary: summary(), sbi }), 'API Schema');
    assert.ok(api.includes('GET /api/v1/courses 200'));
    assert.ok(api.includes('GET /api/v1/me（security要件があり、Verifierは認証headerを送らないため）'));
    assert.ok(api.includes('POST /api/v1/courses（GET以外はPrismへrequestしていません）'));
  });
  it('when the api-contract Verifier did not run for the SBI then the body has no API Schema section', () => {
    assert.equal(section(pullRequestBody({ summary: summary([{ id: 'admin', status: 'PASS', processes: [] }]), sbi }), 'API Schema'), '');
  });
});

describe('GitHub PR Adapter', () => {
  const sbiPath = '.harness/state/sample-sbi.json';
  const mockGitHub = githubMock({ issue: { number: 1, title: 'unused', body: '', html_url: 'https://github.com/acme/app/issues/1', state: 'open', labels: [] },
    permissions: { alice: 'write', bob: 'write', 'harness-operator': 'admin' } });
  // origin points at github.com/acme/app as configured, while git itself pushes to a local bare repository.
  async function withRemote(root, test, { publishBaseline = true, state = {} } = {}) {
    const bare = await realpath(await mkdtemp(join(tmpdir(), 'harness-remote-')));
    try {
      await git(bare, ['init', '--bare', '--initial-branch=main']);
      await git(root, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
      await git(root, ['config', `url.${bare}.insteadOf`, 'https://github.com/acme/app.git']);
      if (publishBaseline) await git(root, ['push', 'origin', 'HEAD:refs/heads/main']);
      await mockGitHub({ bare, ...state }, github => test({ bare, github }));
    } finally { await rm(bare, { recursive: true, force: true }); }
  }
  const remoteSha = async (bare, branch) => (await git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true)).stdout.trim();
  const succeed = (github, sha, name = 'harness', appId = 15368) => github.update(s => { s.checkRuns[sha] = [...(s.checkRuns[sha] || []), { id: (s.checkRuns[sha] || []).length + 1, name, status: 'completed', conclusion: 'success', head_sha: sha, app: { id: appId } }]; });
  // A new commit on origin/main that the run never saw; the source checkout HEAD stays at the baseline.
  const advanceMain = async (root, baselineSha) => {
    const next = (await git(root, ['commit-tree', `${baselineSha}^{tree}`, '-p', baselineSha, '-m', 'someone else merged'])).stdout.trim();
    await git(root, ['push', '--quiet', 'origin', `${next}:refs/heads/main`]);
    return next;
  };
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
    it('when the ruleset requires the check from a specific app then a same-named check from another app does not pass', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        await github.update(s => { s.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'harness', integration_id: 15368 }] } }]; });
        const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
        await succeed(github, run.headSha, 'harness', 999);
        await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
        const blocked = await resumeRun({ root, runId: run.id, quiet: true });
        assert.equal(blocked.status, 'BLOCKED');
        assert.ok(blocked.merge.reasons.includes('required_ci_not_passed'));
        await succeed(github, run.headSha, 'harness', 15368);
        assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'MERGE_ALLOWED');
      });
    }));
    it('when only a reviewer with read permission approves then it does not count toward merge', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
        await github.update(s => { s.permissions.carol = 'read'; });
        await succeed(github, run.headSha);
        await reviewBy(github, pullRequest.number, 'carol', 'APPROVED', run.headSha);
        const resumed = await resumeRun({ root, runId: run.id, quiet: true });
        assert.equal(resumed.status, 'WAITING_FOR_HUMAN_REVIEW');
        assert.deepEqual((await readJson(join(root, run.runDir, 'github-state.json'))).reviews.permissions, { carol: 'read' });
      });
    }));
    it('when the reviewer permission cannot be read then the approval is not counted', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
        await github.update(s => { s.permissions.alice = 'forbidden'; });
        await succeed(github, run.headSha);
        await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
        assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
      });
    }));
    it('when origin/main moves after the PR was opened then resume blocks even with CI and approval, until the run is recreated', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ github }) => {
        const { pullRequest } = await openPullRequest({ root, runId: run.id, quiet: true });
        await succeed(github, run.headSha);
        await reviewBy(github, pullRequest.number, 'alice', 'APPROVED', run.headSha);
        await advanceMain(root, run.baselineSha);
        const resumed = await resumeRun({ root, runId: run.id, quiet: true });
        assert.equal(resumed.status, 'BLOCKED');
        assert.ok(resumed.merge.reasons.includes('base_not_baseline'));
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

  // harness:run and harness:approve continue to the PR themselves; the human never runs harness:resume or harness:pr.
  describe('given harness:run with a real provider and a baseline on origin/main', () => {
    const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
    const agent = content => async () => ({ files: [{ path: 'greeting.mjs', content }] });
    // The remote must exist before the run, so the run starts from the published baseline.
    const start = (root, options = {}) => startRun({ root, quiet: true, provider: 'codex', agent: agent(good), publish: true, sbiPath, ...options });
    const remoteFirst = (root, test) => commitFixture(root).then(() => withRemote(root, test));
    it('when local verification passes then pushes the tested SHA and opens the PR without harness:pr', () => fixture(root => remoteFirst(root, async ({ bare, github }) => {
      const run = await start(root);
      assert.equal(run.executionStatus, 'DONE');
      const [pull] = (await github.state()).pulls;
      assert.equal(pull.head.sha, run.headSha);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), run.headSha);
      assert.deepEqual(run.pullRequest, { number: pull.number, url: pull.html_url, branch: `harness/${run.id}`, base: 'main', repository: 'acme/app' });
      assert.notEqual(run.status, 'MERGE_ALLOWED');
      assert.equal((await github.calls()).some(c => /merge/.test(c.args.join(' '))), false);
    })));
    it('when local verification keeps failing then pushes nothing and opens no PR', () => fixture(root => remoteFirst(root, async ({ bare, github }) => {
      const run = await start(root, { agent: agent('export const greet = () => "wrong";') });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.pullRequest, undefined);
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when no SBI is given and the configured sample SBI runs then opens no PR', () => fixture(root => remoteFirst(root, async ({ bare, github }) => {
      const run = await start(root, { sbiPath: undefined });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when the run uses the fake provider then opens no PR, so harness:demo never publishes', () => fixture(root => remoteFirst(root, async ({ github }) => {
      const run = await start(root, { provider: 'fake', agent: undefined });
      assert.equal(run.executionStatus, 'DONE');
      assert.deepEqual((await github.state()).pulls, []);
    })));
  });

  describe('given a harness:run stopped at the implementation gate', () => {
    const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
    // An unclassified risk stops the run at the implementation gate without bringing in a security rule.
    const gated = async root => {
      await update(root, sbiPath, s => s.risks = ['外部サービス連携']);
      await commitFixture(root);
    };
    const agent = async () => ({ files: [{ path: 'greeting.mjs', content: good }] });
    it('when a human approves the gate then the Harness resumes and opens the PR without harness:resume or harness:pr', () => fixture(async root => {
      await gated(root);
      await withRemote(root, async ({ github }) => {
        const run = await startRun({ root, quiet: true, provider: 'codex', agent, publish: true, sbiPath });
        assert.equal(run.status, 'WAITING_FOR_HUMAN_GATE');
        assert.deepEqual((await github.state()).pulls, []);
        const approved = await approveRun({ root, runId: run.id, purpose: 'implementation-gate', identityProvider: human('Designer'), agent, quiet: true });
        assert.equal(approved.gate.state, 'APPROVED');
        assert.equal(approved.executionStatus, 'DONE');
        const [pull] = (await github.state()).pulls;
        assert.equal(pull.head.sha, approved.headSha);
        assert.equal(approved.pullRequest.number, pull.number);
      });
    }));
    it('when the human requests changes instead then the run stays stopped, the agent never runs and no PR is opened', () => fixture(async root => {
      await gated(root);
      await withRemote(root, async ({ github }) => {
        const run = await startRun({ root, quiet: true, provider: 'codex', agent, publish: true, sbiPath });
        let called = false;
        const rejected = await approveRun({ root, runId: run.id, purpose: 'implementation-gate', decision: 'REQUEST_CHANGES', identityProvider: human('Designer'), agent: async () => { called = true; return agent(); }, quiet: true });
        assert.equal(rejected.gate.state, 'REJECTED');
        assert.equal(rejected.iterations.length, 0);
        assert.equal(called, false);
        assert.deepEqual((await github.state()).pulls, []);
      });
    }));
    it('when an AI identity tries to approve then nothing is recorded or resumed', () => fixture(async root => {
      await gated(root);
      await withRemote(root, async ({ github }) => {
        const run = await startRun({ root, quiet: true, provider: 'codex', agent, publish: true, sbiPath });
        await assert.rejects(approveRun({ root, runId: run.id, purpose: 'implementation-gate', identityProvider: () => ({ id: 'agent', kind: 'ai', source: 'agent-json' }), agent, quiet: true }), /human/i);
        assert.equal((await resumeRun({ root, runId: run.id, quiet: true, agent })).status, 'WAITING_FOR_HUMAN_GATE');
        assert.deepEqual((await github.state()).pulls, []);
      });
    }));
  });

  // pnpm harness:run SBI_URL: the Issue a human marked ready is the only SBI input; nobody writes SBI JSON.
  describe('given a ready SBI Issue passed to harness:run as its URL', () => {
    const issueUrl = 'https://github.com/acme/app/issues/7';
    const pbi = { number: 3, url: 'https://github.com/acme/app/issues/3', title: '管理画面のホーム' };
    const planned = (overrides = {}) => ({
      id: 'SBI-001', kind: 'implementation', title: 'ホームに見出しを表示する', purpose: '管理者がホームを開くと見出しが表示される。',
      scope: { included: ['apps/admin ホーム画面'], excluded: [] },
      acceptanceCriteria: [{ id: 'AC-1', description: 'ホームに見出しが表示される' }, { id: 'AC-2', description: '見出しの文言が仕様どおりである' }],
      scenarios: [{ name: 'ホームを開く', given: ['管理者がログインしている'], when: ['ホームを開く'], then: ['見出しが表示される'], acceptanceIds: ['AC-1', 'AC-2'], test: 'Vitest: apps/admin/src/features/home/index.test.tsx' }],
      dependsOn: [], changeAreas: ['apps/admin'], layers: ['画面Component'], estimatedFiles: 2, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
      verification: { applicationTest: 'Vitest', acceptance: 'Trusted Acceptance', e2e: '不要' }, ...overrides });
    const sbiIssue = (labels = ['sbi', 'ready'], sbi = planned()) => ({ number: 7, title: `${sbi.id} ${sbi.title}`, body: renderSbiBody(sbi, pbi), html_url: issueUrl, state: 'open', labels: labels.map(name => ({ name })) });
    const home = 'apps/admin/src/home.txt';
    const agent = (path = home) => async () => ({ files: [{ path, content: 'ホーム' }] });
    // A human wrote and registered the Trusted Acceptance of Issue #7 before marking it ready. No SBI JSON exists for it.
    const registered = async root => {
      await writeFile(join(root, '.harness/verification/issue-7.mjs'), `import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{join}from"node:path";assert.equal(readFileSync(join(process.argv[2],${JSON.stringify(home)}),"utf8"),"ホーム");console.log(JSON.stringify({acceptance:["AC-1","AC-2"]}));`);
      await mkdir(join(root, '.harness/acceptance'), { recursive: true });
      await writeFile(join(root, '.harness/acceptance/sbi-7.json'), JSON.stringify({ version: 1, sbiIssue: 7, verifiers: [{ id: 'issue-7-acceptance', trustedScript: '.harness/verification/issue-7.mjs', planned: ['ホーム見出し'], acceptanceIds: ['AC-1', 'AC-2'] }] }));
      await update(root, '.harness/config/harness.json', c => {
        // The admin placeholder has no installable app in the fixture; its verifier stands in with a passing command.
        c.verifiers.find(v => v.id === 'admin').commands = [['node', '-e', 'process.exit(0)']];
      });
      await commitFixture(root);
    };
    const withIssue = (root, issue, test) => registered(root).then(() => withRemote(root, test, { state: { issue } }));
    const start = (root, options = {}) => startRun({ root, quiet: true, provider: 'codex', agent: agent(), publish: true, issueUrl, ...options });
    const runs = async root => (await readdir(join(root, '.harness/runs'))).filter(name => name !== '.gitkeep');

    it('when the run passes then the PR carries the Issue snapshot and Run trailers that the CI SBI source check accepts', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root);
      assert.equal(run.executionStatus, 'DONE');
      assert.deepEqual(run.sbiIssue, { repo: 'acme/app', number: 7, url: issueUrl });
      const [pull] = (await github.state()).pulls;
      assert.equal(pull.head.sha, run.headSha);
      assert.ok(pull.body.includes(issueUrl));
      assert.ok(pull.body.includes('Closes #7'), 'merging the PR closes the SBI Issue so dependent SBIs may start');
      const workspace = join(root, run.runDir, 'workspace');
      const committed = JSON.parse((await git(workspace, ['show', `${run.headSha}:.harness/state/sbi-7.json`])).stdout);
      assert.deepEqual(committed, await readJson(join(root, run.runDir, 'sbi-snapshot.json')));
      assert.equal(committed.runId, run.id);
      assert.deepEqual(await runLinks(workspace, run.baselineSha), [{ runId: run.id, url: issueUrl }]);
      const files = [{ path: home }, { path: '.harness/state/sbi-7.json' }];
      // CI rebuilds the SBI with the registration of Issue #7 at the PR head.
      const source = await verifySbiSource({ root: workspace, base: run.baselineSha, files, required: [`production:${home}`], repository: 'acme/app', config: (await loadImpact({ root: workspace, base: run.baselineSha })).config });
      assert.equal(source.status, 'PASS', source.reasons.join('; '));
    })));
    // Each SBI Issue registers its Trusted Acceptance in its own file. CI rebuilds this SBI from .harness/acceptance/sbi-7.json only,
    // so another Issue registered on main meanwhile changes nothing for it. Locally any new commit still stops the run (ADR-0001).
    it('when another Issue registers its Trusted Acceptance after the run started then CI still rebuilds the same SBI, while a local resume stops because the source moved', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const run = await start(root);
      const workspace = join(root, run.runDir, 'workspace');
      await writeFile(join(workspace, '.harness/acceptance/sbi-8.json'), JSON.stringify({ version: 1, sbiIssue: 8, verifiers: [{ id: 'issue-8-acceptance', trustedScript: '.harness/verification/issue-7.mjs', planned: ['別Issue'], acceptanceIds: ['AC-1'] }] }));
      await git(workspace, ['add', '--all']);
      await git(workspace, ['commit', '-m', 'register the Trusted Acceptance of SBI Issue #8 on main']);
      const { config, files } = await loadImpact({ root: workspace, base: run.baselineSha });
      assert.deepEqual(config.verifiers.filter(v => v.sbiIssue).map(v => v.id), ['issue-7-acceptance']);
      const source = await verifySbiSource({ root: workspace, base: run.baselineSha, files, required: [`production:${home}`], repository: 'acme/app', config });
      assert.equal(source.status, 'PASS', source.reasons.join('; '));
      await git(root, ['commit', '--allow-empty', '-m', 'main moved']);
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      // Execution stays DONE (#70); the merge assessment stops for good because the tested SHA is no longer the merge result.
      assert.deepEqual([resumed.executionStatus, resumed.status, resumed.merge.failure.code, resumed.merge.failure.retryable], ['DONE', 'ESCALATED', 'SOURCE_CHANGED', false]);
    })));
    it('when the snapshot matches the ready Issue then the run is judged by its app change, not by where the snapshot is stored', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const run = await start(root);
      assert.equal(run.risk.level, 2, JSON.stringify(run.risk.reasons));
      assert.ok(!run.risk.reasons.includes('harness_policy'));
      assert.equal(run.securityAssessment.securitySensitive, false);
    })));
    it('when the Issue is edited after the run started then the snapshot is no longer verified and the run is LEVEL 3', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root);
      await github.update(s => { s.issue.body += '\n追記'; });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.risk.level, 3);
      assert.ok(resumed.risk.reasons.includes('harness_policy'));
    })));
    it('when the Issue cannot be read during the assessment then the snapshot is not verified and the run is LEVEL 3', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root);
      await github.update(s => { s.issue.number = 99; });
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).risk.level, 3);
    })));
    it('when another SBI runs with --full after Issue #7 registered its Trusted Acceptance then that acceptance is not run for it', () => fixture(root => withIssue(root, sbiIssue(), async () => {
      const run = await startRun({ root, quiet: true, provider: 'fake', full: true });
      // --full also runs every real app verifier, which the fixture cannot pass; only issue-7-acceptance matters here.
      // The registration of Issue #7 is its own file, so a run of another SBI does not even load it.
      assert.equal(run.iterations.length > 0, true);
      for (const iteration of run.iterations) assert.equal(iteration.verification.checks.some(c => c.id === 'issue-7-acceptance'), false);
      assert.equal((await readJson(join(root, run.runDir, 'inputs.json'))).config.verifiers.some(v => v.id === 'issue-7-acceptance'), false);
    })));
    for (const labels of [['sbi', 'needs-review'], ['ready']]) {
      it(`when the Issue is labelled ${labels.join(' + ')} then no run, workspace or PR is created`, () => fixture(root => withIssue(root, sbiIssue(labels), async ({ github }) => {
        await assert.rejects(start(root), /ready|sbi label|needs-review/);
        assert.deepEqual(await runs(root), []);
        assert.deepEqual((await github.state()).pulls, []);
      })));
    }
    it('when an acceptance criterion has no registered Trusted Acceptance then fails before creating a run', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ acceptanceCriteria: [...planned().acceptanceCriteria, { id: 'AC-3', description: '未登録の要件' }] })), async () => {
      await assert.rejects(start(root), /AC-3/);
      assert.deepEqual(await runs(root), []);
    })));
    it('when the agent writes into a sibling directory sharing the prefix then the run escalates without writing it', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const run = await start(root, { agent: agent('apps/admin-other/home.txt') });
      assert.equal(run.status, 'ESCALATED');
      assert.match(run.reason, /scope/);
      assert.equal(await exists(join(root, run.runDir, 'workspace/apps/admin-other/home.txt')), false);
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when the same Issue is run twice then each run has its own ID, branch, snapshot and PR', () => fixture(root => withIssue(root, sbiIssue(), async ({ github }) => {
      const first = await start(root), second = await start(root);
      assert.notEqual(first.id, second.id);
      const pulls = (await github.state()).pulls;
      assert.deepEqual(pulls.map(p => p.head.ref).sort(), [`harness/${first.id}`, `harness/${second.id}`].sort());
      assert.notEqual((await readJson(join(root, first.runDir, 'sbi-snapshot.json'))).runId, (await readJson(join(root, second.runDir, 'sbi-snapshot.json'))).runId);
    })));
    it('when the Issue run stops at the gate then a human approves it by the Issue URL, without a RUN_ID, and the Harness opens the PR', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async ({ github }) => {
      const run = await start(root);
      assert.equal(run.status, 'WAITING_FOR_HUMAN_GATE');
      const approved = await approveRun({ root, issueUrl, purpose: 'implementation-gate', identityProvider: human('Designer'), agent: agent(), quiet: true });
      assert.equal(approved.id, run.id);
      assert.equal(approved.executionStatus, 'DONE');
      assert.equal((await github.state()).pulls.length, 1);
    })));
    // .harness/state/runs/*.json is a projection anyone can edit. The run to approve is chosen from .harness/runs/<id>/summary.json and re-checked before the decision.
    it('when the run projections are edited to make another run look like the one waiting for the Issue then the approval still goes to the run of the Issue', () => fixture(root => update(root, sbiPath, s => { s.risks = ['外部サービス連携']; }).then(() => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async () => {
      const own = await start(root), other = await startRun({ root, quiet: true, provider: 'fake' });
      assert.deepEqual([own.status, other.status], ['WAITING_FOR_HUMAN_GATE', 'WAITING_FOR_HUMAN_GATE']);
      await update(root, `.harness/state/runs/${other.id}.json`, s => { s.sbiIssue = { repo: 'acme/app', number: 7, url: issueUrl }; });
      await update(root, `.harness/state/runs/${own.id}.json`, s => { s.gate.state = 'APPROVED'; delete s.sbiIssue; });
      const approved = await approveRun({ root, issueUrl, purpose: 'implementation-gate', identityProvider: human('Designer'), agent: agent(), quiet: true });
      assert.equal(approved.id, own.id);
      assert.equal(await exists(join(root, '.harness/state/human', `${other.id}.json`)), false);
    }))));
    // summary.json is signed (#75). An edited summary is neither a candidate for the Issue URL nor resumable.
    const summaryOf = (root, run) => join(root, run.runDir, 'summary.json');
    it('when the signed summary of another run is edited to name the Issue and wait at the gate then the approval still goes to the run of the Issue', () => fixture(root => update(root, sbiPath, s => { s.risks = ['外部サービス連携']; }).then(() => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async () => {
      const own = await start(root), other = await startRun({ root, quiet: true, provider: 'fake' });
      await update(root, summaryOf(root, other).slice(root.length + 1), s => { s.sbiIssue = { repo: 'acme/app', number: 7, url: issueUrl }; });
      const approved = await approveRun({ root, issueUrl, purpose: 'implementation-gate', identityProvider: human('Designer'), agent: agent(), quiet: true });
      assert.equal(approved.id, own.id);
      assert.equal(await exists(join(root, '.harness/state/human', `${other.id}.json`)), false);
    }))));
    it('when the signed summary of the waiting run is edited then approving by the Issue URL records nothing and names the run that failed verification', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async ({ github }) => {
      const run = await start(root);
      await update(root, summaryOf(root, run).slice(root.length + 1), s => { s.reason = '手で書き換えた'; });
      await assert.rejects(approveRun({ root, issueUrl, purpose: 'implementation-gate', identityProvider: human('Designer'), agent: agent(), quiet: true }),
        error => error.message.includes(run.id) && /integrity/.test(error.message));
      assert.equal(await exists(join(root, '.harness/state/human', `${run.id}.json`)), false);
      assert.deepEqual((await github.state()).pulls, []);
    })));
    it('when the signed summary of an Issue run is edited to point at another Issue then resume refuses it', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async () => {
      const run = await start(root);
      await update(root, summaryOf(root, run).slice(root.length + 1), s => { s.sbiIssue = { repo: 'acme/app', number: 8, url: 'https://github.com/acme/app/issues/8' }; });
      await assert.rejects(resumeRun({ root, runId: run.id, quiet: true }), /run state integrity/);
    })));
    it('when a decision for the Issue is recorded on a run of another SBI then it is refused before anything is recorded', () => fixture(root => update(root, sbiPath, s => { s.risks = ['外部サービス連携']; }).then(() => withIssue(root, sbiIssue(), async () => {
      const other = await startRun({ root, quiet: true, provider: 'fake' });
      await assert.rejects(recordDecision({ root, runId: other.id, purpose: 'implementation-gate', issueUrl, identityProvider: human('Designer') }), /issues\/7/);
      assert.equal(await exists(join(root, '.harness/state/human', `${other.id}.json`)), false);
    }))));
    // The exit code is what a person or a script sees: only a failed run is non-zero. cli.mjs of the fixture is spawned with a codex stub on PATH.
    describe('when the commands are run from the CLI', () => {
      const cli = async (root, args, response = { files: [{ path: home, content: 'ホーム' }], escalation: null }) => {
        const bin = await mkdtemp(join(tmpdir(), 'harness-codex-'));
        try {
          await writeFile(join(bin, 'codex'), `#!${process.execPath}\nconst fs = require('node:fs'), args = process.argv.slice(2); fs.readFileSync(0); fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], process.env.CODEX_STUB_RESPONSE);\n`);
          await chmod(join(bin, 'codex'), 0o755);
          const child = spawn(process.execPath, [join(root, 'tools/harness/cli.mjs'), ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_STUB_RESPONSE: JSON.stringify(response) } });
          let output = '';
          child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
          const code = await new Promise(resolve => child.on('exit', resolve));
          return { code, output };
        } finally { await rm(bin, { recursive: true, force: true }); }
      };
      // The fixture copies tools/harness without node_modules; the installed ones are linked and kept out of Git.
      const linked = async root => {
        await symlink(join(new URL('../../', import.meta.url).pathname, 'node_modules'), join(root, 'node_modules'));
        await mkdir(join(root, '.git/info'), { recursive: true });
        await appendFile(join(root, '.git/info/exclude'), 'node_modules\n');
      };
      it('when harness:run SBI_URL opens the PR and only GitHub CI is pending then exits 0', () => fixture(root => linked(root).then(() => withIssue(root, sbiIssue(), async ({ github }) => {
        const { code, output } = await cli(root, ['run', issueUrl, '--provider', 'codex']);
        assert.equal(code, 0, output);
        assert.equal((await github.state()).pulls.length, 1);
        assert.match(output, /Pull request: https:\/\/github.com\/acme\/app\/pull\//);
      }))));
      it('when harness:run SBI_URL stops at the gate as required, and harness:approve SBI_URL then opens the PR, then both exit 0', () => fixture(root => linked(root).then(() => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async ({ github }) => {
        const started = await cli(root, ['run', issueUrl, '--provider', 'codex']);
        assert.equal(started.code, 0, started.output);
        assert.match(started.output, /Human Gate: pnpm harness:approve https:\/\/github.com\/acme\/app\/issues\/7 --phase gate/);
        assert.deepEqual((await github.state()).pulls, []);
        const approved = await cli(root, ['approve', issueUrl, '--phase', 'gate']);
        assert.equal(approved.code, 0, approved.output);
        assert.equal((await github.state()).pulls.length, 1);
      }))));
      it('when harness:run SBI_URL escalates because the agent writes outside the scope then exits 2 and opens no PR', () => fixture(root => linked(root).then(() => withIssue(root, sbiIssue(), async ({ github }) => {
        const { code, output } = await cli(root, ['run', issueUrl, '--provider', 'codex'], { files: [{ path: 'apps/admin-other/home.txt', content: 'ホーム' }], escalation: null });
        assert.equal(code, 2, output);
        assert.deepEqual((await github.state()).pulls, []);
      }))));
    });
    it('when two runs of the Issue wait at the gate then approving by the Issue URL refuses to guess and names both runs', () => fixture(root => withIssue(root, sbiIssue(['sbi', 'ready'], planned({ riskCandidate: 'L3' })), async () => {
      const first = await start(root), second = await start(root);
      await assert.rejects(approveRun({ root, issueUrl, purpose: 'implementation-gate', identityProvider: human('Designer'), quiet: true }),
        error => error.message.includes(first.id) && error.message.includes(second.id));
    })));
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
    it('when origin/main moved past the run baseline then refuses before pushing because the merge result was never verified', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ bare, github }) => {
        await advanceMain(root, run.baselineSha);
        await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /origin\/main/);
        assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
        assert.deepEqual((await github.state()).pulls, []);
      });
    }));
    it('when an open PR for the run branch targets another base then refuses instead of reusing it', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      await withRemote(root, async ({ bare, github }) => {
        await github.update(s => { s.pulls.push({ number: 9, title: 'x', body: '', state: 'open', merged: false, html_url: 'https://github.com/acme/app/pull/9', user: { login: 'harness-operator', type: 'User' },
          head: { ref: `harness/${run.id}`, sha: run.headSha }, base: { ref: 'develop', sha: run.baselineSha } }); });
        await assert.rejects(openPullRequest({ root, runId: run.id, quiet: true }), /develop/);
        assert.equal(await remoteSha(bare, `harness/${run.id}`), '');
        assert.equal((await github.state()).pulls.length, 1);
      });
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
