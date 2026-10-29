import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update } from './test-fixture.mjs';
import { git } from './workspace.mjs';
import { execute } from './io.mjs';
import { checkMigrations } from './migration-safety.mjs';
import { exceptionDigest, exceptionPath, renderExceptionReview } from './migration-exception.mjs';
import { exceptionApprovals, verifyMigrationExceptions } from './migration-exception-approval.mjs';
import { runCompletionJudge } from './impact.mjs';

const create = 'apps/api/db/migrate/20261028000000_create_probes.rb';
const createSource = 'class CreateProbes < ActiveRecord::Migration[8.1]\n  def change\n    create_table :probes do |t|\n      t.string :name\n      t.string :legacy_code\n    end\n  end\nend\n';
const destroy = 'apps/api/db/migrate/20261029000000_remove_legacy_code_from_probes.rb';
const destroySource = 'class RemoveLegacyCodeFromProbes < ActiveRecord::Migration[8.1]\n  def change\n    remove_column :probes, :legacy_code, :string\n  end\nend\n';
const deployed = { state: 'deployed', deploymentRef: 'release-2026-10-28', deployedAt: '2026-10-28T09:00:00Z', confirmedBy: 'alice' };
const request = (overrides = {}) => ({
  version: 1, migration: destroy, operations: [{ line: 3, operation: 'remove_column' }],
  expand: { migration: create, commit: 'EXPAND' }, removes: [{ table: 'probes', column: 'legacy_code' }],
  rollback: { possible: true, procedure: 'db:rollback で列を戻し、退避したCSVから値を戻す' },
  dataBackup: { taken: true, location: 's3://backups/probes-legacy-code.csv' },
  productionState: { state: 'not_provisioned' }, ...overrides,
});
const write = async (root, path, content) => {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};
const commit = async (root, message) => {
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--allow-empty', '-m', message]);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
};
// The expand migration is merged into main first; the destructive migration and its exception request come in a later PR.
const contract = async (root, { requestOverrides = {}, source = destroySource, extra = {} } = {}) => {
  await write(root, create, createSource);
  const expand = await commit(root, 'feat: add probes');
  await git(root, ['update-ref', 'refs/remotes/origin/main', expand]);
  await git(root, ['branch', 'base']);
  await write(root, destroy, source);
  const body = request({ ...requestOverrides, expand: { migration: create, commit: expand, ...requestOverrides.expand } });
  await write(root, exceptionPath(destroy), body);
  for (const [path, content] of Object.entries(extra)) await write(root, path, content);
  const head = await commit(root, 'feat: remove probes.legacy_code');
  return { expand, head, body };
};

