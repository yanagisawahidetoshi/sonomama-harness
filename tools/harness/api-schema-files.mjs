import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { json, exists, readJson } from './io.mjs';
import { signingKey, sign, equal } from './human-approvals.mjs';
import { apiSchemaGenerationRecordSchema } from './schemas.mjs';
import { parseIssueUrl } from './planner.mjs';

// The Planner adds the review labels only. The approval label is a projection of the signed ledger, written by the human approval CLI.
export const reviewLabels = Object.freeze(['api-schema', 'needs-api-schema-review']);
export const approvedLabel = 'api-schema-approved';
export const proposalFiles = Object.freeze(['openapi.yaml', 'proposal.json', 'summary.md']);
export const proposalDirectory = ref => `.harness/api-schema/${ref.number}`;
export const sha256 = text => createHash('sha256').update(text).digest('hex');

export async function readProposalMeta(root, directory) {
  try { return JSON.parse(await readFile(join(root, directory, 'proposal.json'), 'utf8')); }
  catch { return null; }
}
const readText = (root, directory, file) => readFile(join(root, directory, file), 'utf8').catch(() => null);
async function fileDigests(root, directory) {
  const files = {};
  for (const file of proposalFiles) files[file] = sha256(await readText(root, directory, file) ?? '');
  return files;
}
// proposal.json cannot vouch for itself. The Planner signs what it generated in local state outside Git and the agent workspace.
const generationPath = (root, ref) => join(root, '.harness/state/api-schema', `${ref.owner}__${ref.repo}__${ref.number}.json`);
export async function recordGeneration(root, ref, { runId, required }) {
  const body = { purpose: 'api-schema-generation', issueUrl: ref.url, runId, required, files: await fileDigests(root, proposalDirectory(ref)) };
  const key = await signingKey(root, true);
  await mkdir(join(root, '.harness/state/api-schema'), { recursive: true, mode: 0o700 });
  await json(generationPath(root, ref), apiSchemaGenerationRecordSchema.parse({ ...body, signature: sign(key, body) }));
}
export async function readGeneration(root, issueUrl) {
  const ref = parseIssueUrl(issueUrl), path = generationPath(root, ref);
  if (!await exists(path)) return null;
  const record = apiSchemaGenerationRecordSchema.parse(await readJson(path));
  const { signature, ...body } = record;
  if (record.issueUrl !== ref.url || !equal(signature, sign(await signingKey(root), body))) throw new Error('API schema generation record signature invalid');
  return record;
}
// Generated files are trusted only when all of them are byte-identical to what the Planner signed for the same Issue.
export async function assertGenerated(root, directory, issueUrl) {
  const meta = await readProposalMeta(root, directory);
  if (!meta) throw new Error(`${directory} にPlannerが記録したproposal.jsonがありません。人間が作成・編集したファイルの可能性があります`);
  if (meta.issue?.url !== issueUrl) throw new Error(`${directory} は別のIssue（${meta.issue?.url ?? '不明'}）のProposalです`);
  const generation = await readGeneration(root, issueUrl);
  if (!generation) throw new Error(`${directory} にこの環境のPlannerが署名した生成記録がありません。人間が作成・編集したファイルの可能性があります`);
  const current = await fileDigests(root, directory);
  for (const file of proposalFiles) {
    if (current[file] !== generation.files[file]) throw new Error(`${directory}/${file} は生成後に人間が編集した可能性があります（digest不一致）`);
  }
  return meta;
}
export async function assertReplaceable(root, directory, issueUrl) {
  if (!await exists(join(root, directory))) return;
  try { await assertGenerated(root, directory, issueUrl); }
  catch (error) { throw new Error(`${error.message}。上書きしません。内容を確認し、不要ならディレクトリを退避してから再実行してください`); }
}
// The approval digest covers every reviewed file, including the machine-readable proposal.
export const proposalDigest = async (root, directory) => sha256(JSON.stringify(Object.entries(await fileDigests(root, directory))));
