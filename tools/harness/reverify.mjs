import { runIdSchema, sbiSnapshotSchema } from './schemas.mjs';
import { runLinks, snapshotFilePattern } from './sbi-source.mjs';
import { git } from './workspace.mjs';
import { execute } from './io.mjs';
// A re-verification run (ADR-0003) keeps the finished code of a PR, merges the new main into it and verifies the result without the
// implementation agent. The commit it pushes names itself and the implementation run in its trailers, so a check that reads only Git
// objects of the PR head (the merge-approval check of #148) can tie the head to the run. The trailers are a tamper-evident link,
// not an authentication: approvals still come from GitHub Review of that head.
export const reverifyTrailers = ({ runId, parentRunId }) => `Harness-Reverify-Run: ${runId}\nHarness-Parent-Run: ${parentRunId}`;

// The merge of the baseline and a PR head as every party computes it: the re-verification run, the skip check and verifyReverifyLink
// (and the merge-approval check of #148). Settings that change the result are fixed, global and system Git configuration is not read,
// and attributes come from the baseline commit instead of a working tree. Merge drivers defined in the repository config still apply.
const mergeSettings = ['merge.directoryRenames=conflict', 'merge.renames=true', 'merge.renameLimit=7000', 'merge.renormalize=false', 'diff.renames=true', 'core.hooksPath=/dev/null'];
export function mergeTree(cwd, baseline, head, options = []) {
  return execute('git', [...mergeSettings.flatMap(setting => ['-c', setting]), `--attr-source=${baseline}`, 'merge-tree', '--write-tree', ...options, baseline, head],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
}
export async function gitVersion(cwd) { return (await execute('git', ['--version'], { cwd })).stdout.trim(); }

export function parsePullUrl(url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/.exec(String(url ?? '').trim());
  if (!match) throw new Error('Invalid GitHub pull request URL; expected https://github.com/<owner>/<repo>/pull/<number>');
  return { owner: match[1], repo: match[2], number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` };
}

const isAncestor = async (root, ancestor, sha) => (await git(root, ['merge-base', '--is-ancestor', ancestor, sha], true)).ok;

// The SBI snapshot the implementation run committed, read from Git objects only: exactly one snapshot added between base and head.
export async function committedSnapshot(root, base, head) {
  const paths = (await git(root, ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`])).stdout.split('\0').filter(path => snapshotFilePattern.test(path));
  if (paths.length !== 1) throw new Error(`${head.slice(0, 12)} には.harness/state/sbi-<Issue番号>.jsonのSBI snapshotが1つだけ必要です（${paths.length}件）`);
  const parsed = sbiSnapshotSchema.safeParse(JSON.parse((await git(root, ['show', `${head}:${paths[0]}`])).stdout));
  if (!parsed.success) throw new Error(`${paths[0]} はSBI snapshotとして不正です`);
  return { path: paths[0], snapshot: parsed.data };
}

// NONE: the head does not claim to be a re-verification. FAIL: it claims one that its own Git objects contradict.
// A merge commit is [baseline, previous tested]; a link commit on a head that already contains the baseline is [previous] with the same tree.
export async function verifyReverifyLink({ root, base, head }) {
  try {
    const message = (await git(root, ['log', '-1', '--format=%B', head])).stdout;
    const trailers = (await git(root, ['log', '-1', '--format=%(trailers:only,unfold)', head])).stdout;
    // Fail closed like claimsSbiSource: a trailer line Git does not parse as a trailer still counts as a claim.
    if (!/^Harness-(Reverify|Parent)-Run:/m.test(message)) return { status: 'NONE', reasons: [] };
    const values = key => [...trailers.matchAll(new RegExp(`^${key}: *(\\S+)$`, 'gm'))].map(m => m[1]);
    const [runIds, parentIds] = [values('Harness-Reverify-Run'), values('Harness-Parent-Run')];
    const reasons = [];
    if (runIds.length !== 1 || !runIdSchema.safeParse(runIds[0]).success) reasons.push('Harness-Reverify-Run must name exactly one run');
    if (parentIds.length !== 1 || !runIdSchema.safeParse(parentIds[0]).success) reasons.push('Harness-Parent-Run must name exactly one run');
    const parents = (await git(root, ['rev-list', '--parents', '-n', '1', head])).stdout.trim().split(' ').slice(1);
    const baselineSha = (await git(root, ['merge-base', base, head])).stdout.trim();
    const tree = sha => git(root, ['rev-parse', `${sha}^{tree}`]).then(r => r.stdout.trim());
    let previousTestedSha = null;
    if (parents.length === 2 && parents[0] === baselineSha) {
      // The merge commit must be the clean merge of its parents; a hand-edited tree under the trailers is not a re-verification.
      const merged = await mergeTree(root, parents[0], parents[1]);
      if (merged.ok && merged.stdout.trim().split('\n')[0] === await tree(head)) previousTestedSha = parents[1];
      else reasons.push('the re-verification merge commit is not the clean merge of its parents');
    } else if (parents.length === 1 && parents[0] !== baselineSha && await isAncestor(root, baselineSha, parents[0])) {
      if (await tree(parents[0]) === await tree(head)) previousTestedSha = parents[0];
      else reasons.push('the re-verification link commit changes files');
    } else reasons.push(`the re-verification commit does not sit on ${base} (${baselineSha.slice(0, 12)})`);
    const { snapshot } = await committedSnapshot(root, baselineSha, head);
    if (parentIds[0] && snapshot.runId !== parentIds[0]) reasons.push(`Harness-Parent-Run ${parentIds[0]} is not the run of the committed SBI snapshot (${snapshot.runId})`);
    if (!(await runLinks(root, baselineSha, head)).some(link => link.runId === snapshot.runId && link.url === snapshot.source.url)) reasons.push(`no commit carries Harness-Run: ${snapshot.runId} with SBI-Issue: ${snapshot.source.url}`);
    return { status: reasons.length ? 'FAIL' : 'PASS', runId: runIds[0] ?? null, parentRunId: parentIds[0] ?? null, baselineSha, previousTestedSha, reasons };
  } catch (error) { return { status: 'FAIL', runId: null, parentRunId: null, baselineSha: null, previousTestedSha: null, reasons: [error.message] }; }
}
