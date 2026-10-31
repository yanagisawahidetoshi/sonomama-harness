import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { fixture, update } from './test-fixture.mjs';
import { loadImpact } from './impact.mjs';
import { git } from './workspace.mjs';
import { judgeEvidenceJobs, judgeProducer, runTrustedJudge, selectEvidenceRun } from './trusted-judge.mjs';

// ADR-0008: the pull_request run is untrusted evidence; the Completion Judge on pull_request_target reads it as data with main's code.
const head = 'a'.repeat(40), other = 'b'.repeat(40);
const files = (...paths) => paths.map(path => ({ path }));

describe('Evidence producer of the Completion Judge', () => {
  for (const path of ['.github/workflows/probe.yml', '.github/actions/setup/action.yml', 'tools/harness/impact.mjs', '.harness/rules/security.json',
    '.harness/verification/api-env.mjs', '.harness/config/harness.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version', '.npmrc']) {
    it(`when the PR changes ${path} then the PR changed the producer of its own evidence`, () => {
      assert.deepEqual(judgeProducer(files(path, 'apps/api/app/models/lesson.rb')).paths, [path]);
    });
  }

  for (const path of ['.harness/state/sbi-7.json', '.harness/state/sbi-greeting.json', '.harness/acceptance/sbi-7.json', 'apps/api/spec/acceptance/sbi_7/greeting_spec.rb',
    'apps/admin/package.json', 'apps/api/Gemfile.lock', 'docs/adr/0008-trusted-completion-judge.md']) {
    it(`when the PR changes only ${path} then the producer is unchanged`, () => {
      assert.deepEqual(judgeProducer(files(path)).paths, []);
    });
  }

  it('when the PR changes the producer then the reason names every producer path', () => {
    const judged = judgeProducer(files('pnpm-lock.yaml', '.github/workflows/harness.yml'));
    assert.match(judged.reasons.join('\n'), /^producer changed: \.github\/workflows\/harness\.yml, pnpm-lock\.yaml/);
  });
});

describe('Evidence run of the Completion Judge', () => {
  const run = (extra = {}) => ({ id: 10, run_attempt: 1, head_sha: head, event: 'pull_request', path: '.github/workflows/harness.yml', status: 'completed', ...extra });

  it('when the pull_request run of harness.yml for the head completed then it is the evidence', () => {
    assert.equal(selectEvidenceRun({ runs: [run()], headSha: head })?.id, 10);
  });

  for (const [name, extra] of [
    ['it is for another head', { head_sha: other }],
    ['it is a push run', { event: 'push' }],
    ['it is a pull_request_target run', { event: 'pull_request_target' }],
    ['it is another workflow file of the PR', { path: '.github/workflows/probe.yml' }],
    ['it has not completed', { status: 'in_progress' }],
  ]) {
    it(`when the only run ${name} then there is no evidence`, () => {
      assert.equal(selectEvidenceRun({ runs: [run(extra)], headSha: head }), null);
    });
  }

  it('when the run was re-run then the latest attempt of the latest run is the evidence', () => {
    const runs = [run({ id: 10, run_attempt: 2 }), run({ id: 12, run_attempt: 1 }), run({ id: 11, run_attempt: 3 })];
    assert.equal(selectEvidenceRun({ runs, headSha: head })?.id, 12);
  });
});