describe('Destructive migration exception request in migration-safety', () => {
  describe('given a destructive migration without an exception request', () => {
    it('when checked then it FAILs as before', () => fixture(async root => {
      await write(root, destroy, destroySource);
      const result = await checkMigrations({ root });
      assert.equal(result.status, 'FAIL');
      assert.deepEqual(result.findings, [{ path: destroy, line: 3, operation: 'remove_column' }]);
    }));
  });
  describe('given the contract step of an expand/contract migration with a complete exception request', () => {
    it('when checked then it PASSes and names the requested exception so it is not mistaken for a safe migration', () => fixture(async root => {
      await contract(root);
      const result = await checkMigrations({ root });
      assert.equal(result.status, 'PASS', result.errors.join('; '));
      assert.deepEqual(result.exceptions, [{ migration: destroy, request: exceptionPath(destroy) }]);
    }));
    it('when the production environment is deployed and the request records the deployment then it PASSes', () => fixture(async root => {
      await contract(root, { requestOverrides: { productionState: deployed } });
      assert.equal((await checkMigrations({ root })).status, 'PASS');
    }));
    it('when the old column is still listed in ignored_columns then it PASSes, since that is the expand step', () => fixture(async root => {
      await contract(root, { extra: { 'apps/api/app/models/probe.rb': 'class Probe < ApplicationRecord\n  self.ignored_columns += ["legacy_code"]\nend\n' } });
      assert.equal((await checkMigrations({ root })).status, 'PASS');
    }));
  });
  describe('given an exception request that does not satisfy the expand/contract conditions', () => {
    for (const [name, options, pattern] of [
      ['lists other operations than the migration performs', { requestOverrides: { operations: [{ line: 3, operation: 'drop_table' }] } }, /operations/],
      ['misses an operation added to the migration after the request', { source: destroySource.replace('  end\nend', '    remove_column :probes, :name, :string\n  end\nend') }, /operations/],
      ['names an expand commit that is not on main', { requestOverrides: { expand: { commit: '0'.repeat(40) } } }, /expand/],
      ['names an expand migration that is not in the expand commit', { requestOverrides: { expand: { migration: 'apps/api/db/migrate/20261027000000_other.rb' } } }, /expand/],
      ['removes a column the application still reads', { extra: { 'apps/api/app/models/probe.rb': 'class Probe < ApplicationRecord\n  def code = legacy_code\nend\n' } }, /legacy_code.*apps\/api\/app\/models\/probe\.rb/],
      ['removes a column the OpenAPI still documents', { extra: { 'packages/api-schema/openapi.yaml': 'components:\n  schemas:\n    Probe:\n      properties:\n        legacy_code: {type: string}\n' } }, /legacy_code.*packages\/api-schema\/openapi\.yaml/],
      ['says rollback is not possible', { requestOverrides: { rollback: { possible: false, procedure: 'なし' } } }, /rollback/],
      ['records a deployed production without the deployment', { requestOverrides: { productionState: { state: 'deployed' } } }, /productionState/],
      ['records an unprovisioned production with a deployment', { requestOverrides: { productionState: { state: 'not_provisioned', deploymentRef: 'release-1' } } }, /productionState/],
      ['treats a merge to main as a production deployment', { requestOverrides: { productionState: { state: 'merged_to_main' } } }, /productionState/],
      // A model constant (Probe) can still reach a dropped table without naming it, so table removals wait for a model-aware check.
      ['removes a whole table', { requestOverrides: { removes: [{ table: 'probes' }] } }, /removes/],
    ]) {
      it(`when it ${name} then it FAILs`, () => fixture(async root => {
        await contract(root, options);
        const result = await checkMigrations({ root });
        assert.equal(result.status, 'FAIL');
        assert.match(result.errors.join('\n'), pattern);
      }));
    }
    it('when the request is not valid JSON then it FAILs', () => fixture(async root => {
      await contract(root);
      await writeFile(join(root, exceptionPath(destroy)), '{');
      assert.equal((await checkMigrations({ root })).status, 'FAIL');
    }));
    it('when a request has no migration then it FAILs instead of being ignored', () => fixture(async root => {
      await write(root, exceptionPath('apps/api/db/migrate/20261030000000_gone.rb'), request({ migration: 'apps/api/db/migrate/20261030000000_gone.rb' }));
      const result = await checkMigrations({ root });
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /20261030000000/);
    }));
  });
});

describe('Approval context of a destructive migration exception', () => {
  const digest = (overrides = {}) => exceptionDigest({ migration: destroy, source: destroySource, request: request(overrides) });
  it('when nothing changes then the digest is the same', () => assert.equal(digest(), digest()));
  for (const [name, change] of [
    ['the migration file', () => exceptionDigest({ migration: destroy, source: `${destroySource}\n`, request: request() })],
    ['the destructive operations', () => digest({ operations: [{ line: 4, operation: 'remove_column' }] })],
    ['the expand merge commit', () => digest({ expand: { migration: create, commit: 'f'.repeat(40) } })],
    ['the rollback procedure', () => digest({ rollback: { possible: true, procedure: '別の手順' } })],
    ['the data backup', () => digest({ dataBackup: { taken: false } })],
    ['the production state', () => digest({ productionState: deployed })],
  ]) {
    it(`when ${name} changes then the digest changes, so an earlier approval no longer matches`, () => assert.notEqual(change(), digest()));
  }
  it('when the review text is rendered then it carries the digest line, the operations and the production state', () => {
    const text = renderExceptionReview({ migration: destroy, source: destroySource, request: request() });
    assert.ok(text.includes(`harness-migration-exception: ${digest()}`));
    assert.match(text, /remove_column/);
    assert.match(text, /not_provisioned/);
  });
});

