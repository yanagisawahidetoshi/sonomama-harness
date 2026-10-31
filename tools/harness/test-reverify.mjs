// Shared setup of the re-verification tests, split across files so they run in parallel (#197).
import { mkdtemp, realpath, rm, writeFile, readdir, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, update, human, commitFixture } from './test-fixture.mjs';
import { githubMock } from './test-github.mjs';
import { runHarness, resumeRun, approveRun, openPullRequest, reverifyPullRequest } from './index.mjs';
import { githubPrCli } from './github-pr.mjs';
import { readRunState, saveRun } from './run-store.mjs';
import { review } from './reviewer.mjs';
import { verifyReverifyLink } from './reverify.mjs';
import { git } from './workspace.mjs';
import { exists, readJson } from './io.mjs';
import { renderSbiBody } from './planner.mjs';


// Issue #144: after main moves, the finished implementation of a PR is merged with the new main and re-verified by a new run,
// without the implementation agent, and the same PR is updated by a normal push. A and B start from the same main; A is merged first.
export const issueUrl = 'https://github.com/acme/app/issues/7';
export const pbi = { number: 3, url: 'https://github.com/acme/app/issues/3', title: '管理画面のホーム' };
export const planned = (overrides = {}) => ({
  id: 'SBI-001', kind: 'implementation', title: 'ホームに見出しを表示する', purpose: '管理者がホームを開くと見出しが表示される。',
  scope: { included: ['apps/admin ホーム画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: 'ホームに見出しが表示される' }],
  scenarios: [{ name: 'ホームを開く', given: ['管理者がログインしている'], when: ['ホームを開く'], then: ['見出しが表示される'], acceptanceIds: ['AC-1'], test: 'Vitest: apps/admin/src/features/home/index.test.tsx' }],
  dependsOn: [], changeAreas: ['apps/admin'], layers: ['画面Component'], estimatedFiles: 1, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'Vitest', acceptance: 'Trusted Acceptance', e2e: '不要' }, ...overrides });
export const sbiIssue = (sbi = planned()) => ({ number: 7, title: `${sbi.id} ${sbi.title}`, body: renderSbiBody(sbi, pbi), html_url: issueUrl, state: 'open', labels: [{ name: 'sbi' }, { name: 'ready' }] });
export const home = 'apps/admin/src/home.txt';
export const acceptance = expected => `import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{join}from"node:path";assert.equal(readFileSync(join(process.argv[2],${JSON.stringify(home)}),"utf8"),${JSON.stringify(expected)});console.log(JSON.stringify({acceptance:["AC-1"]}));`;
// The implementation agent of B. Re-verification must never call it.
export const spy = () => { const calls = []; return { calls, agent: async (...args) => { calls.push(args); return { files: [{ path: home, content: 'ホーム' }] }; } }; };
export const mockGitHub = githubMock({ permissions: { alice: 'write', bob: 'write', 'harness-operator': 'admin' }, livePulls: true });

export async function registered(root) {
  await writeFile(join(root, '.harness/verification/issue-7.mjs'), acceptance('ホーム'));
  await mkdir(join(root, '.harness/acceptance'), { recursive: true });
  await writeFile(join(root, '.harness/acceptance/sbi-7.json'), JSON.stringify({ version: 1, sbiIssue: 7, verifiers: [{ id: 'issue-7-acceptance', trustedScript: '.harness/verification/issue-7.mjs', planned: ['ホーム見出し'], acceptanceIds: ['AC-1'] }] }));
  await update(root, '.harness/config/harness.json', c => { c.verifiers.find(v => v.id === 'admin').commands = [['node', '-e', 'process.exit(0)']]; });
  await commitFixture(root);
}
// origin is github.com/acme/app for the Harness, while git pushes to a local bare repository. B already has its PR, opened by harness:run.
export function withPullRequestB(root, test, { issue = sbiIssue() } = {}) {
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
export const remoteSha = async (bare, branch) => (await git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true)).stdout.trim();
export const parents = async (root, sha) => (await git(root, ['rev-list', '--parents', '-n', '1', sha])).stdout.trim().split(' ').slice(1);
export const isAncestor = async (root, ancestor, sha) => (await git(root, ['merge-base', '--is-ancestor', ancestor, sha], true)).ok;
// A is merged into main and the operator pulls it: the source checkout and origin/main both move to the new main.
export async function mergeA(root, files = { 'docs/feature-a.md': '# Aの機能\n' }) {
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  await git(root, ['add', '--', ...Object.keys(files)]);
  await git(root, ['commit', '-m', 'Merge pull request A']);
  await git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
}
// A commit on a remote branch that the source checkout never sees.
export async function pushOnto(root, branch, parent, message) {
  const next = (await git(root, ['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', message])).stdout.trim();
  await git(root, ['push', '--quiet', 'origin', `${next}:refs/heads/${branch}`]);
  return next;
}
// A person resolves a conflict on the PR branch in their own clone and pushes it normally.
export async function resolveOnBranch(bare, branch, files) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'harness-person-')));
  try {
    await git(dir, ['clone', '--quiet', bare, 'clone']);
    const clone = join(dir, 'clone');
    await git(clone, ['checkout', '--quiet', branch]);
    await git(clone, ['merge', '--no-edit', 'origin/main'], true);
    for (const [path, content] of Object.entries(files)) { await mkdir(join(clone, path, '..'), { recursive: true }); await writeFile(join(clone, path), content); }
    await git(clone, ['add', '--all']);
    await git(clone, ['commit', '-m', 'Resolve with main']);
    await git(clone, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
    return (await git(clone, ['rev-parse', 'HEAD'])).stdout.trim();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
// A person adds a commit to the PR branch in their own clone; symlinks maps a path to its link target.
export async function commitOnBranch(bare, branch, files, symlinks = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'harness-person-')));
  try {
    await git(dir, ['clone', '--quiet', bare, 'clone']);
    const clone = join(dir, 'clone');
    await git(clone, ['checkout', '--quiet', branch]);
    for (const [path, content] of Object.entries(files)) { await mkdir(join(clone, path, '..'), { recursive: true }); await writeFile(join(clone, path), content); }
    for (const [path, target] of Object.entries(symlinks)) { await mkdir(join(clone, path, '..'), { recursive: true }); await symlink(target, join(clone, path)); }
    await git(clone, ['add', '--all', '--force']);
    await git(clone, ['commit', '-m', 'review fix']);
    await git(clone, ['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
    return (await git(clone, ['rev-parse', 'HEAD'])).stdout.trim();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
// Runs the test with a global Git configuration of the operator, as git reads it from GIT_CONFIG_GLOBAL.
export async function withGlobalGitConfig(text, test) {
  const dir = await mkdtemp(join(tmpdir(), 'harness-gitconfig-')), previous = process.env.GIT_CONFIG_GLOBAL;
  try {
    await writeFile(join(dir, 'gitconfig'), text);
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig');
    await test();
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
export const succeed = (github, sha) => github.update(s => { s.checkRuns[sha] = [...(s.checkRuns[sha] || []), { id: (s.checkRuns[sha] || []).length + 1, name: 'harness', status: 'completed', conclusion: 'success', head_sha: sha, app: { id: 15368 } }]; });
export const reviewBy = (github, number, login, state, commit) => github.update(s => { s.reviews[number] = [...(s.reviews[number] || []), { id: (s.reviews[number] || []).length + 1, user: { login, type: 'User' }, state, commit_id: commit }]; });
export const runs = async root => (await readdir(join(root, '.harness/runs'))).filter(name => name !== '.gitkeep').sort();
