import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExistingSchema } from './api-schema-reader.mjs';
import { diffContract } from './api-schema-diff.mjs';
import { git } from './workspace.mjs';
// api-contract verifier: the OpenAPI Source of Truth must be valid OpenAPI 3.1 and must not break the base branch's contract.
// Conformance of the Rails implementation and the frontend clients is added once endpoints exist.
const candidates = ['openapi.yaml', 'openapi.yml', 'openapi.json'].map(file => `packages/api-schema/${file}`);

async function readBase(root, base) {
  const directory = await mkdtemp(join(tmpdir(), 'sonomama-api-contract-'));
  try {
    await git(root, ['rev-parse', '--verify', `${base}^{commit}`]);
    for (const path of candidates) {
      const shown = await git(root, ['show', `${base}:${path}`], true);
      if (!shown.ok) continue;
      await mkdir(join(directory, 'packages/api-schema'), { recursive: true });
      await writeFile(join(directory, path), shown.stdout);
    }
    return await readExistingSchema(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function checkApiContract({ root, base }) {
  let after;
  try { after = await readExistingSchema(root); } catch (error) { return { status: 'FAIL', errors: [error.message], breaking: [], nonBreaking: [] }; }
  if (!after) return { status: 'MISSING', errors: [], breaking: [], nonBreaking: [] };
  let before = null;
  // A base that cannot be read is reported, not silently treated as an empty contract.
  try { before = await readBase(root, base); } catch (error) { return { status: 'FAIL', errors: [`base ${base}: ${error.message}`], breaking: [], nonBreaking: [] }; }
  const { breaking, nonBreaking } = before ? diffContract(before.document, after.document) : { breaking: [], nonBreaking: [] };
  return { status: breaking.length ? 'FAIL' : 'PASS', errors: [], breaking, nonBreaking };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const base = process.env.HARNESS_BASE_REF || 'origin/main';
  const result = await checkApiContract({ root, base });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const line of result.breaking) console.error(`BREAKING ${line}`);
  for (const line of result.nonBreaking) console.log(`CHANGE ${line}`);
  console.log(`API contract (base ${base}): ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
