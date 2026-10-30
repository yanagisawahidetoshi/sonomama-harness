import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, human, commitFixture, runFixture as runHarness } from './test-fixture.mjs';
import { inspectMigration, checkMigrations } from './migration-safety.mjs';
import { classifySecurity } from './security-enforcement.mjs';
import { resumeRun } from './index.mjs';
import { runVerifier } from './impact.mjs';
import { recordDecision } from './human-approvals.mjs';
import { execute, readJson } from './io.mjs';

const config = JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
const migrationPath = 'apps/api/db/migrate/20261028000000_create_probes.rb';
const migration = body => `class CreateProbes < ActiveRecord::Migration[8.1]\n  def change\n${body}\n  end\nend\n`;
const safe = migration([
  '    create_table :probes do |t|',
  '      t.string :name, null: false',
  '      t.references :owner, foreign_key: true',
  '      t.timestamps',
  '    end',
  '    add_column :probes, :note, :text',
  '    add_index :probes, :name, unique: true',
].join('\n'));
const script = 'tools/harness/migration-safety.mjs';
const migrationSafety = config.securityVerifiers.find(v => v.id === 'migration-safety');

describe('Migration static inspection', () => {
  describe('given a migration that only adds a table, columns, a reference and an index', () => {
    it('when inspected then reports no dangerous operation', () => assert.deepEqual(inspectMigration(safe), []));
  });
  describe('given a migration with an operation that can destroy data, break running code or bypass the schema DSL', () => {
    for (const [operation, line] of [
      ['drop_table', 'drop_table :probes'], ['drop_join_table', 'drop_join_table :probes, :tags'],
      ['remove_column', 'remove_column :probes, :name, :string'], ['remove_columns', 'remove_columns :probes, :name, :note'],
      ['remove_reference', 'remove_reference :probes, :owner'], ['remove_belongs_to', 'remove_belongs_to :probes, :owner'],
      ['remove_timestamps', 'remove_timestamps :probes'], ['remove_index', 'remove_index :probes, :name'],
      ['remove_foreign_key', 'remove_foreign_key :probes, :owners'], ['rename_table', 'rename_table :probes, :samples'],
      ['rename_column', 'rename_column :probes, :name, :title'], ['change_column', 'change_column :probes, :name, :text'],
      ['change_column_null', 'change_column_null :probes, :note, false'], ['execute', 'execute "DELETE FROM probes"'],
      ['exec_query', 'exec_query "UPDATE probes SET name = NULL"'], ['update_all', 'Probe.update_all(name: nil)'],
      ['delete_all', 'Probe.delete_all'], ['establish_connection', 'ActiveRecord::Base.establish_connection(:production)'],
      ['t.remove', 'change_table(:probes) { |t| t.remove :name }'], ['t.rename', 'change_table(:probes) { |t| t.rename :name, :title }'],
      ['t.change', 'change_table(:probes) { |t| t.change :name, :text }'],
    ]) {
      it(`when it calls ${operation} then reports ${operation} with its line number`, () => {
        assert.deepEqual(inspectMigration(migration(`    ${line}`)), [{ line: 3, operation }]);
      });
    }
  });
  describe('given a dangerous operation that appears only in a comment', () => {
    it('when inspected then does not report it', () => assert.deepEqual(inspectMigration(migration('    # drop_table :probes is intentionally not done here\n    create_table :probes')), []));
  });
});

describe('Migration safety verifier', () => {
  describe('given the Rails migration directory of a repository', () => {
    it('when only safe migrations exist then PASSes', () => fixture(async root => {
      await mkdir(join(root, 'apps/api/db/migrate'), { recursive: true });
      await writeFile(join(root, migrationPath), safe);
      const result = await checkMigrations({ root });
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.migrations, [migrationPath]);
    }));
    it('when no migration exists yet then PASSes so the first table can be added', () => fixture(async root => {
      assert.equal((await checkMigrations({ root })).status, 'PASS');
    }));
    it('when a migration drops a table then FAILs and names the file, line and operation', () => fixture(async root => {
      await mkdir(join(root, 'apps/api/db/migrate'), { recursive: true });
      await writeFile(join(root, migrationPath), migration('    drop_table :probes'));
      const result = await checkMigrations({ root });
      assert.equal(result.status, 'FAIL');
      assert.deepEqual(result.findings, [{ path: migrationPath, line: 3, operation: 'drop_table' }]);
    }));
    it('when a file in the migration directory is not a timestamped Ruby migration then FAILs', () => fixture(async root => {
      await mkdir(join(root, 'apps/api/db/migrate'), { recursive: true });
      await writeFile(join(root, 'apps/api/db/migrate/create_probes.rb'), safe);
      const result = await checkMigrations({ root });
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /apps\/api\/db\/migrate\/create_probes\.rb/);
    }));
    it('when a migration lives outside the Rails migration directory then FAILs instead of passing it unchecked', () => fixture(async root => {
      await mkdir(join(root, 'packages/store/migrations'), { recursive: true });
      await writeFile(join(root, 'packages/store/migrations/001_init.sql'), 'DROP TABLE users;');
      const result = await checkMigrations({ root });
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /packages\/store\/migrations\/001_init\.sql/);
    }));
  });
  describe('given the command line entry point', () => {
    it('when a dangerous migration exists then exits non-zero', () => fixture(async root => {
      await mkdir(join(root, 'apps/api/db/migrate'), { recursive: true });
      await writeFile(join(root, migrationPath), migration('    remove_column :probes, :name, :string'));
      const result = await execute(process.execPath, [script], { cwd: root });
      assert.equal(result.code, 1);
      assert.match(result.stdout + result.stderr, /remove_column/);
    }));
    it('when only safe migrations exist then exits zero', () => fixture(async root => {
      await mkdir(join(root, 'apps/api/db/migrate'), { recursive: true });
      await writeFile(join(root, migrationPath), safe);
      assert.equal((await execute(process.execPath, [script], { cwd: root })).code, 0);
    }));
  });
});

