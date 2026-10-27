import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { json, exists, readJson } from './io.mjs';
import { approvalRecordSchema } from './schemas.mjs';
import { loadRun, runPaths, withRunLock } from './run-store.mjs';

export function localHumanIdentity() {
  const user = userInfo();
  return { id: `os:${user.uid}:${user.username}`, kind: 'human', source: 'local-os-user' };
}
export async function signingKey(root, create = false) {
  const path = join(root, '.harness/state/human/.key');
  if (create) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return readFile(path);
}
export const sign = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function authenticatedRecords(root, runId) {
  const path = runPaths(root, runId).ledger;
  if (!await exists(path)) return [];
  const key = await signingKey(root);
  const envelope = await readJson(path);
  if (!equal(envelope.signature, sign(key, envelope.records))) throw new Error('approval ledger signature invalid');
  return envelope.records.map(raw => {
    const record = approvalRecordSchema.parse(raw);
    const { signature, ...body } = raw;
    if (record.runId !== runId || !equal(signature, sign(key, body))) throw new Error('approval signature invalid');
    return record;
  });
}
// The identity adapter runs in the trusted human CLI, never in the agent response protocol.
// CLI deliberately offers no --reviewer option; two aliases of one OS account count as one.
export async function recordDecision({ root, runId, purpose, decision = 'APPROVE', identityProvider = localHumanIdentity }) {
  return withRunLock(root, runId, async () => {
    if (!['implementation-gate', 'design-approval', 'merge'].includes(purpose) || !['APPROVE', 'REVOKE', 'REQUEST_CHANGES'].includes(decision)) throw new Error('Invalid approval purpose/decision');
    const { summary } = await loadRun(root, runId);
    if (purpose === 'merge' && summary.executionStatus !== 'DONE') throw new Error('Execution/gate must complete before merge approval');
    if (purpose === 'implementation-gate' && (!summary.gate.required || (summary.executionStatus !== 'PENDING' && decision !== 'REVOKE'))) throw new Error('Implementation gate cannot be granted after execution');
    if (purpose === 'design-approval' && (!summary.designApproval?.required || (summary.executionStatus !== 'PENDING' && decision !== 'REVOKE'))) throw new Error('Design Approval must precede production implementation');
    const identity = await identityProvider();
    if (identity?.kind !== 'human' || !identity.id || !identity.source) throw new Error('Authenticated human identity required');
    const key = await signingKey(root, true);
    const records = await authenticatedRecords(root, runId);
    const gate = purpose === 'implementation-gate';
    const design = purpose === 'design-approval';
    const body = { id: randomUUID(), runId, purpose, reviewer: identity.id, kind: 'human', identitySource: identity.source,
      decision, approvedAt: new Date().toISOString(), commitSha: design ? summary.baselineSha : gate ? summary.gate.headSha : summary.headSha,
      contextDigest: design ? summary.designApproval.contextDigest : gate ? summary.gate.contextDigest : summary.merge.contextDigest };
    const record = approvalRecordSchema.parse({ ...body, signature: sign(key, body) });
    records.push(record);
    const envelope = { records, signature: sign(key, records) };
    await json(runPaths(root, runId).ledger, envelope);
    await json(join(runPaths(root, runId).directory, 'approvals.json'), { headSha: summary.headSha, approvals: records, source: 'authenticated local ledger; projection only' });
    // The ledger is intentionally outside the agent workspace; evidence is just a projection.
    return record;
  });
}
