import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './test-fixture.mjs';
import { git } from './workspace.mjs';
import { readJson } from './io.mjs';
import { renderSbiBody } from './planner.mjs';
import { sbiFromIssue } from './sbi-issue.mjs';
import { snapshotFromIssue, snapshotPath, verifySbiSource } from './sbi-source.mjs';
import { loadImpact } from './impact.mjs';
import { acceptancePath, readAcceptance, withAcceptance } from './acceptance-registry.mjs';

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
  describe('given registrations of Issue #7 and #8 on main and a PR with the Run snapshot of Issue #7', () => {
    it('when the impact is loaded then the configuration has the Trusted Acceptance of Issue #7 only', () => fixture(async root => {
      await pullRequest(root);
      const { config } = await loadImpact({ root, base: 'base' });
      assert.deepEqual(config.verifiers.filter(v => v.sbiIssue !== undefined).map(v => [v.id, v.sbiIssue, v.trust]), [['issue-7-acceptance', 7, 'acceptance']]);
    }));
    it('when the SBI is rebuilt from the current Issue then it matches the snapshot', () => fixture(async root => {
      await pullRequest(root);
      const { config, files } = await loadImpact({ root, base: 'base' });
      const source = await verifySbiSource({ root, base: 'base', files, required: [`production:${admin}`], repository: 'acme/app', config, github: { fetchIssue: async () => readyIssue } });
      assert.equal(source.status, 'PASS', source.reasons.join('; '));
    }));
  });
  describe('given a registration that cannot be trusted', () => {
    it('when the registration of Issue #7 is gone then the rebuild fails and names the file to add', () => fixture(async root => {
      await pullRequest(root);
      await rm(join(root, acceptancePath(7)));
      await git(root, ['commit', '-am', 'drop the registration of Issue #7']);
      const { config, files } = await loadImpact({ root, base: 'base' });
      const source = await verifySbiSource({ root, base: 'base', files, required: [`production:${admin}`], repository: 'acme/app', config, github: { fetchIssue: async () => readyIssue } });
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
