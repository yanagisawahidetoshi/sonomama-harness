import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './test-fixture.mjs';
import { check } from './check.mjs';
import { verify } from './verifier.mjs';
import { verifySecurity } from './security-enforcement.mjs';
import { configSchema } from './schemas.mjs';
import { execute } from './io.mjs';
import { composeOverride } from './isolation.mjs';
import { parse as parseYaml } from 'yaml';
// Built at runtime so the literal never looks like a committed credential.
const token = 'ghp_' + 'x'.repeat(36);
const credentials = { GH_TOKEN: token, GITHUB_TOKEN: token, AWS_ACCESS_KEY_ID: 'AKIA' + 'X'.repeat(16), AWS_SECRET_ACCESS_KEY: 'aws-secret-value', ANTHROPIC_API_KEY: 'anthropic-secret-value' };
const sbi = { allowedFiles: [], acceptanceCriteria: [], requiredVerifiers: [] };

async function withCredentials(test) {
  const previous = Object.fromEntries(Object.keys(credentials).map(k => [k, process.env[k]]));
  Object.assign(process.env, credentials);
  try { return await test(); } finally {
    for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
// A docker CLI stand-in that records every invocation and its environment instead of starting containers.
async function fakeDocker(test, { infoFails = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'harness-fake-docker-'));
  try {
    const docker = join(dir, 'docker'), log = join(dir, 'calls.jsonl');
    await writeFile(docker, `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: process.env }) + '\\n');
if (args[0] === 'info' && ${infoFails}) process.exit(1);
if (args[0] === 'run') console.log('container-id');
`);
    await chmod(docker, 0o755);
    const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    return await test({ docker, calls });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
// An admin verifier without a network declaration; tests that need egress declare it explicitly.
// The stand-in commands replace the install (setup, #246) as well as the verification.
const admin = (config, patch = {}) => Object.assign(config.verifiers.find(v => v.id === 'admin'), { setupCommands: [], commands: [['node', '-e', 'process.exit(0)']], network: false }, patch);
const run = calls => calls.find(c => c.args[0] === 'run');
const mounts = call => call.args.flatMap((a, i) => call.args[i - 1] === '--mount' ? [Object.fromEntries(a.split(',').map(kv => kv.split('=')))] : []);
const envNames = call => call.args.flatMap((a, i) => call.args[i - 1] === '-e' || call.args[i - 1] === '--env' ? [a.split('=')[0]] : []);

describe('Verifier isolation', () => {
  describe('given an application verifier and a working Docker CLI', () => {
    it('when verifying then runs its commands inside a container started without network, as non-root and without capabilities', () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
      const { config } = await check(root);
      config.isolation = { docker };
      admin(config);
      const result = await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/admin/src/a.ts' }] });
      assert.equal(result.checks.find(c => c.id === 'admin').status, 'PASS');
      const started = run(await calls());
      assert.ok(started, 'container started');
      const args = started.args.join(' ');
      assert.match(args, /--network none/);
      assert.match(args, new RegExp(`--user ${process.getuid()}:${process.getgid()}`));
      assert.match(args, /--cap-drop ALL/);
      assert.match(args, /--security-opt no-new-privileges/);
      assert.match(args, /--read-only/);
      const exec = (await calls()).filter(c => c.args[0] === 'exec' && c.args.at(-3) === 'node');
      assert.equal(exec.length, 1, 'the verifier command runs through docker exec');
      assert.ok(!exec[0].args.includes('-u'), 'the verifier command runs as the container user');
    })));
    it('when verifying then bind-mounts only the workspace and never HOME or the Docker socket', () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
      const { config } = await check(root);
      config.isolation = { docker };
      admin(config);
      await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/admin/src/a.ts' }] });
      const started = run(await calls());
      assert.ok(!started.args.some(a => a === '-v' || a === '--volume' || a.startsWith('--volume=')), 'bind mounts are explicit --mount entries');
      assert.ok(!started.args.join(' ').includes('docker.sock'));
      const binds = mounts(started).filter(m => m.type === 'bind');
      assert.deepEqual(binds.filter(m => m.dst === '/workspace').map(m => m.src), [root]);
      for (const bind of binds.filter(m => m.dst !== '/workspace')) {
        assert.ok(bind.dst.startsWith('/workspace/'), 'only masks inside the workspace');
        assert.equal((await stat(bind.src)).size, 0, 'a mask is an empty file');
        assert.ok('readonly' in bind);
      }
      assert.ok(!binds.some(m => m.src === process.env.HOME));
    })));
    it('when credentials exist in the Harness environment then neither the container nor the docker CLI receives them', () => fixture(async root => fakeDocker(async ({ docker, calls }) => withCredentials(async () => {
      const { config } = await check(root);
      config.isolation = { docker };
      admin(config);
      await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/admin/src/a.ts' }] });
      const all = await calls();
      assert.ok(all.length > 0);
      for (const call of all) {
        for (const [name, value] of Object.entries(credentials)) {
          assert.ok(!call.args.join(' ').includes(value), `${name} value is not passed as an argument`);
          assert.equal(call.env[name], undefined, `${name} is not inherited by the docker CLI`);
        }
        assert.equal(call.env.HOME, undefined, 'the docker CLI does not receive HOME');
      }
      const names = envNames(run(all));
      assert.ok(names.length > 0);
      assert.ok(names.every(n => ['HOME', 'CI', 'LANG', 'TZ', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'npm_config_store_dir'].includes(n)), names.join(','));
    }))));
    it('when the workspace holds Harness trust state and evidence then masks them from the container', () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
      const { config } = await check(root);
      config.isolation = { docker };
      admin(config);
      await mkdir(join(root, '.harness/state/human'), { recursive: true });
      await writeFile(join(root, '.harness/state/human/.key'), 'approval-key');
      await mkdir(join(root, '.harness/state/api-schema'), { recursive: true });
      await writeFile(join(root, '.harness/state/api-schema/signed.json'), '{}');
      await writeFile(join(root, '.env'), 'TOKEN=value');
      await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/admin/src/a.ts' }] });
      const masked = mounts(run(await calls())).map(m => m.dst);
      for (const path of ['.harness/state', '.harness/runs', '.git', '.env']) assert.ok(masked.includes(`/workspace/${path}`), path);
    })));
    it('when the verifier declares network access then only that container joins a network', () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
      const { config } = await check(root);
      config.isolation = { docker };
      admin(config, { network: true });
      await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/admin/src/a.ts' }] });
      assert.match(run(await calls()).args.join(' '), /--network bridge/);
    })));
    it('when a gated command does not apply to the change then the container never executes it and the skip stays in evidence', () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
      const { config } = await check(root);
      config.isolation = { docker };
      const doctor = ['pnpm', 'run', 'doctor'];
      Object.assign(config.verifiers.find(v => v.id === 'expo'), { setupCommands: [], commands: [['node', '-e', 'process.exit(0)'], doctor], gatedCommands: [{ command: doctor, appliesTo: ['^apps/mobile/package\\.json$'] }] });
      const result = await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/mobile/src/app/index.tsx' }] });
      const checked = result.checks.find(c => c.id === 'expo');
      assert.equal(checked.status, 'PASS');
      assert.deepEqual(checked.skippedCommands.map(c => c.command), [doctor.join(' ')]);
      const executed = (await calls()).filter(c => c.args[0] === 'exec' && !c.args.includes('-u'));
      assert.equal(executed.length, 1);
      assert.ok(!executed.some(c => c.args.slice(-3).join(' ') === doctor.join(' ')), 'the gated command is not run');
    })));
    it('when a security verifier runs then it uses the same isolated container', () => fakeDocker(async ({ docker, calls }) => {
      const workspace = await mkdtemp(join(tmpdir(), 'harness-isolated-security-'));
      try {
        const config = { timeoutMs: 10000, isolation: { docker }, securityVerifiers: [{ id: 'rls', directory: '.', commands: [['node', '-e', 'process.exit(0)']] }] };
        const result = await verifySecurity({ workspace, sbi, assessment: { requiredVerifiers: ['rls'] }, policy: { verifiers: [] }, config, headSha: 'x' });
        assert.equal(result.checks.find(c => c.id === 'rls').status, 'PASS');
        assert.match(run(await calls()).args.join(' '), /--network none/);
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }));
  });
  describe('given the Harness process may die before it removes the verifier container', () => {
    const lifetime = call => call.args.at(-2) === 'sleep' ? call.args.at(-1) : undefined;
    it('when the container is started then Docker removes it and its volumes as soon as it stops', () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
      const { config } = await check(root);
      config.isolation = { docker };
      admin(config);
      await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/admin/src/a.ts' }] });
      assert.ok(run(await calls()).args.includes('--rm'));
    })));
    it('when the container is started then it stops by itself only after every setup and verification command could use its whole limit', () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
      const { config } = await check(root);
      config.isolation = { docker };
      const ok = ['node', '-e', 'process.exit(0)'];
      admin(config, { setupCommands: [ok, ok], commands: [ok, ok, ok], setupTimeoutMs: 600000, timeoutMs: 900000 });
      await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/admin/src/a.ts' }] });
      const seconds = lifetime(run(await calls()));
      assert.match(seconds ?? '', /^\d+$/, 'the container sleeps for a finite number of seconds instead of forever');
      const commandsMs = 2 * 600000 + 3 * 900000;
      assert.ok(Number(seconds) * 1000 > commandsMs, 'each command has its own limit, so the lifetime covers all of them back to back');
      assert.ok(Number(seconds) * 1000 <= commandsMs + 15 * 60000, 'an orphaned container does not outlive the run by more than a few minutes');
    })));
  });

  describe('given Docker is unavailable', () => {
    for (const [name, setup] of [['the docker CLI is not installed', () => ({ docker: '/nonexistent/docker' })], ['the Docker daemon is unreachable', null]]) {
      it(`when ${name} then the application verifier fails closed without running its commands`, () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
        const { config } = await check(root);
        config.isolation = setup ? setup() : { docker };
        admin(config);
        const result = await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/admin/src/a.ts' }] });
        const checked = result.checks.find(c => c.id === 'admin');
        assert.equal(checked.status, 'FAIL');
        assert.match(checked.reason, /^isolation unavailable/);
        assert.equal(checked.required, true);
        assert.equal(result.status, 'FAIL');
        assert.ok(!(await calls()).some(c => c.args[0] === 'exec'));
      }, { infoFails: !setup })));
    }
    it('when a required security verifier cannot be isolated then it fails instead of NOT_CONFIGURED or PASS', async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'harness-isolated-security-'));
      try {
        const config = { timeoutMs: 10000, isolation: { docker: '/nonexistent/docker' }, securityVerifiers: [{ id: 'rls', directory: '.', commands: [['node', '-e', 'process.exit(0)']] }] };
        const result = await verifySecurity({ workspace, sbi, assessment: { requiredVerifiers: ['rls'] }, policy: { verifiers: [] }, config, headSha: 'x' });
        const checked = result.checks.find(c => c.id === 'rls');
        assert.equal(checked.status, 'FAIL');
        assert.match(checked.reason, /^isolation unavailable/);
        assert.equal(result.status, 'FAIL');
      } finally { await rm(workspace, { recursive: true, force: true }); }
    });
  });

  describe('given a Compose based verifier', () => {
    const compose = (config, file) => Object.assign(config.verifiers.find(v => v.id === 'rails'), { commands: [['docker', 'compose', '-f', `../../${file}`, 'run', '--rm', 'api', 'true']] });
    for (const [name, yaml] of [
      ['mounts the Docker socket', 'services:\n  api:\n    image: ruby\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n'],
      ['mounts a host path outside the workspace', 'services:\n  api:\n    image: ruby\n    volumes:\n      - ~/.ssh:/root/.ssh\n'],
      ['mounts the Harness trust state', 'services:\n  api:\n    image: ruby\n    volumes:\n      - ./.harness/state:/state\n'],
      ['reads a host env file', 'services:\n  api:\n    image: ruby\n    env_file: ~/.aws/credentials\n'],
      ['interpolates the host environment outside environment values', 'services:\n  api:\n    image: ruby\n    volumes:\n      - ${HOME}:/home\n'],
      ['runs privileged', 'services:\n  api:\n    image: ruby\n    privileged: true\n'],
      ['shares the host network', 'services:\n  api:\n    image: ruby\n    network_mode: host\n'],
      ['exports the build cache to a host path of its own choosing', 'services:\n  api:\n    build:\n      context: ./apps/api\n      cache_to: ["type=local,dest=/home/runner/.ssh"]\n'],
      ['defaults the build cache to a path outside the workspace', 'services:\n  api:\n    build:\n      context: ./apps/api\n      cache_from: ["${HARNESS_BUILD_CACHE_FROM:-type=local,src=/etc}"]\n'],
    ]) {
      it(`when the Compose file ${name} then fails closed before starting Compose`, () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
        const { config } = await check(root);
        config.isolation = { docker };
        await writeFile(join(root, 'compose.yaml'), yaml);
        compose(config, 'compose.yaml');
        const result = await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/api/app.rb' }] });
        const checked = result.checks.find(c => c.id === 'rails');
        assert.equal(checked.status, 'FAIL');
        assert.match(checked.reason, /^isolation unavailable/);
        assert.ok(!(await calls()).some(c => c.args[0] === 'compose'));
      })));
    }
    it('when the repository Compose file is used then runs Compose without the Harness credentials', () => fixture(async root => fakeDocker(async ({ docker, calls }) => withCredentials(async () => {
      const { config } = await check(root);
      config.isolation = { docker };
      await writeFile(join(root, 'compose.yaml'), await readFile(new URL('../../compose.yaml', import.meta.url), 'utf8'));
      compose(config, 'compose.yaml');
      const result = await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/api/app.rb' }] });
      assert.equal(result.checks.find(c => c.id === 'rails').status, 'PASS');
      const composed = (await calls()).filter(c => c.args[0] === 'compose');
      assert.equal(composed.length, 1);
      for (const name of Object.keys(credentials)) assert.equal(composed[0].env[name], undefined, name);
      assert.equal(composed[0].env.HOME, undefined);
    }))));
    it('when the Harness sets the BuildKit cache location then Compose receives only that trusted setting', () => fixture(async root => fakeDocker(async ({ docker, calls }) => withCredentials(async () => {
      const previous = process.env.HARNESS_BUILD_CACHE_FROM;
      process.env.HARNESS_BUILD_CACHE_FROM = 'type=local,src=/ci/cache';
      try {
        const { config } = await check(root);
        config.isolation = { docker };
        await writeFile(join(root, 'compose.yaml'), await readFile(new URL('../../compose.yaml', import.meta.url), 'utf8'));
        compose(config, 'compose.yaml');
        const result = await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/api/app.rb' }] });
        assert.equal(result.checks.find(c => c.id === 'rails').status, 'PASS');
        const composed = (await calls()).find(c => c.args[0] === 'compose');
        assert.equal(composed.env.HARNESS_BUILD_CACHE_FROM, 'type=local,src=/ci/cache');
        assert.equal(composed.env.GH_TOKEN, undefined);
      } finally { if (previous === undefined) delete process.env.HARNESS_BUILD_CACHE_FROM; else process.env.HARNESS_BUILD_CACHE_FROM = previous; }
    }))));
  });

  // #134: a service built from the workspace runs as the host user whatever the workspace Compose file says; pulled images keep their own user.
  describe('given the services of a Compose file', () => {
    const user = `${process.getuid()}:${process.getgid()}`;
    it('when the Harness override is made then every service built from the workspace runs as the host user with a writable HOME', () => {
      const override = parseYaml(composeOverride(readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8')));
      assert.deepEqual(override.services.api, { user, environment: { HOME: '/tmp' } });
    });
    it('when a service only pulls an image then the override leaves its user to the image', () => {
      const override = parseYaml(composeOverride(readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8')));
      assert.equal(override.services.db, undefined);
    });
    // ADR-0005: PR code runs without a network. Without network the services still reach each other (Rails ↔ DB) but nothing outside.
    it('when the verifier has no network then the override makes the default network and every declared network internal', () => {
      const override = parseYaml(composeOverride('services:\n  api:\n    build: ./apps/api\n    networks: [back]\n  db:\n    image: postgres\nnetworks:\n  back:\n', { network: false }));
      assert.deepEqual(override.networks, { default: { internal: true }, back: { internal: true } });
    });
    it('when the verifier declares network access then the override leaves the networks as they are', () => {
      assert.equal(parseYaml(composeOverride(readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8'), { network: true })).networks, undefined);
    });
    it('when the workspace Compose file asks for root then the override still names the host user', () => {
      const override = parseYaml(composeOverride('services:\n  api:\n    build: ./apps/api\n    user: root\n'));
      assert.equal(override.services.api.user, user);
      assert.notEqual(override.services.api.user.split(':')[0], '0');
    });
  });
  describe('given a Compose based verifier run through the Harness override', () => {
    it('when verifying then every Compose command loads the workspace file first and the Harness override after it', () => fixture(async root => fakeDocker(async ({ docker, calls }) => {
      const { config } = await check(root);
      config.isolation = { docker };
      await writeFile(join(root, 'compose.yaml'), await readFile(new URL('../../compose.yaml', import.meta.url), 'utf8'));
      Object.assign(config.verifiers.find(v => v.id === 'rails'), { commands: [['docker', 'compose', '-f', '../../compose.yaml', 'build', 'api'], ['docker', 'compose', '-f', '../../compose.yaml', 'run', '--rm', 'api', 'true']] });
      const result = await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/api/app.rb' }] });
      assert.equal(result.checks.find(c => c.id === 'rails').status, 'PASS');
      const composed = (await calls()).filter(c => c.args[0] === 'compose');
      assert.equal(composed.length, 2);
      for (const call of composed) {
        const files = call.args.flatMap((a, i) => call.args[i - 1] === '-f' ? [a] : []);
        assert.equal(files.length, 2, call.args.join(' '));
        assert.equal(files[0], '../../compose.yaml');
        assert.match(files[1], /harness-override\.yaml$/);
      }
    })));
  });

  describe('given a Compose based verifier that also runs a Harness script', () => {
    it('when verifying then runs the Harness script on the host without credentials and Compose only after checking the file', () => fixture(async root => fakeDocker(async ({ docker, calls }) => withCredentials(async () => {
      const { config } = await check(root);
      config.isolation = { docker };
      await writeFile(join(root, 'compose.yaml'), await readFile(new URL('../../compose.yaml', import.meta.url), 'utf8'));
      await writeFile(join(root, 'tools/harness/probe-env.mjs'), `if (${JSON.stringify(Object.keys(credentials))}.some(k => process.env[k]) || process.env.HOME) process.exit(1);`);
      Object.assign(config.verifiers.find(v => v.id === 'rails'), { commands: [['node', '../../tools/harness/probe-env.mjs'], ['docker', 'compose', '-f', '../../compose.yaml', 'run', '--rm', 'api', 'true']] });
      const result = await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/api/app.rb' }] });
      assert.equal(result.checks.find(c => c.id === 'rails').status, 'PASS', JSON.stringify(result.checks.find(c => c.id === 'rails').processes));
      assert.equal((await calls()).filter(c => c.args[0] === 'compose').length, 1);
    }))));
    it('when a security verifier uses Compose then checks the Compose file before starting it', () => fakeDocker(async ({ docker, calls }) => {
      const workspace = await mkdtemp(join(tmpdir(), 'harness-isolated-security-'));
      try {
        await writeFile(join(workspace, 'compose.yaml'), 'services:\n  api:\n    image: ruby\n    privileged: true\n');
        const config = { timeoutMs: 10000, isolation: { docker }, securityVerifiers: [{ id: 'migration', directory: '.', isolation: 'compose', network: true, commands: [['docker', 'compose', '-f', 'compose.yaml', 'run', 'api']] }] };
        const result = await verifySecurity({ workspace, sbi, assessment: { requiredVerifiers: ['migration'] }, policy: { verifiers: [] }, config, headSha: 'x' });
        const checked = result.checks.find(c => c.id === 'migration');
        assert.equal(checked.status, 'FAIL');
        assert.match(checked.reason, /^isolation unavailable: Compose file rejected/);
        assert.ok(!(await calls()).some(c => c.args[0] === 'compose'));
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }));
  });

  describe('given the verifier configuration', () => {
    const base = async () => JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
    it('when a verifier omits isolation then defaults to a container without network', async () => {
      const config = configSchema.parse(await base());
      const admin = config.verifiers.find(v => v.id === 'admin');
      assert.equal(config.verifiers.find(v => v.id === 'api-contract').isolation, 'harness');
      assert.equal(configSchema.parse({ ...await base(), verifiers: [{ ...admin, network: undefined, isolation: undefined }] }).verifiers[0].isolation, 'container');
      assert.equal(configSchema.parse({ ...await base(), verifiers: [{ ...admin, network: undefined, isolation: undefined }] }).verifiers[0].network, false);
    });
    it('when harness isolation names a command outside tools/harness then rejects the configuration', async () => {
      const config = await base();
      config.verifiers.find(v => v.id === 'api-contract').commands = [['pnpm', 'run', 'test']];
      assert.throws(() => configSchema.parse(config));
    });
    it('when compose isolation runs a command other than docker compose then rejects the configuration', async () => {
      const config = await base();
      config.verifiers.find(v => v.id === 'rails').commands.push(['bundle', 'exec', 'rspec']);
      assert.throws(() => configSchema.parse(config));
    });
  });

  describe('given a run workspace whose node_modules is only an empty container mount point', () => {
    it('when a trusted acceptance script loads Harness modules then their dependencies resolve from the Harness installation', () => fixture(async root => {
      const workspace = join(root, '.harness/runs/r/workspace');
      await mkdir(join(root, 'node_modules/harness-dependency'), { recursive: true });
      await writeFile(join(root, 'node_modules/harness-dependency/package.json'), '{"name":"harness-dependency","type":"module","exports":"./index.js"}');
      await writeFile(join(root, 'node_modules/harness-dependency/index.js'), 'export const value = "resolved";');
      await mkdir(join(workspace, 'node_modules'), { recursive: true });
      await mkdir(join(workspace, 'tools'), { recursive: true });
      await writeFile(join(workspace, 'tools/module.mjs'), 'export { value } from "harness-dependency";');
      await writeFile(join(root, '.harness/verification/resolve.mjs'), 'const { value } = await import(new URL("tools/module.mjs", "file://" + process.argv[2] + "/").href); if (value !== "resolved") process.exit(1); console.log(JSON.stringify({ acceptance: ["R-1"] }));');
      const { config } = await check(root);
      config.verifiers.push({ id: 'resolve', trust: 'acceptance', trustedScript: '.harness/verification/resolve.mjs', directory: '.', commands: [], acceptanceIds: ['R-1'] });
      const result = await verify({ root, workspace, config, sbi: { ...sbi, acceptanceCriteria: [{ id: 'R-1', verifier: 'resolve' }] }, files: [], only: new Set(['resolve']) });
      assert.equal(result.checks.find(c => c.id === 'resolve').status, 'PASS', JSON.stringify(result.checks.find(c => c.id === 'resolve').process?.stderr));
      assert.deepEqual(result.acceptance, ['R-1']);
    }));
  });
});

describe('Verifier isolation with a real Docker daemon', () => {
  describe('given a Compose service built from the workspace whose Compose file asks for root', () => {
    it('when a Compose security verifier runs it then the command runs as the host user, not root', () => fixture(async root => {
      await mkdir(join(root, 'probe'), { recursive: true });
      await writeFile(join(root, 'probe/Dockerfile'), 'FROM node:22.23.4-bookworm-slim\n');
      await writeFile(join(root, 'compose.yaml'), 'services:\n  probe:\n    build:\n      context: ./probe\n    user: root\n');
      const config = { timeoutMs: 300000, securityVerifiers: [{ id: 'probe', directory: '.', isolation: 'compose', network: true, commands: [['docker', 'compose', '-f', 'compose.yaml', 'run', '--rm', 'probe', 'sh', '-c', 'echo "UID $(id -u) HOME $HOME"'], ['docker', 'compose', '-f', 'compose.yaml', 'down']] }] };
      const result = await verifySecurity({ workspace: root, sbi, assessment: { requiredVerifiers: ['probe'] }, policy: { verifiers: [] }, config, headSha: 'x' });
      const checked = result.checks.find(c => c.id === 'probe');
      if (!(await execute('docker', ['info'], { timeoutMs: 30000 })).ok) {
        assert.equal(checked.status, 'FAIL');
        return;
      }
      assert.equal(checked.status, 'PASS', JSON.stringify(checked.processes?.map(p => p.stderr)));
      const output = checked.processes.map(p => p.stdout).join('');
      assert.match(output, new RegExp(`UID ${process.getuid()} HOME /tmp`));
      assert.doesNotMatch(output, /UID 0\b/);
    }));
  });
  describe('given a Compose verifier without network', () => {
    it('when its service runs then it reaches the other Compose service but not the outside network', () => fixture(async root => {
      await mkdir(join(root, 'probe'), { recursive: true });
      await writeFile(join(root, 'probe/Dockerfile'), 'FROM node:22.23.4-bookworm-slim\n');
      const peer = "require('node:http').createServer((q, s) => s.end('peer')).listen(8080)";
      const probe = `const get = async url => { try { await fetch(url, { signal: AbortSignal.timeout(5000) }); return 'reached'; } catch { return 'blocked'; } };
(async () => { let inside = 'blocked'; for (let i = 0; i < 20 && inside === 'blocked'; i++) { inside = await get('http://peer:8080'); if (inside === 'blocked') await new Promise(r => setTimeout(r, 500)); }
console.log('PROBE ' + JSON.stringify({ inside, outside: await get('https://example.com') })); })();`;
      await writeFile(join(root, 'compose.yaml'), `services:\n  peer:\n    build:\n      context: ./probe\n    command: ["node", "-e", ${JSON.stringify(peer)}]\n  probe:\n    build:\n      context: ./probe\n    depends_on: [peer]\n`);
      await writeFile(join(root, 'probe.js'), probe);
      const config = { timeoutMs: 300000, securityVerifiers: [{ id: 'probe', directory: '.', isolation: 'compose', network: false, commands: [
        ['docker', 'compose', '-f', 'compose.yaml', 'build'], ['docker', 'compose', '-f', 'compose.yaml', 'run', '--rm', 'probe', 'node', '-e', probe], ['docker', 'compose', '-f', 'compose.yaml', 'down']] }] };
      const result = await verifySecurity({ workspace: root, sbi, assessment: { requiredVerifiers: ['probe'] }, policy: { verifiers: [] }, config, headSha: 'x' });
      const checked = result.checks.find(c => c.id === 'probe');
      if (!(await execute('docker', ['info'], { timeoutMs: 30000 })).ok) {
        assert.equal(checked.status, 'FAIL');
        return;
      }
      assert.equal(checked.status, 'PASS', JSON.stringify(checked.processes?.map(p => p.stderr)));
      assert.deepEqual(JSON.parse(checked.processes.map(p => p.stdout).join('').match(/PROBE (.*)/)[1]), { inside: 'reached', outside: 'blocked' });
    }));
  });
  describe('given a malicious application test in a workspace that holds Harness trust state', () => {
    it('when verifying then it cannot read credentials, the approval key, API Schema state, the host HOME or reach the network', () => fixture(async root => withCredentials(async () => {
      const outside = await mkdtemp(join(tmpdir(), 'harness-host-only-'));
      try {
        await writeFile(join(outside, 'credentials'), 'host-only');
        await mkdir(join(root, '.harness/state/human'), { recursive: true });
        await writeFile(join(root, '.harness/state/human/.key'), 'approval-key');
        await mkdir(join(root, '.harness/state/api-schema'), { recursive: true });
        await writeFile(join(root, '.harness/state/api-schema/signed.json'), '{"signature":"x"}');
        const probe = `const fs = require('node:fs'); const leaks = [];
for (const name of ${JSON.stringify(Object.keys(credentials))}) if (process.env[name]) leaks.push('env:' + name);
for (const path of ['/workspace/.harness/state/human/.key', '../../.harness/state/human/.key', '/workspace/.harness/state/api-schema/signed.json', '../../.harness/state/api-schema/signed.json', ${JSON.stringify(join(outside, 'credentials'))}, ${JSON.stringify(join(process.env.HOME || '/root', '.gitconfig'))}, '/var/run/docker.sock'])
  try { fs.readFileSync(path); leaks.push('file:' + path); } catch {}
fetch('https://example.com', { signal: AbortSignal.timeout(5000) }).then(() => leaks.push('network'), () => {}).finally(() => console.log('PROBE ' + JSON.stringify(leaks)));`;
        const { config } = await check(root);
        admin(config).commands = [['node', '-e', probe]];
        const result = await verify({ root, workspace: root, config, sbi, files: [{ path: 'apps/admin/src/a.ts' }] });
        const checked = result.checks.find(c => c.id === 'admin');
        if (!(await execute('docker', ['info'], { timeoutMs: 30000 })).ok) {
          // No Docker: the probe must never run on the host and the verifier must not pass.
          assert.equal(checked.status, 'FAIL');
          assert.match(checked.reason, /^isolation unavailable/);
          return;
        }
        assert.equal(checked.status, 'PASS', JSON.stringify(checked));
        const output = checked.processes.map(p => p.stdout).join('');
        assert.deepEqual(JSON.parse(output.match(/PROBE (.*)/)[1]), []);
        assert.equal(await readFile(join(root, '.harness/state/human/.key'), 'utf8'), 'approval-key');
      } finally { await rm(outside, { recursive: true, force: true }); }
    })));
  });
});