describe('Jobs of the evidence run', () => {
  // The impact main computed for the PR: two verifiers, no full gate, no maestro lane.
  const impact = { requiredVerifiers: ['admin', 'rails'], fullGate: false, maestro: [] };
  const job = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
  const passing = [job('impact'), job('verifiers (rails)'), job('verifiers (admin)'), job('harness-test', 'skipped'), job('harness-demo', 'skipped'), job('maestro', 'skipped'), job('harness')];

  it('when every verifier the impact of main requires succeeded in the run then the jobs pass', () => {
    const judged = judgeEvidenceJobs({ jobs: passing, impact });
    assert.deepEqual(judged.reasons, []);
    assert.equal(judged.needs.verifiers.result, 'success');
  });

  it('when a required verifier has no job in the run then fails even if a check of that name succeeded elsewhere', () => {
    const judged = judgeEvidenceJobs({ jobs: passing.filter(j => j.name !== 'verifiers (admin)'), impact });
    assert.ok(judged.reasons.includes('verifiers (admin): missing'), judged.reasons.join('; '));
    assert.notEqual(judged.needs.verifiers.result, 'success');
  });

  for (const conclusion of ['failure', 'skipped', 'cancelled']) {
    it(`when a required verifier job is ${conclusion} then fails`, () => {
      const judged = judgeEvidenceJobs({ jobs: passing.map(j => j.name === 'verifiers (rails)' ? job(j.name, conclusion) : j), impact });
      assert.ok(judged.reasons.includes(`verifiers (rails): ${conclusion}`), judged.reasons.join('; '));
    });
  }

  it('when the run skipped the verifiers because its own impact asked for none then fails on every verifier main requires', () => {
    const judged = judgeEvidenceJobs({ jobs: [job('impact'), job('verifiers', 'skipped'), job('harness-test', 'skipped'), job('harness-demo', 'skipped')], impact });
    assert.deepEqual(judged.reasons.filter(r => r.startsWith('verifiers')), ['verifiers (admin): missing', 'verifiers (rails): missing']);
  });

  it('when the full gate is required then every harness-test shard and harness-demo must succeed', () => {
    const full = { ...impact, fullGate: true };
    const jobs = [...passing.filter(j => !j.name.startsWith('harness-')), job('harness-test (1)'), job('harness-test (2)', 'failure'), job('harness-test (3)'), job('harness-demo')];
    const judged = judgeEvidenceJobs({ jobs, impact: full });
    assert.ok(judged.reasons.includes('harness-test (2): failure'), judged.reasons.join('; '));
    assert.notEqual(judged.needs['harness-test'].result, 'success');
  });

  it('when the PR-side Completion Judge job failed or passed then it is not counted either way', () => {
    assert.deepEqual(judgeEvidenceJobs({ jobs: passing.map(j => j.name === 'harness' ? job('harness', 'failure') : j), impact }).reasons, []);
    assert.ok(judgeEvidenceJobs({ jobs: [job('impact'), job('harness')], impact }).reasons.length > 0);
  });

  it('when a job this Judge does not know failed then fails', () => {
    const judged = judgeEvidenceJobs({ jobs: [...passing, job('lint', 'failure')], impact });
    assert.ok(judged.reasons.includes('lint: failure'), judged.reasons.join('; '));
  });
});

describe('Two trees of the Completion Judge', () => {
  it('when the PR tree changes the Harness config to drop a verifier then the impact still comes from the trusted root', () => fixture(async root => {
    await git(root, ['worktree', 'add', '-q', '-b', 'feature', join(root, '.pr')]);
    const workspace = join(root, '.pr');
    await update(workspace, '.harness/config/harness.json', value => { for (const v of value.verifiers) delete v.appliesTo; value.verifiers = value.verifiers.filter(v => v.id !== 'admin'); });
    await update(workspace, 'apps/admin/package.json', value => { value.description = 'changed'; });
    await git(workspace, ['add', '--all']);
    await git(workspace, ['commit', '-m', 'drop the admin verifier']);
    const { impact } = await loadImpact({ root, workspace, base: 'main' });
    assert.ok(impact.requiredVerifiers.includes('admin'), impact.requiredVerifiers.join(', '));
  }));
});

