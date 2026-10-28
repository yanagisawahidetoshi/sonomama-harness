import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExistingSchema } from './api-schema-reader.mjs';
import { diffContract } from './api-schema-diff.mjs';
import { exists } from './io.mjs';
import { git } from './workspace.mjs';
// api-contract verifier: the OpenAPI Source of Truth must be valid OpenAPI 3.1 and must not break the base branch's contract.
// Every Rails route must be defined by the contract; request / response bodies and frontend clients are not compared yet.
const candidates = ['openapi.yaml', 'openapi.yml', 'openapi.json'].map(file => `packages/api-schema/${file}`);
const railsRoutes = 'apps/api/config/routes.rb';
const routeManifest = 'apps/api/config/routes.manifest.json';
// Framework routes such as the /up health check are served by Rails itself, not by the business API the contract describes.
const frameworkControllers = /^(rails|active_storage|action_mailbox|action_cable)\//;
const methods = ['get', 'put', 'post', 'patch', 'delete'];
// Path parameters are compared by position: Rails names them :id while OpenAPI names them {lessonId}.
const contractPath = path => path.replace(/\{[^/}]+\}/g, '{}');
const railsPath = path => path.replace(/\(\.:format\)$/, '').replace(/[:*][A-Za-z_]\w*/g, '{}');

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

async function readRoutes(root) {
  if (!await exists(join(root, railsRoutes))) return null;
  let routes;
  try { routes = JSON.parse(await readFile(join(root, routeManifest), 'utf8')); }
  catch (error) { throw new Error(`${routeManifest} を読めません（apps/apiで bin/rails contract:routes を実行してcommitする）: ${error.message}`); }
  if (!Array.isArray(routes) || routes.some(route => typeof route?.verb !== 'string' || typeof route?.path !== 'string')) {
    throw new Error(`${routeManifest} はverbとpathを持つrouteの配列ではありません`);
  }
  return routes;
}

// A Rails route the contract does not define fails; an operation Rails has not implemented yet is only reported, because the contract is approved before the implementation SBI.
export function compareRoutes(document, routes) {
  const operations = new Map();
  for (const [path, item] of Object.entries(document.paths ?? {})) for (const method of methods) {
    if (item?.[method]) operations.set(`${method.toUpperCase()} ${contractPath(path)}`, `${method.toUpperCase()} ${path}`);
  }
  const contractMethods = path => [...operations.keys()].filter(key => key.endsWith(` ${path}`)).map(key => key.split(' ')[0]);
  const mismatches = [], implemented = new Set();
  for (const route of routes.filter(route => !frameworkControllers.test(route.controller ?? ''))) {
    const target = `${route.controller ?? '(no controller)'}#${route.action ?? '(no action)'}`;
    const path = railsPath(route.path);
    if (path.includes('(')) { mismatches.push(`${route.path} (${target}) has an optional segment; declare each path explicitly`); continue; }
    if (!route.verb) { mismatches.push(`${path} (${target}) accepts any HTTP method; restrict it with via:`); continue; }
    for (const verb of route.verb.split('|')) {
      const key = `${verb} ${path}`;
      if (operations.has(key)) { implemented.add(key); continue; }
      const defined = contractMethods(path);
      mismatches.push(defined.length
        ? `${key} (${target}) uses a method the contract does not define for this path (contract: ${defined.join(', ')})`
        : `${key} (${target}) is not defined in the contract`);
    }
  }
  const unimplemented = [...operations].filter(([key]) => !implemented.has(key)).map(([, operation]) => operation);
  return { mismatches, unimplemented };
}

export async function checkApiContract({ root, base }) {
  const failed = errors => ({ status: 'FAIL', errors, breaking: [], nonBreaking: [], mismatches: [], unimplemented: [] });
  let after;
  try { after = await readExistingSchema(root); } catch (error) { return failed([error.message]); }
  if (!after) return { status: 'MISSING', errors: [], breaking: [], nonBreaking: [], mismatches: [], unimplemented: [] };
  let before = null;
  // A base that cannot be read is reported, not silently treated as an empty contract.
  try { before = await readBase(root, base); } catch (error) { return failed([`base ${base}: ${error.message}`]); }
  const { breaking, nonBreaking } = before ? diffContract(before.document, after.document) : { breaking: [], nonBreaking: [] };
  let routes;
  try { routes = await readRoutes(root); } catch (error) { return { ...failed([error.message]), breaking, nonBreaking }; }
  const { mismatches, unimplemented } = routes ? compareRoutes(after.document, routes) : { mismatches: [], unimplemented: [] };
  return { status: breaking.length || mismatches.length ? 'FAIL' : 'PASS', errors: [], breaking, nonBreaking, mismatches, unimplemented };
}

// The rails verifier runs this on api-only changes, which do not select api-contract. Without an OpenAPI document every business route fails.
export async function checkRailsRoutes({ root }) {
  let schema, routes;
  try { [schema, routes] = [await readExistingSchema(root), await readRoutes(root)]; }
  catch (error) { return { status: 'FAIL', errors: [error.message], mismatches: [], unimplemented: [] }; }
  const { mismatches, unimplemented } = routes ? compareRoutes(schema?.document ?? {}, routes) : { mismatches: [], unimplemented: [] };
  return { status: mismatches.length ? 'FAIL' : 'PASS', errors: [], mismatches, unimplemented };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--routes')) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const result = await checkRailsRoutes({ root });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const line of result.mismatches) console.error(`ROUTE ${line}`);
  for (const line of result.unimplemented) console.log(`UNIMPLEMENTED ${line}`);
  console.log(`Rails routes against the API contract: ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const base = process.env.HARNESS_BASE_REF || 'origin/main';
  const result = await checkApiContract({ root, base });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const line of result.breaking) console.error(`BREAKING ${line}`);
  for (const line of result.mismatches) console.error(`ROUTE ${line}`);
  for (const line of result.nonBreaking) console.log(`CHANGE ${line}`);
  for (const line of result.unimplemented) console.log(`UNIMPLEMENTED ${line}`);
  console.log(`API contract (base ${base}): ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
