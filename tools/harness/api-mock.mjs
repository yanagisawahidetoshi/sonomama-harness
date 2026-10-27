import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exists } from './io.mjs';
import { parseIssueUrl } from './planner.mjs';
import { apiSchemaApprovalStatus } from './api-schema-approval.mjs';
import { proposalDirectory, sha256 } from './api-schema-files.mjs';
import { readExistingSchema } from './api-schema-reader.mjs';

// The mock serves the OpenAPI Source of Truth, and only while it is byte-identical to an approved proposal.
// Approval is judged from the signed local ledger (never the Issue label), so it works only on the PC that generated and approved the proposal.
export const mockSchemaPath = 'packages/api-schema/openapi.yaml';
export const mockHost = '127.0.0.1';
export const mockPort = 4010;
// Resolved from the harness source, not the target root: the repository pins the Prism version.
const prismBin = fileURLToPath(new URL('../../node_modules/.bin/prism', import.meta.url));

// Prism resolves every $ref; anything but a local pointer could fetch a remote document.
function externalRefs(value, found = []) {
  if (Array.isArray(value)) value.forEach(entry => externalRefs(entry, found));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string' && !entry.startsWith('#')) found.push(entry);
    else externalRefs(entry, found);
  }
  return found;
}

export async function resolveMockContract({ root, issueUrl }) {
  const ref = parseIssueUrl(issueUrl);
  const status = await apiSchemaApprovalStatus({ root, issueUrl: ref.url });
  if (status.status !== 'APPROVED') {
    throw new Error([`${ref.url} のAPI Schemaは承認されていません（${status.approvals}/${status.required}）。Mock Serverを起動しません`, ...status.reasons.map(r => `- ${r}`)].join('\n'));
  }
  const approvedText = await readFile(join(root, proposalDirectory(ref), 'openapi.yaml'), 'utf8');
  let existing;
  try { existing = await readExistingSchema(root); }
  catch (error) { throw new Error(`${error.message}。Mock Serverを起動しません`); }
  if (existing?.path !== mockSchemaPath) throw new Error(`${mockSchemaPath} がありません。承認済みの ${proposalDirectory(ref)}/openapi.yaml を整形せずにコピーしてください`);
  const digest = sha256(await readFile(join(root, mockSchemaPath), 'utf8')), approvedDigest = sha256(approvedText);
  if (digest !== approvedDigest) {
    throw new Error(`${mockSchemaPath}（digest ${digest.slice(0, 12)}）が承認済みのOpenAPI（digest ${approvedDigest.slice(0, 12)}）と一致しません。Mock Serverを起動しません`);
  }
  const remote = externalRefs(existing.document);
  if (remote.length) throw new Error(`${mockSchemaPath} がローカル以外の$refを参照しています（${remote.join(', ')}）。Mock Serverを起動しません`);
  return { schemaPath: mockSchemaPath, digest };
}

const spawnPrism = (command, args, options) => spawn(command, args, { ...options, stdio: 'inherit' });
// Static mode (examples, else values derived from the schema) is the default so responses stay stable. Proxy mode is never used.
export async function startApiMock({ root, issueUrl, dynamic = false, port = mockPort, spawner = spawnPrism, prism = prismBin }) {
  const contract = await resolveMockContract({ root, issueUrl });
  if (!await exists(prism)) throw new Error('Prismがインストールされていません。pnpm installを実行してください');
  const args = ['mock', join(root, contract.schemaPath), '-h', mockHost, '-p', String(port), ...(dynamic ? ['-d'] : [])];
  const child = spawner(prism, args, { cwd: root });
  return { ...contract, url: `http://${mockHost}:${port}`, child };
}
