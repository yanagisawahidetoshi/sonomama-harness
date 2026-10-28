import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './test-fixture.mjs';
import { check } from './check.mjs';
import { verify } from './verifier.mjs';
import { verifySecurity } from './security-enforcement.mjs';
import { configSchema } from './schemas.mjs';
import { execute } from './io.mjs';
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
const admin = (config, patch = {}) => Object.assign(config.verifiers.find(v => v.id === 'admin'), { commands: [['node', '-e', 'process.exit(0)']] }, patch);
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
});

describe('Verifier isolation with a real Docker daemon', () => {
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
