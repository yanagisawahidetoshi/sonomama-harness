import { join } from 'node:path';
import { readJson } from './io.mjs';
import { describeImpact, loadImpact } from './impact.mjs';
import { configSchema } from './schemas.mjs';
import { git } from './workspace.mjs';
// pre-push scope. Impact Analysis decides the verifiers; whatever the gate cannot scope safely runs the Full Gate (harness:test).
const zero = /^0{40}$/;

export function planPushGate({ refs, head, fallbackBase }) {
  const lines = refs.split('\n').filter(Boolean).map(line => line.split(' '));
  if (!lines.length || lines.some(parts => parts.length !== 4)) return { mode: 'full', reasons: ['push refs unknown'] };
  const pushed = lines.filter(([, localSha]) => !zero.test(localSha));
  if (!pushed.length) return { mode: 'skip', reasons: ['delete only'] };
  if (pushed.length > 1) return { mode: 'full', reasons: ['several refs pushed'] };
  const [, localSha, remoteRef, remoteSha] = pushed[0];
  // The gate verifies the working tree, so it can only stand for the push when HEAD is the pushed commit.
  if (localSha !== head) return { mode: 'full', reasons: ['pushed commit is not HEAD'] };
  if (!zero.test(remoteSha)) return { mode: 'impact', base: remoteSha, reasons: [`remote:${remoteRef}`] };
  if (!fallbackBase) return { mode: 'full', reasons: ['no base for a new branch'] };
  return { mode: 'impact', base: fallbackBase, reasons: [`new-branch:${fallbackBase}`] };
}

const resolves = async (root, ref) => (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true)).ok;

export async function runPushGate({ root, refs, runFull, verifyOne, log = () => {} }) {
  const config = configSchema.parse(await readJson(join(root, '.harness/config/harness.json')));
  const head = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const fallback = `${config.github.remote}/${config.github.base}`;
  let plan = planPushGate({ refs, head, fallbackBase: await resolves(root, fallback) ? fallback : null });
  if (plan.mode === 'impact' && !await resolves(root, plan.base)) plan = { mode: 'full', reasons: ['remote commit unknown locally'] };
  let impact;
  if (plan.mode === 'impact') {
    ({ impact } = await loadImpact({ root, base: plan.base }));
    for (const line of describeImpact(impact)) log(line);
    if (impact.fullGate) plan = { mode: 'full', reasons: impact.fullGateReasons };
  }
  log(`Push gate: ${plan.mode} (${plan.reasons.join(', ')})`);
  if (plan.mode === 'skip') return { ...plan, passed: true };
  if (plan.mode === 'full') return { ...plan, passed: await runFull() };
  let passed = true;
  for (const id of impact.requiredVerifiers) passed = await verifyOne(id, plan.base) && passed;
  return { ...plan, impact, passed };
}
