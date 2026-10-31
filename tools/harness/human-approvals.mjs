import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { json, exists, readJson } from './io.mjs';
import { approvalRecordSchema } from './schemas.mjs';
import { loadRun, runPaths, withRunLock } from './run-store.mjs';
import { signingKey, sign, equal } from './signing.mjs';
export { signingKey, sign, equal };

export function localHumanIdentity() {
  const user = userInfo();
  return { id: `os:${user.uid}:${user.username}`, kind: 'human', source: 'local-os-user' };
}
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
// A run waits for a decision given by SBI Issue URL only while its own summary names that Issue and is in the waiting state of the purpose.
export const waitsForIssue = (summary, url, purpose) => summary.sbiIssue?.url === url && !summary.cleanedAt && purpose === 'merge' && summary.executionStatus === 'DONE' && !summary.pullRequest;
export async function recordDecision({ root, runId, purpose, decision = 'APPROVE', identityProvider = localHumanIdentity, issueUrl = null }) {
  return withRunLock(root, runId, async () => {
    // #175: the SBI approval decides the implementation; no implementation gate is recorded any more.
    if (purpose === 'implementation-gate') throw new Error('The implementation gate no longer exists (#175); the SBI approval decides the implementation. Only --phase merge is recorded');
    if (purpose !== 'merge' || !['APPROVE', 'REVOKE', 'REQUEST_CHANGES'].includes(decision)) throw new Error('Invalid approval purpose/decision');
    const { summary } = await loadRun(root, runId);
    // Chosen by Issue URL: re-checked on the verified run under its lock, so no other run receives the decision.
    if (issueUrl && !waitsForIssue(summary, issueUrl, purpose)) throw new Error(`run ${runId} は ${issueUrl} の${purpose}を待っていません。記録していません`);
    if (purpose === 'merge' && summary.executionStatus !== 'DONE') throw new Error('Execution must be DONE before merge approval');
    if (purpose === 'merge' && summary.pullRequest) throw new Error(`GitHub PR mode: merge approval comes from GitHub Review on ${summary.pullRequest.url}; harness:approve --phase merge is not used`);
    const identity = await identityProvider();
    if (identity?.kind !== 'human' || !identity.id || !identity.source) throw new Error('Authenticated human identity required');
    const key = await signingKey(root, true);
    const records = await authenticatedRecords(root, runId);
    const body = { id: randomUUID(), runId, purpose, reviewer: identity.id, kind: 'human', identitySource: identity.source,
      decision, approvedAt: new Date().toISOString(), commitSha: summary.headSha, contextDigest: summary.merge.contextDigest };
    const record = approvalRecordSchema.parse({ ...body, signature: sign(key, body) });
    records.push(record);
    const envelope = { records, signature: sign(key, records) };
    await json(runPaths(root, runId).ledger, envelope);
    await json(join(runPaths(root, runId).directory, 'approvals.json'), { headSha: summary.headSha, approvals: records, source: 'authenticated local ledger; projection only' });
    // The ledger is intentionally outside the agent workspace; evidence is just a projection.
    return record;
  });
}
