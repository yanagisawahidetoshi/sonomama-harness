import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { json, exists, readJson } from './io.mjs';
import { git } from './workspace.mjs';
import { signingKey, sign, equal, localHumanIdentity } from './human-approvals.mjs';
import { apiSchemaApprovalRecordSchema } from './schemas.mjs';
import { parseIssueUrl } from './planner.mjs';
import { githubCli } from './planner-github.mjs';
import { reviewLabels, approvedLabel, proposalFiles, proposalDirectory, proposalDigest, assertGenerated, readProposalMeta, readGeneration } from './api-schema-files.mjs';

// API Schema Approval is a signed, content-addressed record outside Git and the agent workspace.
// It is separate from implementation-gate / design-approval / merge records and never substitutes for them. Labels are only a projection.
const ledgerPath = (root, ref) => join(root, '.harness/state/human/api-schema', `${ref.owner}__${ref.repo}__${ref.number}.json`);
async function records(root, ref) {
  const path = ledgerPath(root, ref);
  if (!await exists(path)) return [];
  const key = await signingKey(root);
  const envelope = await readJson(path);
  if (!equal(envelope.signature, sign(key, envelope.records))) throw new Error('API schema approval ledger signature invalid');
  return envelope.records.map(raw => {
    const record = apiSchemaApprovalRecordSchema.parse(raw);
    const { signature, ...body } = raw;
    if (record.issueUrl !== ref.url || !equal(signature, sign(key, body))) throw new Error('API schema approval signature invalid');
    return record;
  });
}
const uncommitted = async (root, directory) => (await git(root, ['status', '--porcelain', '--untracked-files=all', '--', directory])).stdout.trim();
async function committedAt(root, directory, sha) {
  for (const file of proposalFiles) {
    const shown = await git(root, ['show', `${sha}:${directory}/${file}`], true);
    if (!shown.ok || shown.stdout !== await readFile(join(root, directory, file), 'utf8').catch(() => null)) return false;
  }
  return true;
}

// Regeneration guard: each reviewer's APPROVE stays until that reviewer records REVOKE, regardless of digest, commit or working tree.
// REQUEST_CHANGES and a dirty proposal directory lower the status below but never free the proposal; only an explicit REVOKE does.
export async function unrevokedApiSchemaApprovals({ root, issueUrl }) {
  const held = new Map();
  for (const record of await records(root, parseIssueUrl(issueUrl))) {
    if (record.decision === 'APPROVE') held.set(record.reviewer, record);
    else if (record.decision === 'REVOKE') held.delete(record.reviewer);
  }
  return [...held.values()];
}

export async function apiSchemaApprovalStatus({ root, issueUrl }) {
  const ref = parseIssueUrl(issueUrl), directory = proposalDirectory(ref);
  const ledger = await records(root, ref);
  const meta = await readProposalMeta(root, directory);
  // The required count comes from the signed generation record, never from the editable proposal.json.
  const required = (await readGeneration(root, ref.url))?.required ?? 2;
  if (!meta) return { status: 'NOT_APPROVED', approvals: 0, required, proposalDigest: null, commitSha: null, reasons: [`${directory} にproposalがありません`] };
  const current = await proposalDigest(root, directory), reasons = [];
  if (!ledger.length) return { status: 'NOT_APPROVED', approvals: 0, required, proposalDigest: current, commitSha: null, reasons };
  let trusted = true;
  try { await assertGenerated(root, directory, ref.url); } catch (error) { trusted = false; reasons.push(error.message); }
  if (meta.quality?.status !== 'PASS') { trusted = false; reasons.push('API Schema Quality JudgeがPASSしていません'); }
  if (await uncommitted(root, directory)) { trusted = false; reasons.push(`${directory} に未commitの変更があります`); }
  const latest = new Map();
  for (const record of ledger) latest.set(record.reviewer, record);
  const valid = [];
  for (const record of latest.values()) {
    if (record.decision !== 'APPROVE') continue;
    if (record.proposalDigest !== current) { reasons.push(`${record.reviewer} の承認は別の内容（digest ${record.proposalDigest.slice(0, 12)}）に対するものです`); continue; }
    if (!trusted || !await committedAt(root, directory, record.commitSha)) { reasons.push(`${record.reviewer} の承認時のcommit ${record.commitSha.slice(0, 12)} と現在のProposalが一致しません`); continue; }
    valid.push(record);
  }
  return {
    status: trusted && valid.length >= required ? 'APPROVED' : 'NOT_APPROVED', approvals: trusted ? valid.length : 0, required,
    proposalDigest: current, commitSha: valid.at(-1)?.commitSha ?? null, reasons,
  };
}

async function projectLabels(ref, status, github) {
  const labels = (await github.fetchIssue(ref)).labels.map(l => l.name);
  const [wanted, unwanted] = status === 'APPROVED' ? [approvedLabel, reviewLabels[1]] : [reviewLabels[1], approvedLabel];
  await github.ensureLabels(ref, [wanted]);
  if (!labels.includes(wanted)) await github.addLabels(ref, [wanted]);
  if (labels.includes(unwanted)) await github.removeLabel(ref, unwanted);
}
// Runs only from the trusted human CLI. There is no --reviewer option; two aliases of one OS account count as one.
export async function recordApiSchemaDecision({ root, issueUrl, decision = 'APPROVE', identityProvider = localHumanIdentity, github = githubCli }) {
  const ref = parseIssueUrl(issueUrl), directory = proposalDirectory(ref);
  if (!['APPROVE', 'REVOKE', 'REQUEST_CHANGES'].includes(decision)) throw new Error('Invalid API schema decision');
  const identity = await identityProvider();
  if (identity?.kind !== 'human' || !identity.id || !identity.source) throw new Error('Authenticated human identity required');
  if (!await readProposalMeta(root, directory)) throw new Error(`No API Schema proposal for ${ref.url} at ${directory}; run node tools/harness/cli.mjs api-schema first`);
  const meta = await assertGenerated(root, directory, ref.url);
  if (meta.quality?.status !== 'PASS') throw new Error('API Schema Quality JudgeがPASSしていないProposalは承認できません');
  if (await uncommitted(root, directory)) throw new Error(`${directory} has uncommitted changes; commit the proposal before recording a decision`);
  const commitSha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const key = await signingKey(root, true);
  const ledger = await records(root, ref);
  const body = { id: randomUUID(), purpose: 'api-schema', issueUrl: ref.url, reviewer: identity.id, kind: 'human', identitySource: identity.source,
    decision, decidedAt: new Date().toISOString(), commitSha, proposalDigest: await proposalDigest(root, directory) };
  ledger.push(apiSchemaApprovalRecordSchema.parse({ ...body, signature: sign(key, body) }));
  await mkdir(join(root, '.harness/state/human/api-schema'), { recursive: true, mode: 0o700 });
  await json(ledgerPath(root, ref), { records: ledger, signature: sign(key, ledger) });
  const result = await apiSchemaApprovalStatus({ root, issueUrl: ref.url });
  try { await projectLabels(ref, result.status, github); }
  catch (error) { throw new Error(`判断は署名付き台帳に記録済みです（${result.status}）。Issueラベルへの反映に失敗しました: ${error.message}`); }
  return result;
}