describe('migration-safety Security Verifier configuration', () => {
  describe('given the shipped harness configuration', () => {
    it('when migration-safety is looked up then it is a configured command verifier instead of a placeholder', () => {
      assert.ok(migrationSafety.commands.length > 0);
      assert.deepEqual(migrationSafety.commands[0], ['node', script]);
    });
    it('when its database commands run then they target only the local test database and never production', () => {
      const runs = migrationSafety.commands.filter(c => c[0] === 'docker' && c.includes('run'));
      assert.ok(runs.length > 0);
      for (const command of runs) {
        assert.ok(command.includes('RAILS_ENV=test'), command.join(' '));
        assert.ok(command.some(arg => /^DATABASE_URL=postgres:\/\/postgres@db:5432\/[a-z_]+_test$/.test(arg)), command.join(' '));
        // Schema dumps go to the container-only tmp volume so the verified source snapshot never changes.
        assert.ok(command.some(arg => /^SCHEMA=\/rails\/tmp\//.test(arg)), command.join(' '));
        assert.equal(command.join(' ').includes('production'), false, command.join(' '));
      }
    });
    it('when its database commands run then migrations are applied, rolled back to zero and applied again', () => {
      const tasks = migrationSafety.commands.filter(c => c[0] === 'docker' && c.includes('run')).map(c => c.slice(c.indexOf('bin/rails') + 1).join(' '));
      const apply = tasks.findIndex(t => /\bdb:migrate$/.test(t));
      const rollback = tasks.indexOf('db:migrate VERSION=0');
      assert.ok(apply >= 0 && rollback > apply, tasks.join(' | '));
      assert.ok(tasks.slice(rollback + 1).some(t => t === 'db:migrate'), tasks.join(' | '));
    });
    it('when it is compared with the Rails verifier then it runs no RSpec, RuboCop, Brakeman or bundler-audit', () => {
      const text = migrationSafety.commands.map(c => c.join(' ')).join('\n');
      for (const tool of ['rspec', 'rubocop', 'brakeman', 'bundler-audit']) assert.equal(text.includes(tool), false, tool);
    });
  });
  describe('given a change to a Rails migration', () => {
    it('when classified then SEC-MIGRATION-001 still requires the gate, LEVEL 3, two approvals and migration-safety', () => {
      const result = classifySecurity({ files: [{ path: migrationPath, status: 'A', added: safe }], sbi: { risks: [], acceptanceCriteria: [] } }, policy);
      assert.ok(result.matchedRules.includes('SEC-MIGRATION-001'));
      assert.equal(result.requiresPreImplementationGate, true);
      assert.equal(result.minimumRiskLevel, 3);
      assert.equal(result.requiredHumanApprovals, 2);
      assert.ok(result.requiredVerifiers.includes('migration-safety'));
    });
  });
});

describe('migration-safety in the execution loop', () => {
  // The database commands need Docker; the loop is exercised with the static step so harness:test stays hermetic.
  const prepare = async (root, content) => {
    await update(root, '.harness/state/sample-sbi.json', s => { s.allowedFiles.push(migrationPath); s.securityImpact = ['Migration']; });
    await update(root, '.harness/config/harness.json', c => {
      // Verifier commands run in a container (or, for Harness scripts, as a trusted host process); the host node path does not exist there.
      Object.assign(c.verifiers.find(v => v.id === 'rails'), { isolation: 'container', commands: [['node', '-e', 'process.exit(0)']] });
      c.securityVerifiers.find(v => v.id === 'migration-safety').commands = [['node', script]];
    });
    const greeting = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
    return async () => ({ files: [{ path: 'greeting.mjs', content: greeting }, { path: migrationPath, content }] });
  };
  describe('given an SBI that adds a Rails migration', () => {
    it('when the approved SBI runs and the migration is safe then migration-safety PASSes, DONE needs two merge reviewers', () => fixture(async root => {
      const agent = await prepare(root, safe);
      const run = await runHarness({ root, quiet: true, agent });
      let resumed = run;
      assert.equal(resumed.executionStatus, 'DONE');
      assert.equal(resumed.risk.level, 3);
      const evidence = await readJson(join(root, run.runDir, 'security-verification.json'));
      assert.equal(evidence.checks.find(c => c.id === 'migration-safety').status, 'PASS');
      assert.equal(evidence.checks.some(c => c.status === 'NOT_CONFIGURED'), false);
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      resumed = await resumeRun({ root, runId: run.id, quiet: true, agent });
      assert.notEqual(resumed.status, 'MERGE_ALLOWED');
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('B') });
      resumed = await resumeRun({ root, runId: run.id, quiet: true, agent });
      assert.equal(resumed.status, 'MERGE_ALLOWED');
    }));
    it('when the approved SBI runs and the migration drops a table then migration-safety FAILs and the run is never DONE', () => fixture(async root => {
      const agent = await prepare(root, migration('    drop_table :probes'));
      const run = await runHarness({ root, quiet: true, agent });
      const resumed = run;
      assert.notEqual(resumed.executionStatus, 'DONE');
      const evidence = await readJson(join(root, run.runDir, 'security-verification.json'));
      assert.equal(evidence.checks.find(c => c.id === 'migration-safety').status, 'FAIL');
    }));
  });
});

