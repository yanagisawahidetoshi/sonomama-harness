import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './io.mjs';
import { describeImpact, loadImpact } from './impact.mjs';
import { configSchema } from './schemas.mjs';
import { git } from './workspace.mjs';
// pre-push scope. Impact Analysis decides the verifiers; whatever the gate cannot scope safely runs the Full Gate (harness:test).
const zero = /^0{40}$/;

export function planPushGate({ refs, head, fallbackBase }) {
  const lines = refs.split('\n').filter(Boolean).map(line => line.split(' '));
  if (!lines.length || lines.some(parts => parts.length !== 4)) return { mode: 'full', shas: [head], reasons: ['push refs unknown'] };
  const pushed = lines.filter(([, localSha]) => !zero.test(localSha));
  if (!pushed.length) return { mode: 'skip', reasons: ['delete only'] };
  if (pushed.length > 1) return { mode: 'full', shas: [...new Set(pushed.map(([, localSha]) => localSha))], reasons: ['several refs pushed'] };
  const [, localSha, remoteRef, remoteSha] = pushed[0];
  if (!zero.test(remoteSha)) return { mode: 'impact', shas: [localSha], base: remoteSha, reasons: [`remote:${remoteRef}`] };
  if (!fallbackBase) return { mode: 'full', shas: [localSha], reasons: ['no base for a new branch'] };
  return { mode: 'impact', shas: [localSha], base: fallbackBase, reasons: [`new-branch:${fallbackBase}`] };
}

const resolves = async (root, ref) => (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true)).ok;

// The working tree may hold uncommitted fixes, so every verifier runs in a detached worktree of the pushed commit outside the checkout.
// Cleanup never forces: a worktree that verification left dirty is kept and reported.
async function inPushedCommit({ root, sha, install, log, leftovers }, fn) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-push-gate-')));
  const workspace = join(parent, 'tree');
  try { await git(root, ['worktree', 'add', '--detach', workspace, sha]); } catch (error) { await rmdir(parent); throw error; }
  try {
    log(`Push gate worktree: ${sha} at ${workspace}`);
    return await install(workspace) && await fn(workspace);
  } finally {
    const removed = await git(root, ['worktree', 'remove', workspace], true);
    if (removed.ok) await rmdir(parent);
    else {
      leftovers.push(workspace);
      log(`Push gate worktree kept: ${workspace} (${removed.stderr.trim() || 'git worktree remove failed'})`);
    }
  }
}

export async function runPushGate({ root, refs, runFull, verifyOne, install, log = () => {} }) {
  const config = configSchema.parse(await readJson(join(root, '.harness/config/harness.json')));
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const fallback = `${config.github.remote}/${config.github.base}`;
  let plan = planPushGate({ refs, head, fallbackBase: await resolves(root, fallback) ? fallback : null });
  if (plan.mode === 'impact' && !await resolves(root, plan.base)) plan = { ...plan, mode: 'full', base: undefined, reasons: ['remote commit unknown locally'] };
  if (plan.mode === 'skip') { log(`Push gate: ${plan.mode} (${plan.reasons.join(', ')})`); return { ...plan, passed: true, leftovers: [] }; }
  const leftovers = [];
  let passed = true, impact;
  for (const sha of plan.shas) {
    passed = await inPushedCommit({ root, sha, install, log, leftovers }, async workspace => {
      if (plan.mode === 'impact') {
        ({ impact } = await loadImpact({ root: workspace, base: plan.base }));
        for (const line of describeImpact(impact)) log(line);
        if (impact.fullGate) plan = { ...plan, mode: 'full', reasons: impact.fullGateReasons };
      }
      log(`Push gate: ${plan.mode} (${plan.reasons.join(', ')})`);
      if (plan.mode === 'full') return runFull(workspace);
      let ok = true;
      for (const id of impact.requiredVerifiers) ok = await verifyOne(id, plan.base, workspace) && ok;
      return ok;
    }) && passed;
  }
  return { ...plan, impact, passed, leftovers };
}
