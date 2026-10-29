import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExistingSchema } from './api-schema-reader.mjs';
import { externalRefs, mockHost, mockSchemaPath } from './api-mock.mjs';
// Part of the api-contract Verifier for a Schema SBI: Prism must start from the OpenAPI of the run workspace (not an approved proposal),
// and every GET it can call without inventing a credential must answer its first documented 2xx status with parseable JSON.
// Path and required query parameters take their value from the OpenAPI (example, enum, default, then type); one that cannot be made is not called.
// An endpoint with a security requirement is called with the fixed dummy Bearer when an http bearer, oauth2 or openIdConnect scheme satisfies it,
// and listed as not called otherwise. No real credential is read or sent: Prism checks only that the header is there, and gets no environment
// beyond PATH. Prism reports a response that breaks its own schema (an example that does not match) in sl-violations, which fails the check.
// A check that requested no endpoint confirms nothing and fails.
const require = createRequire(import.meta.url);
const prismScript = () => require.resolve('@stoplight/prism-cli/dist/index.js');
// A fixed value that names itself, so it can never be taken for a token issued by an identity provider.
export const dummyBearer = 'sonomama-harness-dummy-bearer';
export const mockEnvironment = env => ({ PATH: env.PATH });
const freePort = () => new Promise((done, fail) => { const server = createServer().once('error', fail).listen(0, mockHost, () => { const { port } = server.address(); server.close(() => done(port)); }); });

const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
// Local references only; a remote $ref fails before Prism starts.
const local = (document, value) => {
  for (let seen = 0; value?.$ref?.startsWith('#/') && seen < 10; seen++) value = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], document);
  return value;
};
function sampleValue(document, parameter) {
  const schema = local(document, parameter.schema) ?? {};
  const example = parameter.example ?? Object.values(parameter.examples ?? {}).map(e => local(document, e)?.value)[0] ?? schema.example ?? schema.examples?.[0] ?? schema.enum?.[0] ?? schema.default;
  if (example !== undefined && ['string', 'number', 'boolean'].includes(typeof example)) return String(example);
  if (schema.type === 'integer' || schema.type === 'number') return String(schema.minimum ?? 1);
  if (schema.type === 'boolean') return 'true';
  if (schema.type !== 'string' || schema.pattern) return null;
  return { uuid: '00000000-0000-4000-8000-000000000000', date: '2026-01-01', 'date-time': '2026-01-01T00:00:00Z' }[schema.format] ?? (schema.format ? null : 'sample'.padEnd(schema.minLength ?? 0, 'x'));
}
// The first requirement the dummy Bearer satisfies: {} needs no header, and every scheme of the others must take a Bearer token.
function authorization(document, requirements) {
  const bearer = name => { const scheme = local(document, document.components?.securitySchemes?.[name]); return scheme?.type === 'oauth2' || scheme?.type === 'openIdConnect' || (scheme?.type === 'http' && scheme.scheme?.toLowerCase() === 'bearer'); };
  if (!requirements.length || requirements.some(r => !Object.keys(r).length)) return { headers: [] };
  return requirements.some(r => Object.keys(r).every(bearer)) ? { headers: [['Authorization', `Bearer ${dummyBearer}`]], dummy: true } : null;
}
function operations(document) {
  const result = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of methods.filter(m => item?.[m])) {
      const operation = item[method], endpoint = `${method.toUpperCase()} ${path}`;
      if (method !== 'get') { result.push({ endpoint, skip: 'GET以外はPrismへrequestしていません' }); continue; }
      const status = Object.keys(operation.responses ?? {}).filter(code => /^2\d\d$/.test(code)).sort()[0];
      if (!status) { result.push({ endpoint, skip: '2xxのresponseが記載されていません' }); continue; }
      const auth = authorization(document, operation.security ?? document.security ?? []);
      if (!auth) { result.push({ endpoint, skip: 'security要件をdummy Bearerで満たせないため（apiKey・Basic・未定義のscheme・複数schemeの同時要求）' }); continue; }
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(p => local(document, p)).filter(Boolean);
      let url = path, missing = null;
      const query = new URLSearchParams();
      for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1])) {
        const value = sampleValue(document, parameters.find(p => p.in === 'path' && p.name === name) ?? {});
        if (value === null) { missing = `path parameter ${name} の値をOpenAPIのexample・enum・型から作れないため`; break; }
        url = url.replace(`{${name}}`, encodeURIComponent(value));
      }
      for (const parameter of parameters.filter(p => p.in === 'query' && p.required)) {
        if (missing) break;
        const value = sampleValue(document, parameter);
        if (value === null) missing = `必須query parameter ${parameter.name} の値をOpenAPIのexample・enum・型から作れないため`; else query.set(parameter.name, value);
      }
      if (missing) { result.push({ endpoint, skip: missing }); continue; }
      result.push({ endpoint, url: query.size ? `${url}?${query}` : url, status: Number(status), json: Boolean(operation.responses[status]?.content?.['application/json']), ...auth });
    }
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
  const child = spawn(process.execPath, [prismScript(), 'mock', resolve(root, mockSchemaPath), '-h', mockHost, '-p', String(port)], { cwd: root, env: mockEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
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
      const name = operation.endpoint;
      if (operation.skip) { result.skipped.push({ endpoint: name, reason: operation.skip }); continue; }
      const response = await fetch(`${base}${operation.url}`, { headers: operation.headers });
      const text = await response.text();
      if (response.status !== operation.status) { result.errors.push(`${name}: ${response.status}（OpenAPIでは${operation.status}）`); continue; }
      if (operation.json) { try { JSON.parse(text); } catch { result.errors.push(`${name}: JSONではないresponse`); continue; } }
      const violations = (() => { try { return JSON.parse(response.headers.get('sl-violations') ?? '[]'); } catch { return [{ severity: 'Error', message: 'sl-violationsを読めません' }]; } })().filter(v => v.severity === 'Error');
      if (violations.length) { result.errors.push(`${name}: responseがschemaと一致しません（${violations.map(v => v.message).join(', ')}）`); continue; }
      result.checked.push(`${name} ${operation.status}${operation.dummy ? ' (dummy Bearer)' : ''}`);
    }
    if (!result.checked.length && !result.errors.length) result.errors.push('Prismへrequestしたendpointが1件もありません。呼び出せるGETがなければ想定responseを確認できません');
    result.status = result.errors.length ? 'FAIL' : 'PASS';
    return result;
  } finally { child.kill(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const result = await checkApiMock({ root });
  // The PR body of a Schema SBI lists these lines; keep the PASS / SKIP / FAIL prefixes stable.
  for (const line of result.checked) console.log(`Prism Mock: PASS ${line}`);
  for (const { endpoint, reason } of result.skipped) console.log(`Prism Mock: SKIP ${endpoint}（${reason}）`);
  for (const line of result.errors) console.error(`Prism Mock: FAIL ${line}`);
  console.log(`Prism Mock check: ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