describe('Approvals of a destructive migration exception', () => {
  const digest = 'd'.repeat(64), headSha = 'h'.repeat(40), author = 'harness-operator';
  const review = (id, login, overrides = {}) => ({ id, user: { login, type: 'User' }, state: 'COMMENTED', commit_id: headSha, body: `承認\nharness-migration-exception: ${digest}\n`, ...overrides });
  const permissions = { alice: 'write', bob: 'admin', carol: 'read', 'harness-operator': 'admin', 'renovate[bot]': 'write' };
  const approvals = reviews => exceptionApprovals({ reviews, headSha, author, permissions, digest });
  it('when two different people with write access post the review on the tested commit then the exception is approved', () => {
    assert.deepEqual(approvals([review(1, 'alice'), review(2, 'bob')]), { approved: true, approvers: ['alice', 'bob'], required: 2 });
  });
  // A merge approval (APPROVED) is a different purpose, so one review never serves both.
  it('when the second approval is posted as an APPROVED merge review then it does not count for the exception', () => {
    assert.equal(approvals([review(1, 'alice'), review(2, 'bob', { state: 'APPROVED' })]).approved, false);
  });
  it('when the second approval is posted with CHANGES_REQUESTED then it does not count', () => {
    assert.equal(approvals([review(1, 'alice'), review(2, 'bob', { state: 'CHANGES_REQUESTED' })]).approved, false);
  });
  it('when a revoke line comes in an APPROVED review then it does not revoke, since only COMMENTED reviews carry this purpose', () => {
    assert.equal(approvals([review(1, 'alice'), review(2, 'bob'), review(3, 'bob', { state: 'APPROVED', body: `harness-migration-exception-revoke: ${digest}` })]).approved, true);
  });
  for (const [name, reviews] of [
    ['only one person approved', [review(1, 'alice')]],
    ['the same person approved twice', [review(1, 'alice'), review(2, 'alice')]],
    ['the second approval is on an older commit', [review(1, 'alice'), review(2, 'bob', { commit_id: 'o'.repeat(40) })]],
    ['the second approval names another digest', [review(1, 'alice'), review(2, 'bob', { body: `harness-migration-exception: ${'e'.repeat(64)}` })]],
    ['the second approval has no approval line', [review(1, 'alice'), review(2, 'bob', { body: 'LGTM' })]],
    ['the second approval was dismissed', [review(1, 'alice'), review(2, 'bob', { state: 'DISMISSED' })]],
    ['the second approver revoked it later', [review(1, 'alice'), review(2, 'bob'), review(3, 'bob', { body: `harness-migration-exception-revoke: ${digest}` })]],
    ['the second approver is the PR author', [review(1, 'alice'), review(2, author)]],
    ['the second approver is a bot', [review(1, 'alice'), review(2, 'renovate[bot]', { user: { login: 'renovate[bot]', type: 'Bot' } })]],
    ['the second approver has only read access', [review(1, 'alice'), review(2, 'carol')]],
    ['the second approver has no readable permission', [review(1, 'alice'), review(2, 'dave')]],
  ]) {
    it(`when ${name} then the exception is not approved`, () => assert.equal(approvals(reviews).approved, false));
  }
});

