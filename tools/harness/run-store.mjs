import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json, readJson } from './io.mjs';
import { digest, toolFingerprint, workspaceIntegrity, workspaceFingerprint, sourceIntegrity, assertWorktreeOwner } from './workspace.mjs';
import { check } from './check.mjs';
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
export async function saveRun(root, summary) {
  await json(runPaths(root, summary.id).summary, summary);
  await json(join(root, '.harness/state/runs', `${summary.id}.json`), summary);
}
export async function loadRun(root, runId) {
  const paths = runPaths(root, runId);
  const summary = await readJson(paths.summary);
  if (summary.id !== runId) throw new Error('run ID mismatch');
  if (summary.cleanedAt) throw new Error('Run workspace was cleaned; start a new run');
  await sourceIntegrity(root, summary.baselineSha);
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
  return { summary, inputs, paths };
}
