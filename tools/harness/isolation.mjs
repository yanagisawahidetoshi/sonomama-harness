import { mkdtemp, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { execute, exists } from './io.mjs';
import { isSecretPath, isSafeEnvTemplate } from './evidence-protection.mjs';
import { isComposeCommand } from './schemas.mjs';
// Untrusted application processes (verifier and security verifier commands) run only in a container that sees the workspace.
// The trusted Harness keeps credentials, the approval key and run evidence; see .ai/security-rules.md.
const dockerfile = fileURLToPath(new URL('./isolation/Dockerfile', import.meta.url));
// The complete environment of an untrusted process. Nothing is inherited from the Harness process.
export const containerEnv = { HOME: '/tmp/home', CI: 'true', LANG: 'C.UTF-8', TZ: 'UTC', XDG_CACHE_HOME: '/tmp/home/.cache', XDG_CONFIG_HOME: '/tmp/home/.config', npm_config_store_dir: '/pnpm-store' };
const pick = names => Object.fromEntries(names.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
// The docker CLI is trusted, yet it only needs to reach the daemon. Compose would otherwise interpolate the Harness environment.
// DOCKER_CONFIG replaces HOME so the CLI still finds its context (Docker Desktop) and plugins.
export const dockerCliEnv = () => ({ DOCKER_CONFIG: join(homedir(), '.docker'), ...pick(['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) });
// Harness-owned scripts (isolation: harness) parse untrusted files without executing them.
const harnessEnv = () => pick(['PATH', 'HARNESS_BASE_REF']);
// Trust state, evidence and Git metadata stay hidden even when the workspace is the repository root (harness:verify, CI).
const protectedPaths = ['.git', '.harness/state', '.harness/runs', '.harness/exports'];
// The docker error is kept for diagnosis; evidence is redacted when it is written.
const unavailable = (reason, process) => ({ status: 'FAIL', reason: `isolation unavailable: ${reason}`, processes: process ? [process] : [] });
// #246: setup (dependency install) and verification are two phases with their own time limits. A setup that fails stops before the
// verification and is SETUP_TIMEOUT or SETUP_FAILED; every verification command runs, and a failure is VERIFY_TIMEOUT or VERIFY_FAILED.
// Neither passes. Each process keeps its phase and duration, and each phase its duration, for the evidence and the log.
async function phased({ setup, commands, limits, run }) {
  const processes = [], phases = {};
  const phase = async (name, list, timeoutMs, stopOnFailure) => {
    const started = Date.now();
    let failed = null;
    for (const command of list) {
      const result = { ...await run(command, timeoutMs), phase: name };
      processes.push(result);
      if (!result.ok) { failed ??= { result, command }; if (stopOnFailure) break; }
    }
    phases[name] = { durationMs: Date.now() - started, commands: list.length };
    return failed;
  };
  const setupFailed = await phase('setup', setup, limits.setup, true);
  if (setupFailed) {
    const failure = setupFailed.result.timedOut ? 'SETUP_TIMEOUT' : 'SETUP_FAILED';
    const why = setupFailed.result.timedOut ? `exceeded ${limits.setup}ms` : 'exited non-zero';
    return { status: 'FAIL', failure, reason: `${failure}: setup command ${setupFailed.command.slice(0, 3).join(' ')} ${why}`, processes, phases: { ...phases, verify: { skipped: true } } };
  }
  await phase('verify', commands, limits.verify, false);
  const failed = processes.filter(p => p.phase === 'verify' && !p.ok);
  if (!failed.length) return { status: 'PASS', processes, phases };
  if (failed.some(p => p.timedOut)) return { status: 'FAIL', failure: 'VERIFY_TIMEOUT', reason: `VERIFY_TIMEOUT: a verification command exceeded ${limits.verify}ms`, processes, phases };
  return { status: 'FAIL', failure: 'VERIFY_FAILED', processes, phases };
}
export function describePhases({ phases } = {}) {
  if (!phases?.setup && !phases?.verify) return '';
  const seconds = p => `${(p.durationMs / 1000).toFixed(1)}s`;
  return ` [${[phases.setup?.commands ? `setup ${seconds(phases.setup)}` : null, phases.verify ? (phases.verify.skipped ? 'verify not run' : `verify ${seconds(phases.verify)}`) : null].filter(Boolean).join(', ')}]`;
}
const inside = (parent, path) => { const rel = relative(parent, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

// commands is the selection the caller made (gated commands removed); it defaults to every configured command.
// The verifier's own limits win over the configuration's; a setup limit falls back to the verification limit.
export async function runIsolated({ workspace, adapter, config, cwd, commands = adapter.commands, setup = adapter.setupCommands ?? [] }) {
  const docker = config.isolation?.docker || 'docker', timeoutMs = adapter.timeoutMs ?? config.timeoutMs;
  const limits = { setup: adapter.setupTimeoutMs ?? config.setupTimeoutMs ?? timeoutMs, verify: timeoutMs };
  const mode = adapter.isolation || 'container';
  if (mode === 'harness') return phased({ setup, commands, limits, run: ([command, ...args], limit) => execute(command, args, { cwd, timeoutMs: limit, env: harnessEnv() }) });
  // Fail closed: without a reachable daemon nothing untrusted runs, and the check cannot pass.
  const ready = await execute(docker, ['info', '--format', '{{.ServerVersion}}'], { env: dockerCliEnv(), timeoutMs: 30000 });
  if (!ready.ok) return unavailable('docker is not available', ready);
  return mode === 'compose' ? compose({ workspace, setup, commands, docker, cwd, limits, network: adapter.network !== false }) : container({ workspace, adapter, setup, commands, docker, cwd, limits });
}

async function ensureImage(docker) {
  const tag = `sonomama-harness-verifier:${createHash('sha256').update(await readFile(dockerfile)).digest('hex').slice(0, 12)}`;
  if ((await execute(docker, ['image', 'inspect', tag], { env: dockerCliEnv(), timeoutMs: 30000 })).ok) return tag;
  const built = await execute(docker, ['build', '-q', '-t', tag, dirname(dockerfile)], { env: dockerCliEnv(), timeoutMs: 600000 });
  return built.ok ? tag : null;
}
// Workspace package directories get their own node_modules volume: host-installed modules are never reused or overwritten.
async function moduleDirectories(workspace) {
  const directories = ['node_modules'];
  let patterns = [];
  try { patterns = YAML.parse(await readFile(join(workspace, 'pnpm-workspace.yaml'), 'utf8'))?.packages || []; } catch { /* single package */ }
  for (const pattern of patterns.filter(p => typeof p === 'string' && /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*(\/\*)?$/.test(p))) {
    const parent = pattern.replace(/\/\*$/, '');
    const candidates = pattern.endsWith('/*') ? (await readdir(join(workspace, parent), { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).map(e => `${parent}/${e.name}`) : [parent];
    for (const path of candidates) if (await exists(join(workspace, path, 'package.json'))) directories.push(`${path}/node_modules`);
  }
  return [...new Set(directories)];
}
async function secretPaths(workspace, directory = '') {
  const found = [];
  for (const entry of await readdir(join(workspace, directory), { withFileTypes: true }).catch(() => [])) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.name === 'node_modules' || protectedPaths.includes(path) || entry.isSymbolicLink()) continue;
    if (isSecretPath(path)) {
      if (entry.isDirectory() || !isSafeEnvTemplate(path, await readFile(join(workspace, path), 'utf8'))) found.push(path);
    } else if (entry.isDirectory()) found.push(...await secretPaths(workspace, path));
  }
  return found;
}

// The finally below removes the container, but not when the Harness process is killed. The container then stops by itself once
// every command could have used its whole limit (each command has its own), and --rm removes it with its volumes.
const lifetimeSeconds = (setup, commands, limits) => Math.ceil((setup.length * limits.setup + commands.length * limits.verify + 60000 + 300000) / 1000);
async function container({ workspace, adapter, setup, commands, docker, cwd, limits }) {
  if (/[,=]/.test(workspace) || !inside(workspace, cwd)) return unavailable('workspace path cannot be mounted');
  const image = await ensureImage(docker);
  if (!image) return unavailable('verifier image could not be built');
  const temp = await mkdtemp(join(tmpdir(), 'sonomama-isolation-'));
  const name = `sonomama-verifier-${randomUUID()}`;
  try {
    const empty = join(temp, 'empty');
    await writeFile(empty, '');
    const masks = [];
    for (const path of [...protectedPaths, ...await secretPaths(workspace)]) {
      const info = await lstat(join(workspace, path)).catch(() => null);
      if (!info) continue;
      masks.push('--mount', info.isDirectory() ? `type=tmpfs,dst=/workspace/${path}` : `type=bind,src=${empty},dst=/workspace/${path},readonly`);
    }
    const volumes = [...(await moduleDirectories(workspace)).map(path => `/workspace/${path}`), '/pnpm-store'];
    const user = `${process.getuid()}:${process.getgid()}`;
    const started = await execute(docker, ['run', '-d', '--rm', '--name', name, '--network', adapter.network ? 'bridge' : 'none', '--user', user,
      // CHOWN and DAC_READ_SEARCH (to reach volumes under a 0700 workspace) are only usable by the root setup exec below;
      // the verifier user has no capabilities and cannot gain any.
      '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_READ_SEARCH', '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '4096', '--tmpfs', '/tmp:rw,exec,mode=1777',
      ...Object.entries(containerEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      '--mount', `type=bind,src=${workspace},dst=/workspace`, ...masks, ...volumes.flatMap(dst => ['--mount', `type=volume,dst=${dst}`]),
      '--workdir', '/workspace', image, 'sleep', String(lifetimeSeconds(setup, commands, limits))], { env: dockerCliEnv(), timeoutMs: 120000 });
    if (!started.ok) return unavailable('container could not be started', started);
    const prepared = await execute(docker, ['exec', '-u', '0', name, 'chown', user, ...volumes], { env: dockerCliEnv(), timeoutMs: 60000 });
    if (!prepared.ok) return unavailable('container volumes could not be prepared', prepared);
    const workdir = ['/workspace', relative(workspace, cwd)].filter(Boolean).join('/');
    return await phased({ setup, commands, limits, run: (command, limit) => execute(docker, ['exec', '-w', workdir, name, ...command], { env: dockerCliEnv(), timeoutMs: limit }) });
  } finally {
    await execute(docker, ['rm', '-f', '-v', name], { env: dockerCliEnv(), timeoutMs: 60000 });
    await rm(temp, { recursive: true, force: true });
  }
}

// Compose verifiers cannot run nested without the Docker socket. The trusted Harness starts Compose itself after
// checking that the workspace Compose file (which an Agent may edit) cannot reach the host, and without the Harness environment.
const topKeys = new Set(['name', 'services', 'volumes', 'networks']);
const serviceKeys = new Set(['build', 'image', 'command', 'entrypoint', 'depends_on', 'environment', 'healthcheck', 'networks', 'ports', 'volumes', 'working_dir', 'restart', 'tty', 'stdin_open', 'user', 'init']);
export function validateCompose(workspace, file, text) {
  const model = YAML.parse(text) || {};
  const base = dirname(file);
  const bad = message => { throw new Error(message); };
  const hostPath = (source, what) => {
    if (typeof source !== 'string' || source.startsWith('~')) bad(`${what} must be a path inside the workspace`);
    const path = resolve(base, source);
    const rel = relative(workspace, path);
    if (!inside(workspace, path) || rel === '' || protectedPaths.some(p => rel === p || rel.startsWith(`${p}/`))) bad(`${what} must be a workspace subdirectory outside Harness state`);
  };
  const strings = (value, allowInterpolation, at) => {
    if (typeof value === 'string') { if (value.replaceAll('$$', '').includes('$') && !allowInterpolation) bad(`interpolation is only allowed in environment values: ${at}`); }
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { strings(k, false, at); strings(v, allowInterpolation, `${at}.${k}`); }
  };
  if (typeof model !== 'object' || Array.isArray(model)) bad('invalid Compose file');
  for (const key of Object.keys(model)) if (!topKeys.has(key)) bad(`top-level ${key} is not permitted`);
  for (const key of ['volumes', 'networks']) for (const [id, value] of Object.entries(model[key] || {})) if (value && Object.keys(value).length) bad(`${key}.${id} options are not permitted`);
  for (const [id, service] of Object.entries(model.services || {})) {
    for (const [key, value] of Object.entries(service || {})) {
      if (!serviceKeys.has(key)) bad(`services.${id}.${key} is not permitted`);
      if (key !== 'build') strings(value, key === 'environment', `services.${id}.${key}`);
    }
    if (service.build !== undefined) {
      const build = typeof service.build === 'string' ? { context: service.build } : service.build;
      if (Object.keys(build).some(k => !['context', 'dockerfile', 'cache_from', 'cache_to'].includes(k))) bad(`services.${id}.build options are not permitted`);
      strings({ context: build.context, dockerfile: build.dockerfile }, false, `services.${id}.build`);
      hostPath(build.context, `services.${id}.build.context`);
      // The BuildKit cache location is a host path, so only the Harness (CI) may choose it; the default stays inside the project.
      for (const key of ['cache_from', 'cache_to']) for (const entry of build[key] || []) {
        if (typeof entry !== 'string' || !new RegExp(`^\\$\\{HARNESS_BUILD_CACHE_${key === 'cache_from' ? 'FROM' : 'TO'}(?::-type=(?:inline|local,src=[A-Za-z0-9._-]+))?\\}$`).test(entry)) bad(`services.${id}.build.${key} must be the Harness build cache setting`);
      }
    }
    for (const volume of service.volumes || []) {
      const source = typeof volume === 'string' ? (volume.includes(':') ? volume.split(':')[0] : null) : volume.source;
      const bind = typeof volume === 'string' ? source !== null && /^[./~]/.test(source) : volume.type === 'bind';
      if (typeof volume === 'object' && !['volume', 'bind'].includes(volume.type)) bad(`services.${id}.volumes type is not permitted`);
      if (bind) hostPath(source, `services.${id}.volumes`);
    }
    for (const port of service.ports || []) if (!(typeof port === 'string' ? port.startsWith('127.0.0.1:') : port.host_ip === '127.0.0.1')) bad(`services.${id}.ports must publish on 127.0.0.1 only`);
  }
}
// Loaded after the workspace Compose file, so it wins: every service built from the workspace runs as the host user, whatever the file says.
// HOME points at the container /tmp because the host uid has no home there. Pulled images (postgres) keep the user their image chose.
// Without network (ADR-0005), every network the services join becomes internal: they reach each other (Rails ↔ DB) but no outside host.
// Image builds use the builder's network, not these, so dependencies are still installed at build time.
export function composeOverride(text, { network = true } = {}) {
  const model = YAML.parse(text) || {};
  const services = Object.entries(model.services || {}).filter(([, service]) => service?.build !== undefined);
  const user = `${process.getuid()}:${process.getgid()}`;
  const networks = network ? {} : { networks: Object.fromEntries(['default', ...Object.keys(model.networks || {})].map(id => [id, { internal: true }])) };
  return YAML.stringify({ services: Object.fromEntries(services.map(([id]) => [id, { user, environment: { HOME: '/tmp' } }])), ...networks });
}
async function compose({ workspace, setup, commands, docker, cwd, limits, network }) {
  const temp = await mkdtemp(join(tmpdir(), 'sonomama-isolation-'));
  try {
    const empty = join(temp, 'empty');
    await writeFile(empty, '');
    const overrides = new Map();
    for (const [, , , file] of [...setup, ...commands].filter(isComposeCommand)) {
      const path = resolve(cwd, file);
      try {
        if (!inside(workspace, path)) throw new Error('Compose file must be inside the workspace');
        const text = await readFile(path, 'utf8');
        validateCompose(workspace, path, text);
        if (!overrides.has(file)) {
          const override = join(temp, `${overrides.size}-harness-override.yaml`);
          await writeFile(override, composeOverride(text, { network }));
          overrides.set(file, override);
        }
      } catch (error) { return unavailable(`Compose file rejected: ${error.message}`); }
    }
    // An empty --env-file keeps a workspace .env out of interpolation.
    // Harness scripts in the list (schema-checked) run on the host like isolation: harness.
    const run = (command, timeoutMs) => {
      const [name, sub, ...args] = command;
      const files = isComposeCommand(command) ? [args[0], args[1], '-f', overrides.get(args[1])] : [];
      return isComposeCommand(command) ? execute(docker, [sub, '--env-file', empty, ...files, ...args.slice(2)], { cwd, timeoutMs, env: { ...dockerCliEnv(), ...pick(['HARNESS_BUILD_CACHE_FROM', 'HARNESS_BUILD_CACHE_TO']) } })
        : execute(name, [sub, ...args], { cwd, timeoutMs, env: harnessEnv() });
    };
    return await phased({ setup, commands, limits, run });
  } finally { await rm(temp, { recursive: true, force: true }); }
}