describe('CI Completion Judge for a destructive migration exception', () => {
  const needs = { impact: { result: 'success' }, verifiers: { result: 'success' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };
  const prGitHub = ({ head, digest, reviewers = ['alice', 'bob'], overrides = {} }) => ({
    pull: async () => ({ number: 42, user: { login: 'harness-operator', type: 'User' }, head: { sha: head } }),
    reviews: async () => reviewers.map((login, i) => ({ id: i + 1, user: { login, type: 'User' }, state: 'COMMENTED', commit_id: head, body: `harness-migration-exception: ${digest}` })),
    permission: async () => 'write', ...overrides,
  });
  const verify = (root, head, githubPr, extra = {}) => verifyMigrationExceptions({ root, base: 'base', headSha: head, repository: 'acme/app', pullNumber: '42', githubPr, ...extra });
  const digestOf = (body, source = destroySource) => exceptionDigest({ migration: destroy, source, request: body });
  // migration-safety runs its static step only, so the Judge never starts Docker in harness:test.
  const staticOnly = root => update(root, '.harness/config/harness.json', c => { c.securityVerifiers.find(v => v.id === 'migration-safety').commands = [[process.execPath, 'tools/harness/migration-safety.mjs']]; });
  it('when two people approved the exact request on the tested commit then it PASSes', () => fixture(async root => {
    const { head, body } = await contract(root);
    const result = await verify(root, head, prGitHub({ head, digest: digestOf(body) }));
    assert.equal(result.status, 'PASS', result.reasons.join('; '));
    assert.deepEqual(result.exceptions.map(e => [e.migration, e.approvers]), [[destroy, ['alice', 'bob']]]);
  }));
  it('when only one person approved then it FAILs with the count', () => fixture(async root => {
    const { head, body } = await contract(root);
    const result = await verify(root, head, prGitHub({ head, digest: digestOf(body), reviewers: ['alice'] }));
    assert.equal(result.status, 'FAIL');
    assert.match(result.reasons.join('\n'), /1\/2/);
  }));
  it('when the request was approved and then edited then the approvals no longer match and it FAILs', () => fixture(async root => {
    const { head, body } = await contract(root);
    const approved = digestOf({ ...body, dataBackup: { taken: false } });
    const result = await verify(root, head, prGitHub({ head, digest: approved }));
    assert.equal(result.status, 'FAIL');
  }));
  it('when the PR has no destructive migration then nothing is required and GitHub is not read', () => fixture(async root => {
    await git(root, ['branch', 'base']);
    await write(root, create, createSource);
    const head = await commit(root, 'feat: add probes');
    const result = await verify(root, head, { pull: async () => { throw new Error('must not be called'); } });
    assert.deepEqual([result.status, result.exceptions], ['PASS', []]);
  }));
  for (const [name, extra, pattern] of [
    ['has no pull request number', { pullNumber: undefined }, /pull request number/],
    ['cannot read the reviews', { githubPr: { pull: async () => { throw new Error('HTTP 502'); } } }, /HTTP 502/],
  ]) {
    it(`when CI ${name} then it fails closed`, () => fixture(async root => {
      const { head } = await contract(root);
      const result = await verify(root, head, extra.githubPr, extra);
      assert.equal(result.status, 'FAIL');
      assert.match(result.reasons.join('\n'), pattern);
    }));
  }
  it('when the Completion Judge runs then an unapproved exception fails it even though migration-safety passed', () => fixture(async root => {
    await staticOnly(root);
    const { head, body } = await contract(root);
    const judged = await runCompletionJudge({ root, base: 'base', needs, repository: 'acme/app', pullNumber: '42',
      github: { fetchIssue: async () => { throw new Error('no SBI'); }, fetchPull: async () => { throw new Error('no bot'); }, pullCommits: async () => [] },
      githubPr: prGitHub({ head, digest: digestOf(body), reviewers: ['alice'] }) });
    assert.equal(judged.status, 'FAIL');
    assert.ok(judged.reasons.some(r => r.startsWith('migration exception:')), judged.reasons.join('; '));
  }));
  it('when the Completion Judge runs with two approvals then the exception adds no reason', () => fixture(async root => {
    await staticOnly(root);
    const { head, body } = await contract(root);
    const judged = await runCompletionJudge({ root, base: 'base', needs, repository: 'acme/app', pullNumber: '42',
      github: { fetchIssue: async () => { throw new Error('no SBI'); }, fetchPull: async () => { throw new Error('no bot'); }, pullCommits: async () => [] },
      githubPr: prGitHub({ head, digest: digestOf(body) }) });
    assert.deepEqual(judged.reasons.filter(r => r.startsWith('migration exception:')), []);
    assert.equal(judged.migrationExceptions.status, 'PASS');
  }));
});

describe('migration-exception CLI', () => {
  it('when a request path is given then prints the review text with the digest and never posts it', () => fixture(async root => {
    await contract(root);
    const result = await execute(process.execPath, ['tools/harness/migration-exception.mjs', exceptionPath(destroy)], { cwd: root });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^harness-migration-exception: [0-9a-f]{64}$/m);
  }));
});
