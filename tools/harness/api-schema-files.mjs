import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exists } from './io.mjs';

// The Planner adds the review labels only. The approval label is a projection of the signed ledger, written by the human approval CLI.
export const reviewLabels = Object.freeze(['api-schema', 'needs-api-schema-review']);
export const approvedLabel = 'api-schema-approved';
export const generatedFiles = Object.freeze(['openapi.yaml', 'summary.md']);
export const proposalFiles = Object.freeze(['openapi.yaml', 'proposal.json', 'summary.md']);
export const proposalDirectory = ref => `.harness/api-schema/${ref.number}`;
export const sha256 = text => createHash('sha256').update(text).digest('hex');

export async function readProposalMeta(root, directory) {
  try { return JSON.parse(await readFile(join(root, directory, 'proposal.json'), 'utf8')); }
  catch { return null; }
}
// Generated files are trusted only when they are byte-identical to what the Planner recorded for the same Issue.
export async function assertGenerated(root, directory, issueUrl) {
  const meta = await readProposalMeta(root, directory);
  if (!meta) throw new Error(`${directory} にPlannerが記録したproposal.jsonがありません。人間が作成・編集したファイルの可能性があります`);
  if (meta.issue?.url !== issueUrl) throw new Error(`${directory} は別のIssue（${meta.issue?.url ?? '不明'}）のProposalです`);
  for (const file of generatedFiles) {
    const text = await readFile(join(root, directory, file), 'utf8').catch(() => null);
    if (text === null || sha256(text) !== meta.files?.[file]) throw new Error(`${directory}/${file} は生成後に人間が編集した可能性があります（digest不一致）`);
  }
  return meta;
}
export async function assertReplaceable(root, directory, issueUrl) {
  if (!await exists(join(root, directory))) return;
  try { await assertGenerated(root, directory, issueUrl); }
  catch (error) { throw new Error(`${error.message}。上書きしません。内容を確認し、不要ならディレクトリを退避してから再実行してください`); }
}
// The approval digest covers every reviewed file, including the machine-readable proposal.
export async function proposalDigest(root, directory) {
  const entries = [];
  for (const file of proposalFiles) entries.push([file, sha256(await readFile(join(root, directory, file), 'utf8').catch(() => ''))]);
  return sha256(JSON.stringify(entries));
}
