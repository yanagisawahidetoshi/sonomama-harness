import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update } from './test-fixture.mjs';
import { check } from './check.mjs';
import { acceptancePath, withAcceptance } from './acceptance-registry.mjs';
import { assertWritablePath } from './workspace.mjs';
import { readJson } from './io.mjs';

// The Trusted Acceptance of an SBI Issue is registered in its own file, so a run and the CI rebuild of its SBI read only that Issue's registration.
const registration = (number, overrides = {}) => ({ version: 1, sbiIssue: number,
  verifiers: [{ id: `issue-${number}-acceptance`, trustedScript: `.harness/verification/issue-${number}.mjs`, planned: ['ホーム見出し'], acceptanceIds: ['AC-1', 'AC-2'] }], ...overrides });
const register = async (root, number, value = registration(number), file = acceptancePath(number)) => {
  await mkdir(join(root, '.harness/verification'), { recursive: true });
  await writeFile(join(root, `.harness/verification/issue-${number}.mjs`), 'console.log(JSON.stringify({acceptance:["AC-1","AC-2"]}));');
  await mkdir(join(root, '.harness/acceptance'), { recursive: true });
  await writeFile(join(root, file), JSON.stringify(value));
};
const harnessConfig = root => readJson(join(root, '.harness/config/harness.json'));
const merged = async (root, number) => (await check(root, undefined, undefined, { sbiIssue: number })).config;

describe('Trusted Acceptance registry of SBI Issues', () => {
  describe('given .harness/acceptance/sbi-7.json registered by a human', () => {
    it('when the configuration for Issue #7 is read then its acceptance verifiers are added with sbiIssue 7', () => fixture(async root => {
      await register(root, 7);
      const added = (await merged(root, 7)).verifiers.find(v => v.id === 'issue-7-acceptance');
      assert.deepEqual([added.trust, added.sbiIssue, added.trustedScript, added.acceptanceIds, added.directory, added.commands], ['acceptance', 7, '.harness/verification/issue-7.mjs', ['AC-1', 'AC-2'], '.', []]);
    }));
    it('when another Issue registers its Trusted Acceptance then the configuration for Issue #7 stays exactly the same', () => fixture(async root => {
      await register(root, 7);
      const before = await merged(root, 7);
      await register(root, 8);
      assert.deepEqual(await merged(root, 7), before);
      assert.equal((await merged(root, 7)).verifiers.some(v => v.sbiIssue === 8), false);
    }));
    it('when the configuration is read without an Issue then no SBI Issue registration is added', () => fixture(async root => {
      await register(root, 7);
      assert.equal((await check(root)).config.verifiers.some(v => v.sbiIssue !== undefined), false);
    }));
  });
  describe('given a registration that cannot be trusted', () => {
    it('when the Issue has no registration file then nothing is added, so the run reports it as not registered', () => fixture(async root => {
      assert.deepEqual((await merged(root, 7)).verifiers, (await check(root)).config.verifiers);
    }));
    it('when sbi-7.json says it belongs to Issue #8 then fails', () => fixture(async root => {
      await register(root, 7, registration(8));
      await assert.rejects(merged(root, 7), /sbi-7\.json.*#8|#8.*sbi-7\.json/);
    }));
    it('when the registration has a key the schema does not know then fails', () => fixture(async root => {
      await register(root, 7, { ...registration(7), owner: 'someone' });
      await assert.rejects(merged(root, 7), /sbi-7\.json/);
    }));
    it('when a registration has no acceptance ID then fails', () => fixture(async root => {
      await register(root, 7, registration(7, { verifiers: [{ ...registration(7).verifiers[0], acceptanceIds: [] }] }));
      await assert.rejects(merged(root, 7), /sbi-7\.json/);
    }));
    it('when the registration reuses the ID of a verifier in harness.json then fails', () => fixture(async root => {
      await register(root, 7, registration(7, { verifiers: [{ ...registration(7).verifiers[0], id: 'admin' }] }));
      await assert.rejects(merged(root, 7), /admin/);
    }));
    it('when the script is not a protected .harness/verification script then fails', () => fixture(async root => {
      await register(root, 7, registration(7, { verifiers: [{ ...registration(7).verifiers[0], trustedScript: 'apps/admin/acceptance.mjs' }] }));
      await assert.rejects(merged(root, 7), /verification/);
    }));
    it('when harness.json still registers a verifier for an SBI Issue then fails and points to the per-Issue file', () => fixture(async root => {
      await register(root, 7);
      await update(root, '.harness/config/harness.json', c => { c.verifiers.push({ id: 'old-issue-7', trust: 'acceptance', trustedScript: '.harness/verification/issue-7.mjs', directory: '.', planned: ['x'], commands: [], acceptanceIds: ['AC-1'], sbiIssue: 7 }); });
      await assert.rejects(check(root), /\.harness\/acceptance\/sbi-7\.json/);
    }));
  });
  describe('given the agent of a run', () => {
    it('when it tries to write a registration then the path is reserved', () => {
      assert.throws(() => assertWritablePath('.harness/acceptance/sbi-7.json'), /reserved/);
    });
  });
  describe('given the CI judging a PR', () => {
    it('when the configuration is extended for the snapshots of the PR then each Issue adds only its own registration', () => fixture(async root => {
      await register(root, 7);
      await register(root, 8);
      const config = await withAcceptance(root, await harnessConfig(root), [7]);
      assert.deepEqual(config.verifiers.filter(v => v.sbiIssue).map(v => v.id), ['issue-7-acceptance']);
    }));
  });
});
