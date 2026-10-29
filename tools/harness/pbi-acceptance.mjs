import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { json, exists, readJson } from './io.mjs';
import { signingKey, sign, equal, localHumanIdentity } from './human-approvals.mjs';
import { pbiAcceptanceRecordSchema } from './schemas.mjs';
import { parseIssueUrl } from './planner.mjs';

// PBI Human Acceptance is a signed record outside Git and the agent workspace, bound to the PBI and the evidence digest the human confirmed.
// It is separate from implementation-gate / design-approval / merge / api-schema records and never substitutes for them.
export const pbiAcceptanceLedgerPath = (root, ref) => join(root, '.harness/state/human/pbi-acceptance', `${ref.owner}__${ref.repo}__${ref.number}.json`);
export async function pbiAcceptanceRecords(root, pbiUrl) {
  const ref = parseIssueUrl(pbiUrl), path = pbiAcceptanceLedgerPath(root, ref);
  if (!await exists(path)) return [];
  const key = await signingKey(root);
  const envelope = await readJson(path);
  if (!equal(envelope.signature, sign(key, envelope.records))) throw new Error('PBI acceptance ledger signature invalid');
  return envelope.records.map(raw => {
    const record = pbiAcceptanceRecordSchema.parse(raw);
    const { signature, ...body } = raw;
    if (record.pbiUrl !== ref.url || !equal(signature, sign(key, body))) throw new Error('PBI acceptance signature invalid');
    return record;
  });
}

// Runs only from the trusted human CLI. There is no --reviewer option; two aliases of one OS account count as one.
export async function recordPbiAcceptance({ root, pbiUrl, evidenceDigest, decision = 'APPROVE', identityProvider = localHumanIdentity }) {
  const ref = parseIssueUrl(pbiUrl);
  if (!['APPROVE', 'REVOKE', 'REQUEST_CHANGES'].includes(decision)) throw new Error('Invalid PBI acceptance decision');
  if (!/^[0-9a-f]{64}$/.test(evidenceDigest ?? '')) throw new Error('PBI acceptance requires the sha256 Evidence digest shown by harness:pbi-status');
  const identity = await identityProvider();
  if (identity?.kind !== 'human' || !identity.id || !identity.source) throw new Error('Authenticated human identity required');
  const key = await signingKey(root, true);
  const records = await pbiAcceptanceRecords(root, ref.url);
  const body = { id: randomUUID(), purpose: 'pbi-acceptance', pbiUrl: ref.url, reviewer: identity.id, kind: 'human', identitySource: identity.source,
    decision, decidedAt: new Date().toISOString(), evidenceDigest };
  const record = pbiAcceptanceRecordSchema.parse({ ...body, signature: sign(key, body) });
  records.push(record);
  await mkdir(join(root, '.harness/state/human/pbi-acceptance'), { recursive: true, mode: 0o700 });
  await json(pbiAcceptanceLedgerPath(root, ref), { records, signature: sign(key, records) });
  return record;
}
