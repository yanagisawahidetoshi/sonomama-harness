import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExistingSchema } from './api-schema-reader.mjs';
import { externalRefs, mockHost, mockSchemaPath } from './api-mock.mjs';
// Part of the api-contract Verifier for a Schema SBI: Prism must start from the OpenAPI of the run workspace (not an approved proposal),
// and every GET it can call without inventing a path parameter or a credential must answer its first documented 2xx status with parseable JSON.
// An endpoint with a security requirement is listed as not called: sending any credential header from a Verifier is a Security Gate matter.
const require = createRequire(import.meta.url);
const prismScript = () => require.resolve('@stoplight/prism-cli/dist/index.js');
const freePort = () => new Promise((done, fail) => { const server = createServer().once('error', fail).listen(0, mockHost, () => { const { port } = server.address(); server.close(() => done(port)); }); });

function operations(document) {
  const result = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const get = item?.get;
    if (!get) continue;
    const status = Object.keys(get.responses ?? {}).filter(code => /^2\d\d$/.test(code)).sort()[0];
    if (!status) continue;
    const secured = (get.security ?? document.security ?? []).some(requirement => Object.keys(requirement).length);
    result.push({ path, status: Number(status), secured, json: Boolean(get.responses[status]?.content?.['application/json']) });
  }
  return result;
}

export async function checkApiMock({ root, timeoutMs = 30000 }) {
  const result = { status: 'FAIL', errors: [], checked: [], skipped: [] };
  let schema;
  try { schema = await readExistingSchema(root); } catch (error) { result.errors.push(error.message); return result; }
  if (schema?.path !== mockSchemaPath) { result.errors.push(`${mockSchemaPath} がありません`); return result; }
  const remote = externalRefs(schema.document);
  if (remote.length) { result.errors.push(`ローカル以外の$refを参照しています（${remote.join(', ')}）。Prismを起動しません`); return result; }
  const port = await freePort();
  const child = spawn(process.execPath, [prismScript(), 'mock', resolve(root, mockSchemaPath), '-h', mockHost, '-p', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', exited = null;
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.on('exit', code => { exited = code ?? 1; });
  const base = `http://${mockHost}:${port}`;
  try {
    for (const started = Date.now(); ; await new Promise(r => setTimeout(r, 200))) {
      if (exited !== null) { result.errors.push(`Prismが起動できません（exit ${exited}）: ${output.slice(-2000)}`); return result; }
      if (Date.now() - started > timeoutMs) { result.errors.push(`Prismが${timeoutMs}ms以内に起動しません`); return result; }
      try { await fetch(base); break; } catch { /* not listening yet */ }
    }
    for (const operation of operations(schema.document)) {
      const name = `GET ${operation.path}`;
      if (operation.path.includes('{') || operation.secured) { result.skipped.push(name); continue; }
      const response = await fetch(`${base}${operation.path}`);
      const text = await response.text();
      if (response.status !== operation.status) { result.errors.push(`${name}: ${response.status}（OpenAPIでは${operation.status}）`); continue; }
      if (operation.json) { try { JSON.parse(text); } catch { result.errors.push(`${name}: JSONではないresponse`); continue; } }
      result.checked.push(`${name} ${operation.status}`);
    }
    result.status = result.errors.length ? 'FAIL' : 'PASS';
    return result;
  } finally { child.kill(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const result = await checkApiMock({ root });
  for (const line of result.checked) console.log(`Prism Mock: ${line}`);
  for (const line of result.skipped) console.log(`Prism Mock: ${line} はpath parameterの値がない、またはsecurity要件があるため呼び出していません`);
  for (const line of result.errors) console.error(`Prism Mock: ${line}`);
  console.log(`Prism Mock check: ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