describe('migration-safety in the CI verifier matrix', () => {
  // The CI matrix job runs `harness:verify --verifier migration-safety`; the database commands are replaced with the static step to stay hermetic.
  const pullRequest = async (root, content, commands = [['node', script]]) => {
    await update(root, '.harness/config/harness.json', c => { c.securityVerifiers.find(v => v.id === 'migration-safety').commands = commands; });
    await commitFixture(root);
    await mkdir(join(root, 'apps/api/db/migrate'), { recursive: true });
    await writeFile(join(root, migrationPath), content);
    const sample = await readJson(join(root, '.harness/state/sample-sbi.json'));
    await writeFile(join(root, '.harness/state/sbi-migration.json'), JSON.stringify({ ...sample, id: 'SBI-MIGRATION', allowedFiles: [migrationPath], securityImpact: ['Migration'], requiredVerifiers: ['migration-safety'] }));
    await commitFixture(root);
  };
  // The fixture copies only tracked files, so the CLI borrows this checkout's installed dependencies.
  const matrix = async root => {
    await symlink(new URL('../../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
    return execute(process.execPath, ['tools/harness/cli.mjs', 'verify', '--verifier', 'migration-safety', '--base', 'HEAD~1'], { cwd: root });
  };
  describe('given a Production pull request whose SBI makes Impact Analysis require migration-safety', () => {
    it('when the migration is safe then the matrix job runs migration-safety and PASSes instead of reporting NOT_CONFIGURED', () => fixture(async root => {
      await pullRequest(root, safe);
      const { impact, result, passed } = await runVerifier({ root, base: 'HEAD~1', id: 'migration-safety' });
      assert.ok(impact.requiredVerifiers.includes('migration-safety'));
      assert.deepEqual(result.checks.map(c => [c.id, c.status]), [['migration-safety', 'PASS']]);
      assert.equal(passed, true);
      assert.equal((await matrix(root)).code, 0);
    }));
    it('when the migration drops a table then the matrix job FAILs with the dangerous operation', () => fixture(async root => {
      await pullRequest(root, migration('    drop_table :probes'));
      const { result, passed } = await runVerifier({ root, base: 'HEAD~1', id: 'migration-safety' });
      assert.deepEqual(result.checks.map(c => [c.id, c.status]), [['migration-safety', 'FAIL']]);
      assert.equal(passed, false);
      const cli = await matrix(root);
      assert.equal(cli.code, 1);
      assert.match(cli.stdout + cli.stderr, /drop_table/);
    }));
    it('when migration-safety has no commands then the matrix job reports NOT_CONFIGURED and fails instead of passing', () => fixture(async root => {
      await pullRequest(root, safe, []);
      const { result, passed } = await runVerifier({ root, base: 'HEAD~1', id: 'migration-safety' });
      assert.deepEqual(result.checks.map(c => [c.id, c.status]), [['migration-safety', 'NOT_CONFIGURED']]);
      assert.equal(passed, false);
    }));
  });
});