describe('Workflow of the trusted Completion Judge', () => {
  const load = async () => parse(await readFile(new URL('../../.github/workflows/completion-judge.yml', import.meta.url), 'utf8'));
  const steps = job => job.steps ?? [];
  const text = value => JSON.stringify(value);

  it('when GitHub starts the Judge then only pull_request_target triggers it, so the workflow always comes from main', async () => {
    const workflow = await load();
    assert.deepEqual(Object.keys(workflow.on), ['pull_request_target']);
  });

  it('when a newer push reaches the PR then the older Judge of the same PR is cancelled', async () => {
    const { concurrency } = await load();
    assert.match(concurrency.group, /github\.event\.pull_request\.number/);
    assert.equal(concurrency['cancel-in-progress'], true);
  });

  it('when the Judge judges then it holds no secret and no environment, and never checks out the PR head as code', async () => {
    const { jobs } = await load();
    assert.equal(jobs.judge.environment, undefined);
    assert.doesNotMatch(text(jobs.judge), /secrets\./);
    for (const step of steps(jobs.judge).filter(s => String(s.uses).startsWith('actions/checkout@'))) assert.doesNotMatch(text(step.with ?? {}), /pull_request\.head|head_ref/);
    assert.deepEqual(jobs.judge.permissions, { actions: 'read', contents: 'read', issues: 'read', 'pull-requests': 'read' });
  });

  it('when the result is published then only the job with the App key checks nothing out and runs no Harness code', async () => {
    const { jobs } = await load();
    assert.equal(jobs.publish.environment, 'completion-judge');
    assert.deepEqual([jobs.publish.needs].flat(), ['judge']);
    assert.match(String(jobs.publish.if), /always\(\)/);
    assert.equal(steps(jobs.publish).some(s => String(s.uses).startsWith('actions/checkout@')), false);
    assert.doesNotMatch(text(steps(jobs.publish)), /pnpm|node tools|harness:/);
    assert.deepEqual(jobs.publish.permissions, {});
  });

  it('when any job runs then no Actions cache is restored or saved', async () => {
    const workflow = await load();
    assert.doesNotMatch(text(workflow), /actions\/cache|"cache":/);
  });
});

describe('Trusted Completion Judge over a PR tree and its evidence run', () => {
  const branch = async (root, change) => {
    await git(root, ['worktree', 'add', '-q', '-b', 'feature', join(root, '.pr')]);
    const workspace = join(root, '.pr');
    await change(workspace);
    await git(workspace, ['add', '--all']);
    await git(workspace, ['commit', '-m', 'change']);
    return { workspace, headSha: (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim() };
  };
  const job = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
  const judge = ({ root, workspace, headSha, run = { id: 1, head_sha: headSha }, jobs }) => runTrustedJudge({ root, workspace, base: 'main', repository: 'acme/app', headSha,
    wait: async () => run, readJobs: async () => jobs, download: async () => null, evidenceDir: join(root, '.evidence') });

  it('when a docs change has a completed evidence run with every job passing then passes', () => fixture(async root => {
    const { workspace, headSha } = await branch(root, ws => writeFile(join(ws, 'docs/note.md'), 'note\n'));
    const judged = await judge({ root, workspace, headSha, jobs: [job('impact'), job('harness-test', 'skipped'), job('harness-demo', 'skipped')] });
    assert.deepEqual(judged.reasons, []);
    assert.equal(judged.status, 'PASS');
  }));

  it('when the PR adds a workflow whose jobs all pass then fails because it changed the producer of its evidence', () => fixture(async root => {
    const { workspace, headSha } = await branch(root, async ws => { await mkdir(join(ws, '.github/workflows'), { recursive: true }); await writeFile(join(ws, '.github/workflows/probe.yml'), 'on: pull_request\n'); });
    const judged = await judge({ root, workspace, headSha, jobs: [job('impact'), job('harness-test (1)'), job('harness-demo'), job('Completion Judge')] });
    assert.equal(judged.status, 'FAIL');
    assert.match(judged.reasons.join('\n'), /producer changed: \.github\/workflows\/probe\.yml/);
  }));

  it('when no evidence run completed for the head then fails', () => fixture(async root => {
    const { workspace, headSha } = await branch(root, ws => writeFile(join(ws, 'docs/note.md'), 'note\n'));
    const judged = await judge({ root, workspace, headSha, run: null, jobs: [] });
    assert.equal(judged.status, 'FAIL');
    assert.match(judged.reasons.join('\n'), /evidence: no completed pull_request run/);
  }));

  it('when the PR tree is not the head the event names then fails', () => fixture(async root => {
    const { workspace } = await branch(root, ws => writeFile(join(ws, 'docs/note.md'), 'note\n'));
    const judged = await judge({ root, workspace, headSha: other, run: { id: 1, head_sha: other }, jobs: [job('impact'), job('harness-test', 'skipped'), job('harness-demo', 'skipped')] });
    assert.equal(judged.status, 'FAIL');
    assert.match(judged.reasons.join('\n'), /is not the head bbbbbbbbbbbb/);
  }));
});
