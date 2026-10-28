import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json, readJson } from './io.mjs';
import { redact } from './evidence-protection.mjs';
import { runStateSchema } from './schemas.mjs';
import { signingKey, sign, equal } from './signing.mjs';
import { digest, toolFingerprint, workspaceIntegrity, workspaceFingerprint, sourceIntegrity, assertWorktreeOwner } from './workspace.mjs';
import { check } from './check.mjs';
import { healthMetrics } from './health-metrics.mjs';
export function runPaths(root, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,150}$/.test(runId)) throw new Error('Invalid run ID');
  const directory = join(root, '.harness/runs', runId);
  return { directory, workspace: join(directory, 'workspace'), summary: join(directory, 'summary.json'),
    ledger: join(root, '.harness/state/human', `${runId}.json`) };
}
export async function withRunLock(root, runId, fn) {
  const lock = join(runPaths(root, runId).directory, '.operation-lock');
  try { await mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another operation is modifying this run');
    throw error;
  }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
}
// Only the trusted Harness process holds the key, so only it can produce a run state that resume accepts.
// summary.json is the authority; health-metrics.json, .harness/state/runs and the other run files are projections.
export const runStateSignature = (key, state) => sign(key, { purpose: 'run-state', state });
export async function saveRun(root, summary) {
  const paths = runPaths(root, summary.id);
  // Sign exactly what is written: the redacted JSON form.
  const state = JSON.parse(JSON.stringify(redact(summary)));
  const parsed = runStateSchema.safeParse(state);
  if (!parsed.success) throw new Error(`run state schema invalid: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  await json(paths.summary, { ...state, integrity: { version: 1, signature: runStateSignature(await signingKey(root, true), state) } });
  await json(join(paths.directory, 'health-metrics.json'), healthMetrics(summary));
  await json(join(root, '.harness/state/runs', `${summary.id}.json`), summary);
}
export async function readRunState(root, runId) {
  const { integrity, ...state } = await readJson(runPaths(root, runId).summary);
  let key = null;
  try { key = await signingKey(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (integrity?.version !== 1 || !key || !equal(integrity.signature, runStateSignature(key, state))) throw new Error('run state integrity check failed; summary.json was not written by the Harness. Start a new run');
  const parsed = runStateSchema.safeParse(state);
  if (!parsed.success) throw new Error(`run state schema invalid: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  if (state.id !== runId) throw new Error('run ID mismatch');
  return state;
}
export async function loadRun(root, runId) {
  const paths = runPaths(root, runId);
  const summary = await readRunState(root, runId);
  if (summary.cleanedAt) throw new Error('Run workspace was cleaned; start a new run');
  // A dirty checkout is retryable only when every trusted input below still matches the snapshot.
  const dirty = await sourceIntegrity(root, summary.baselineSha).then(() => null, error => { if (error.code !== 'SOURCE_DIRTY') throw error; return error; });
  await assertWorktreeOwner(root, paths.workspace, summary.baselineSha);
  const inputs = await readJson(join(paths.directory, 'inputs.json'));
  if (digest(inputs) !== summary.inputsDigest) throw new Error('input snapshot changed');
  const current = await check(root, summary.sbiPath);
  for (const key of ['config', 'rules', 'sbi', 'riskPolicy', 'securityPolicy', 'humanGates', 'securityDocuments', 'lanePolicy']) {
    if (digest(current[key]) !== digest(inputs[key])) throw new Error(`${key} snapshot changed; start a new run`);
  }
  if (await toolFingerprint(root) !== inputs.toolFingerprint || await readFile(join(root, '.harness/skills/implement.md'), 'utf8') !== inputs.skill) throw new Error('trusted tool/skill snapshot changed');
  await workspaceIntegrity(paths.workspace, summary.headSha);
  if (await workspaceFingerprint(paths.workspace) !== summary.workspaceDigest) throw new Error('workspace snapshot changed; repeat verification in a new run');
  if (dirty) throw dirty;
  return { summary, inputs, paths };
}
