import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describePhases, runIsolated } from './isolation.mjs';
import { configSchema } from './schemas.mjs';
import { verifySecurity } from './security-enforcement.mjs';

// #246: a verifier runs its setup (dependency install) and its verification as two phases, each with its own time limit,
// so a setup that runs out of time is told apart from a verification that fails. Neither ever passes.
const config = JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
const node = code => ['node', '-e', code];
const sleep = ms => node(`setTimeout(() => {}, ${ms})`);
const touch = name => node(`require("node:fs").writeFileSync(${JSON.stringify(name)}, "")`);
const workspace = async fn => {
  const root = await mkdtemp(join(tmpdir(), 'sonomama-phases-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};
const run = (root, adapter, settings = {}) => runIsolated({ workspace: root, cwd: root, adapter: { isolation: 'harness', ...adapter }, config: { timeoutMs: 5000, ...settings } });

describe('Verifier setup and verification phases', () => {
  describe('given a verifier whose setup runs out of its time limit', () => {
    it('when run then FAILs as SETUP_TIMEOUT and never starts the verification', () => workspace(async root => {
      const result = await run(root, { setupCommands: [sleep(5000)], setupTimeoutMs: 200, commands: [touch('verified')] });
      assert.equal(result.status, 'FAIL');
      assert.equal(result.failure, 'SETUP_TIMEOUT');
      assert.match(result.reason, /setup/i);
      assert.equal(existsSync(join(root, 'verified')), false);
      assert.equal(typeof result.phases.setup.durationMs, 'number');
      assert.equal(result.phases.verify.skipped, true);
    }));
  });
  describe('given a verifier whose setup exits non-zero', () => {
    it('when run then FAILs as SETUP_FAILED and never starts the verification', () => workspace(async root => {
      const result = await run(root, { setupCommands: [node('process.exit(3)')], commands: [touch('verified')] });
      assert.equal(result.status, 'FAIL');
      assert.equal(result.failure, 'SETUP_FAILED');
      assert.equal(existsSync(join(root, 'verified')), false);
    }));
  });
  describe('given a verifier whose setup succeeds', () => {
    it('when the verification fails then FAILs as VERIFY_FAILED with the duration of both phases', () => workspace(async root => {
      const result = await run(root, { setupCommands: [node('process.exit(0)')], commands: [node('process.exit(1)')] });
      assert.equal(result.status, 'FAIL');
      assert.equal(result.failure, 'VERIFY_FAILED');
      assert.equal(typeof result.phases.setup.durationMs, 'number');
      assert.equal(typeof result.phases.verify.durationMs, 'number');
    }));
    it('when the verification runs out of its time limit then FAILs as VERIFY_TIMEOUT', () => workspace(async root => {
      const result = await run(root, { setupCommands: [node('process.exit(0)')], commands: [sleep(5000)], timeoutMs: 200 });
      assert.equal(result.status, 'FAIL');
      assert.equal(result.failure, 'VERIFY_TIMEOUT');
    }));
    it('when the verification passes then PASSes and records each process with its phase and duration', () => workspace(async root => {
      const result = await run(root, { setupCommands: [node('process.exit(0)')], commands: [node('process.exit(0)')] });
      assert.equal(result.status, 'PASS');
      assert.equal(result.failure, undefined);
      assert.deepEqual(result.processes.map(p => p.phase), ['setup', 'verify']);
      assert.ok(result.processes.every(p => typeof p.durationMs === 'number'));
    }));
  });
  describe('given separate time limits for setup and verification', () => {
    it('when the setup takes longer than the verification limit but within its own then PASSes', () => workspace(async root => {
      const result = await run(root, { setupCommands: [sleep(400)], setupTimeoutMs: 5000, commands: [node('process.exit(0)')] }, { timeoutMs: 200 });
      assert.equal(result.status, 'PASS');
    }));
    it('when the verifier sets its own verification limit then it wins over the global one', () => workspace(async root => {
      const result = await run(root, { commands: [sleep(400)], timeoutMs: 5000 }, { timeoutMs: 200 });
      assert.equal(result.status, 'PASS');
    }));
    it('when the configuration sets a global setup limit then a verifier without its own uses it', () => workspace(async root => {
      const result = await run(root, { setupCommands: [sleep(5000)], commands: [node('process.exit(0)')] }, { timeoutMs: 5000, setupTimeoutMs: 200 });
      assert.equal(result.failure, 'SETUP_TIMEOUT');
    }));
  });
  describe('given a verifier without setup commands', () => {
    it('when run then behaves as before with an empty setup phase', () => workspace(async root => {
      const result = await run(root, { commands: [node('process.exit(0)')] });
      assert.equal(result.status, 'PASS');
      assert.equal(result.phases.setup.commands, 0);
    }));
  });
  describe('given the log line of a check', () => {
    it('when phases were recorded then names each phase with its seconds', () => {
      assert.equal(describePhases({ phases: { setup: { durationMs: 139819, commands: 1 }, verify: { durationMs: 18994, commands: 3 } } }), ' [setup 139.8s, verify 19.0s]');
    });
    it('when the verification was not started then says so', () => {
      assert.equal(describePhases({ phases: { setup: { durationMs: 200, commands: 1 }, verify: { skipped: true } } }), ' [setup 0.2s, verify not run]');
    });
    it('when no phase was recorded then adds nothing', () => assert.equal(describePhases({}), ''));
  });
  describe('given a required Security Verifier whose setup runs out of time', () => {
    it('when Security is verified then the check keeps SETUP_TIMEOUT and its phases, and Security FAILs', () => workspace(async root => {
      const policy = { verifiers: [{ id: 'auth', kind: 'command' }], secretPatterns: [], forbiddenPatterns: [], piiLogPatterns: [] };
      const settings = { timeoutMs: 5000, securityVerifiers: [{ id: 'auth', directory: '.', isolation: 'harness', setupCommands: [sleep(5000)], setupTimeoutMs: 200, commands: [node('process.exit(0)')] }] };
      const evidence = await verifySecurity({ workspace: root, assessment: { requiredVerifiers: ['auth'] }, policy, config: settings, headSha: 'a'.repeat(40) });
      const check = evidence.checks.find(c => c.id === 'auth');
      assert.equal(check.status, 'FAIL');
      assert.equal(check.failure, 'SETUP_TIMEOUT');
      assert.ok(check.phases.setup);
      assert.equal(evidence.status, 'FAIL');
    }));
  });
});

describe('Verifier setup configuration', () => {
  const all = [...config.verifiers, ...config.securityVerifiers];
  describe('given the shipped harness configuration', () => {
    it('when a verifier installs dependencies then the install is its setup, not part of the verification', () => {
      for (const v of all) assert.equal(v.commands.some(c => c[0] === 'pnpm' && c[1] === 'install'), false, v.id);
      for (const id of ['admin', 'expo', 'prototype-web', 'prototype-mobile', 'admin-authn-test', 'mobile-authn-test']) {
        const v = all.find(v => v.id === id);
        assert.ok(v.setupCommands?.some(c => c[0] === 'pnpm' && c[1] === 'install'), id);
      }
    });
    it('when the setup limit is read then it is longer than the verification limit and the slowest install measured on a loaded machine (201s)', () => {
      const parsed = configSchema.parse(config);
      assert.ok(parsed.setupTimeoutMs > parsed.timeoutMs);
      assert.ok(parsed.setupTimeoutMs >= 300000);
    });
  });
  describe('given a Harness script or Compose verifier', () => {
    it('when its setup runs a command outside tools/harness then the configuration is rejected', () => {
      const broken = structuredClone(config);
      broken.securityVerifiers.push({ id: 'probe', directory: '.', isolation: 'harness', setupCommands: [['pnpm', 'install']], commands: [['node', 'tools/harness/security-specs.mjs', 'authn-test']] });
      assert.throws(() => configSchema.parse(broken));
    });
  });
});
