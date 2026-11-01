import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exists } from './io.mjs';
import { readExistingSchema } from './api-schema-reader.mjs';

// The mock serves the OpenAPI Source of Truth as it is. A Schema SBI changes it through a reviewed PR, so the OpenAPI on main is the
// approved contract (#164).
export const mockSchemaPath = 'packages/api-schema/openapi.yaml';
export const mockHost = '127.0.0.1';
export const mockPort = 4010;
// Resolved from the harness source, not the target root: the repository pins the Prism version.
const prismBin = fileURLToPath(new URL('../../node_modules/.bin/prism', import.meta.url));

// Prism resolves every $ref; anything but a local pointer could fetch a remote document.
export function externalRefs(value, found = []) {
  if (Array.isArray(value)) value.forEach(entry => externalRefs(entry, found));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    if (key === '$ref' && typeof entry === 'string' && !entry.startsWith('#')) found.push(entry);
    else externalRefs(entry, found);
  }
  return found;
}

export async function resolveMockContract({ root }) {
  let existing;
  try { existing = await readExistingSchema(root); }
  catch (error) { throw new Error(`${error.message}。Mock Serverを起動しません`); }
  if (existing?.path !== mockSchemaPath) throw new Error(`${mockSchemaPath} がありません。Mock Serverを起動しません`);
  const digest = createHash('sha256').update(await readFile(join(root, mockSchemaPath), 'utf8')).digest('hex');
  const remote = externalRefs(existing.document);
  if (remote.length) throw new Error(`${mockSchemaPath} がローカル以外の$refを参照しています（${remote.join(', ')}）。Mock Serverを起動しません`);
  return { schemaPath: mockSchemaPath, digest };
}

const spawnPrism = (command, args, options) => spawn(command, args, { ...options, stdio: 'inherit' });
// Static mode (examples, else values derived from the schema) is the default so responses stay stable. Proxy mode is never used.
export async function startApiMock({ root, dynamic = false, port = mockPort, spawner = spawnPrism, prism = prismBin }) {
  const contract = await resolveMockContract({ root });
  if (!await exists(prism)) throw new Error('Prismがインストールされていません。pnpm installを実行してください');
  const args = ['mock', join(root, contract.schemaPath), '-h', mockHost, '-p', String(port), ...(dynamic ? ['-d'] : [])];
  const child = spawner(prism, args, { cwd: root });
  return { ...contract, url: `http://${mockHost}:${port}`, child };
}

// Prism is ready only once it answers HTTP (any status). An exit or spawn error before that fails at once with its output,
// and a timeout names itself, so neither surfaces later as a bare "fetch failed". Prism prints its fatal reason to stdout and its usage to stderr.
export async function waitForApiMock({ url, child, timeoutMs = 30000, intervalMs = 100 }) {
  const output = { stdout: '', stderr: '' }, readers = {};
  for (const name of ['stdout', 'stderr']) { readers[name] = chunk => { output[name] = (output[name] + chunk).slice(-1000); }; child[name]?.on('data', readers[name]); }
  let exited = child.signalCode ?? (child.exitCode === null || child.exitCode === undefined ? null : `exit ${child.exitCode}`), failed = null;
  const onExit = (code, signal) => { exited = signal ?? `exit ${code}`; };
  const onError = error => { failed = error; };
  child.once('exit', onExit).once('error', onError);
  const detail = () => ['stdout', 'stderr'].filter(n => output[n].trim()).map(n => `\n[${n}] ${output[n].trim()}`).join('');
  let lastError = null;
  try {
    for (const started = Date.now(); ; await new Promise(r => setTimeout(r, intervalMs))) {
      if (failed) throw new Error(`Prismを起動できません（${failed.code ?? failed.message}）${detail()}`);
      if (exited !== null) throw new Error(`Prismがready前に終了しました（${exited}）${detail()}`);
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) throw new Error(`Prismが${timeoutMs}ms以内にreadyになりません（${url}、最後の接続エラー: ${lastError?.cause?.code ?? lastError?.message ?? 'なし'}）${detail()}`);
      try { await fetch(url, { signal: AbortSignal.timeout(Math.min(remaining, 2000)) }); return; } catch (error) { lastError = error; }
    }
  } finally {
    // Keep draining the pipes so a Prism logging every request never blocks on a full buffer.
    for (const name of ['stdout', 'stderr']) child[name]?.off('data', readers[name]).resume();
    child.off('exit', onExit).off('error', onError);
  }
}

// Resolves after the process has exited, so the next Prism never overlaps it; one that ignores SIGTERM is killed after graceMs.
export function stopApiMock(child, { graceMs = 5000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}
