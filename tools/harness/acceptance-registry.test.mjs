import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update } from './test-fixture.mjs';
import { check } from './check.mjs';
import { acceptancePath, readAcceptance, withAcceptance } from './acceptance-registry.mjs';
import { assertWritablePath, git } from './workspace.mjs';
import { readJson } from './io.mjs';
import { renderSbiBody } from './planner.mjs';
import { sbiFromIssue } from './sbi-issue.mjs';
import { snapshotFromIssue, snapshotPath, verifySbiSource } from './sbi-source.mjs';
import { loadImpact } from './impact.mjs';

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

// The CI side comes from claude/sbi-required; its helpers stay in their own block.
{
// CI side of the per-Issue registry: the Completion Judge and the SBI rebuild read .harness/acceptance/sbi-<N>.json of the Issues
// whose Run snapshots are in the PR, and nothing else.
const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
const pbi = { owner: 'acme', repo: 'app', number: 3, url: 'https://github.com/acme/app/issues/3', title: '管理画面のホーム' };
const planned = {
  id: 'SBI-001', kind: 'implementation', title: '管理画面のホーム', purpose: 'ホームを表示する',
  scope: { included: ['apps/admin ホーム画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'HOME-AC-1', description: '見出しが出る' }],
  scenarios: [{ name: '表示', given: ['管理者である'], when: ['ホームを開く'], then: ['見出しが出る'], acceptanceIds: ['HOME-AC-1'], test: 'Vitest: apps/admin/src/features/home/index.test.tsx' }],
  dependsOn: [], changeAreas: ['apps/admin'], layers: ['画面Component'], estimatedFiles: 2, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'Vitest', acceptance: 'Trusted Acceptance', e2e: '不要' },
};
const readyIssue = { number: 7, title: 'SBI-001 管理画面のホーム', body: renderSbiBody(planned, pbi), html_url: ref.url, state: 'open', labels: [{ name: 'sbi' }, { name: 'ready' }] };
const runId = '2026-10-28T00-00-00-000Z-1a2b3c4d';
const admin = 'apps/admin/src/features/home/index.ts';
const registration = (number, overrides = {}) => ({ version: 1, sbiIssue: number,
  verifiers: [{ id: `issue-${number}-acceptance`, trustedScript: `.harness/verification/issue-${number}.mjs`, planned: ['ホーム見出し'], acceptanceIds: ['HOME-AC-1'] }], ...overrides });
const register = async (root, number, value = registration(number)) => {
  await mkdir(join(root, '.harness/acceptance'), { recursive: true });
  await writeFile(join(root, acceptancePath(number)), JSON.stringify(value));
};
const harnessConfig = root => readJson(join(root, '.harness/config/harness.json'));
// main has the registrations; the PR adds a Production change with the Run snapshot of Issue #7.
async function pullRequest(root, registered = [7, 8]) {
  for (const number of registered) await register(root, number);
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', 'register Trusted Acceptance']);
  await git(root, ['branch', 'base']);
  const sbi = sbiFromIssue({ ref, issue: readyIssue, config: await withAcceptance(root, await harnessConfig(root), [7]) });
  const snapshot = snapshotFromIssue({ ref, issue: readyIssue, runId, sbi });
  await mkdir(join(root, 'apps/admin/src/features/home'), { recursive: true });
  await writeFile(join(root, admin), 'export {};\n');
  await writeFile(join(root, snapshotPath(snapshot)), JSON.stringify(snapshot));
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', `feat: home\n\nHarness-Run: ${runId}\nSBI-Issue: ${ref.url}`]);
}

describe('Trusted Acceptance registry of SBI Issues in CI', () => {
  // #194: the Issue was marked ready and left unedited, so the ready label still covers what the Run took from it.
  const readyGitHub = { fetchIssue: async () => readyIssue, issueTimeline: async () => [{ event: 'labeled', label: { name: 'ready' }, created_at: '2026-10-01T00:00:00Z' }], bodyEdits: async () => [] };
  describe('given registrations of Issue #7 and #8 on main and a PR with the Run snapshot of Issue #7', () => {
    it('when the impact is loaded then the configuration has the Trusted Acceptance of Issue #7 only', () => fixture(async root => {
      await pullRequest(root);
      const { config } = await loadImpact({ root, base: 'base' });
      assert.deepEqual(config.verifiers.filter(v => v.sbiIssue !== undefined).map(v => [v.id, v.sbiIssue, v.trust]), [['issue-7-acceptance', 7, 'acceptance']]);
    }));
    it('when the SBI is rebuilt from the current Issue then it matches the snapshot', () => fixture(async root => {
      await pullRequest(root);
      const { config, files } = await loadImpact({ root, base: 'base' });
      const source = await verifySbiSource({ root, base: 'base', files, required: [`production:${admin}`], repository: 'acme/app', config, github: readyGitHub });
      assert.equal(source.status, 'PASS', source.reasons.join('; '));
    }));
  });
  describe('given a registration that cannot be trusted', () => {
    it('when the registration of Issue #7 is gone then the rebuild fails and names the file to add', () => fixture(async root => {
      await pullRequest(root);
      await rm(join(root, acceptancePath(7)));
      await git(root, ['commit', '-am', 'drop the registration of Issue #7']);
      const { config, files } = await loadImpact({ root, base: 'base' });
      const source = await verifySbiSource({ root, base: 'base', files, required: [`production:${admin}`], repository: 'acme/app', config, github: readyGitHub });
      assert.equal(source.status, 'FAIL');
      assert.match(source.reasons.join('\n'), /\.harness\/acceptance\/sbi-7\.json/);
    }));
    it('when sbi-7.json says it belongs to Issue #8 then fails', () => fixture(async root => {
      await register(root, 7, registration(8));
      await assert.rejects(readAcceptance(root, 7), /sbi-7\.json.*#8/);
    }));
    it('when the registration has a key the schema does not know then fails', () => fixture(async root => {
      await register(root, 7, { ...registration(7), owner: 'someone' });
      await assert.rejects(readAcceptance(root, 7), /sbi-7\.json/);
    }));
    it('when the registration reuses the ID of a verifier in harness.json then fails', () => fixture(async root => {
      await register(root, 7, registration(7, { verifiers: [{ ...registration(7).verifiers[0], id: 'admin' }] }));
      await assert.rejects(withAcceptance(root, await harnessConfig(root), [7]), /admin/);
    }));
    it('when an Issue has no registration file then nothing is added for it', () => fixture(async root => {
      const config = await harnessConfig(root);
      assert.equal((await withAcceptance(root, config, [7])).verifiers.length, config.verifiers.length);
    }));
  });
});
}
