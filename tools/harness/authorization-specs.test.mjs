import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, commitFixture } from './test-fixture.mjs';
import { inspectAuthorizationSpec, checkAuthorizationSpecs } from './authorization-specs.mjs';
import { classifySecurity } from './security-enforcement.mjs';
import { runVerifier } from './impact.mjs';
import { execute, readJson } from './io.mjs';

const config = JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
const specPath = 'apps/api/spec/authorization/lessons_spec.rb';
const spec = body => `require "rails_helper"\n\nRSpec.describe "Lesson authorization", type: :request do\n${body}\nend\n`;
const examples = spec([
  '  context "when a student updates a lesson" do',
  '    it "returns 403" do',
  '      expect(response).to have_http_status(:forbidden)',
  '    end',
  '  end',
].join('\n'));
const script = 'tools/harness/authorization-specs.mjs';
const railsAuthz = config.securityVerifiers.find(v => v.id === 'rails-authz-test');

describe('Authorization spec static inspection', () => {
  describe('given an authorization spec whose examples all run', () => {
    it('when inspected then reports nothing', () => assert.deepEqual(inspectAuthorizationSpec(examples), []));
  });
  describe('given an authorization spec that skips or focuses an example', () => {
    for (const [marker, line] of [
      ['skip', 'skip "not decided yet"'], ['pending', 'pending "role table"'], ['xit', 'xit "returns 403" do'],
      ['xspecify', 'xspecify "returns 403" do'], ['xexample', 'xexample "returns 403" do'], ['xdescribe', 'xdescribe "students" do'],
      ['xcontext', 'xcontext "when a student" do'], ['fit', 'fit "returns 403" do'], ['fdescribe', 'fdescribe "students" do'],
      ['fcontext', 'fcontext "when a student" do'], ['focus', 'it "returns 403", :focus do'], ['focus', 'it "returns 403", focus: true do'],
      ['skip', 'it "returns 403", skip: true do'],
    ]) {
      it(`when it uses ${line} then reports ${marker} with its line number`, () => {
        assert.deepEqual(inspectAuthorizationSpec(spec(`  ${line}`)), [{ line: 4, marker }]);
      });
    }
  });
  describe('given a marker that appears only in a comment', () => {
    it('when inspected then does not report it', () => assert.deepEqual(inspectAuthorizationSpec(spec('  # skip is never used here')), []));
  });
});

describe('Authorization spec verifier', () => {
  describe('given the Rails authorization spec directory of a repository', () => {
    it('when no authorization spec exists then FAILs instead of passing an authorization change unverified', () => fixture(async root => {
      const result = await checkAuthorizationSpecs({ root });
      assert.equal(result.status, 'FAIL');
      assert.match(result.errors.join('\n'), /apps\/api\/spec\/authorization/);
    }));
    it('when an authorization spec exists and every example runs then PASSes', () => fixture(async root => {
      await mkdir(join(root, 'apps/api/spec/authorization'), { recursive: true });
      await writeFile(join(root, specPath), examples);
      const result = await checkAuthorizationSpecs({ root });
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.specs, [specPath]);
    }));
    it('when an authorization spec skips an example then FAILs and names the file, line and marker', () => fixture(async root => {
      await mkdir(join(root, 'apps/api/spec/authorization'), { recursive: true });
      await writeFile(join(root, specPath), spec('  xit "returns 403" do\n  end'));
      const result = await checkAuthorizationSpecs({ root });
      assert.equal(result.status, 'FAIL');
      assert.deepEqual(result.findings, [{ path: specPath, line: 4, marker: 'xit' }]);
    }));
    it('when the directory holds only support files and no _spec.rb then FAILs', () => fixture(async root => {
      await mkdir(join(root, 'apps/api/spec/authorization/support'), { recursive: true });
      await writeFile(join(root, 'apps/api/spec/authorization/support/roles.rb'), 'ROLES = [].freeze\n');
      assert.equal((await checkAuthorizationSpecs({ root })).status, 'FAIL');
    }));
  });
  describe('given the command line entry point', () => {
    it('when no authorization spec exists then exits non-zero', () => fixture(async root => {
      const result = await execute(process.execPath, [script], { cwd: root });
      assert.equal(result.code, 1);
      assert.match(result.stdout + result.stderr, /apps\/api\/spec\/authorization/);
    }));
    it('when authorization specs exist then exits zero', () => fixture(async root => {
      await mkdir(join(root, 'apps/api/spec/authorization'), { recursive: true });
      await writeFile(join(root, specPath), examples);
      assert.equal((await execute(process.execPath, [script], { cwd: root })).code, 0);
    }));
  });
});

describe('rails-authz-test Security Verifier configuration', () => {
  describe('given the shipped harness configuration', () => {
    it('when rails-authz-test is looked up then it is a configured command verifier instead of a placeholder', () => {
      assert.ok(railsAuthz.commands.length > 0);
      assert.deepEqual(railsAuthz.commands[0], ['node', script]);
    });
    it('when its Rails commands run then they target only the local test database and never production', () => {
      const runs = railsAuthz.commands.filter(c => c[0] === 'docker' && c.includes('run'));
      assert.ok(runs.length > 0);
      for (const command of runs) {
        assert.ok(command.includes('RAILS_ENV=test'), command.join(' '));
        assert.ok(command.some(arg => /^DATABASE_URL=postgres:\/\/postgres@db:5432\/[a-z_]+_test$/.test(arg)), command.join(' '));
        assert.equal(command.join(' ').includes('production'), false, command.join(' '));
      }
    });
    it('when its Rails commands run then the database is prepared before only the authorization specs run, failing on zero examples', () => {
      const tasks = railsAuthz.commands.filter(c => c[0] === 'docker' && c.includes('run')).map(c => c.slice(c.indexOf('api') + 1).join(' '));
      const prepare = tasks.indexOf('bin/rails db:prepare');
      const rspec = tasks.indexOf('bundle exec rspec spec/authorization --fail-if-no-examples');
      assert.ok(prepare >= 0 && rspec > prepare, tasks.join(' | '));
    });
    it('when its commands finish then the containers are stopped', () => {
      assert.deepEqual(railsAuthz.commands.at(-1), ['docker', 'compose', '-f', 'compose.yaml', 'down']);
    });
  });
  describe('given a change that only edits an authorization spec', () => {
    it('when classified then SEC-AUTHZ-001 still requires the gate, LEVEL 3, two approvals and rails-authz-test', () => {
      const result = classifySecurity({ files: [{ path: specPath, status: 'M', added: examples }], sbi: { risks: [], acceptanceCriteria: [] } }, policy);
      assert.ok(result.matchedRules.includes('SEC-AUTHZ-001'));
      assert.equal(result.requiresPreImplementationGate, true);
      assert.equal(result.minimumRiskLevel, 3);
      assert.equal(result.requiredHumanApprovals, 2);
      assert.ok(result.requiredVerifiers.includes('rails-authz-test'));
    });
  });
});

describe('rails-authz-test in the CI verifier matrix', () => {
  // The CI matrix job runs `harness:verify --verifier rails-authz-test`; the Docker commands are replaced with the static step to stay hermetic.
  const policyPath = 'apps/api/app/policies/lesson_policy.rb';
  const pullRequest = async (root, specs, commands = [[process.execPath, script]]) => {
    await update(root, '.harness/config/harness.json', c => { c.securityVerifiers.find(v => v.id === 'rails-authz-test').commands = commands; });
    await commitFixture(root);
    await mkdir(join(root, 'apps/api/app/policies'), { recursive: true });
    await writeFile(join(root, policyPath), 'class LessonPolicy\n  def update? = authorize(user, :update)\nend\n');
    for (const [path, content] of Object.entries(specs)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const sample = await readJson(join(root, '.harness/state/sample-sbi.json'));
    await writeFile(join(root, '.harness/state/sbi-authz.json'), JSON.stringify({ ...sample, id: 'SBI-AUTHZ', allowedFiles: [policyPath, ...Object.keys(specs)], securityImpact: ['AuthZ'], requiredVerifiers: ['rails-authz-test'] }));
    await commitFixture(root);
  };
  // The fixture copies only tracked files, so the CLI borrows this checkout's installed dependencies.
  const matrix = async root => {
    await symlink(new URL('../../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
    return execute(process.execPath, ['tools/harness/cli.mjs', 'verify', '--verifier', 'rails-authz-test', '--base', 'HEAD~1'], { cwd: root });
  };
  describe('given a Production pull request that changes the API authorization implementation', () => {
    it('when authorization specs come with it then the matrix job runs rails-authz-test and PASSes instead of reporting NOT_CONFIGURED', () => fixture(async root => {
      await pullRequest(root, { [specPath]: examples });
      const { impact, result, passed } = await runVerifier({ root, base: 'HEAD~1', id: 'rails-authz-test' });
      assert.ok(impact.requiredVerifiers.includes('rails-authz-test'));
      assert.deepEqual(result.checks.map(c => [c.id, c.status]), [['rails-authz-test', 'PASS']]);
      assert.equal(passed, true);
      assert.equal((await matrix(root)).code, 0);
    }));
    it('when no authorization spec exists then the matrix job FAILs', () => fixture(async root => {
      await pullRequest(root, {});
      const { result, passed } = await runVerifier({ root, base: 'HEAD~1', id: 'rails-authz-test' });
      assert.deepEqual(result.checks.map(c => [c.id, c.status]), [['rails-authz-test', 'FAIL']]);
      assert.equal(passed, false);
      assert.equal((await matrix(root)).code, 1);
    }));
    it('when rails-authz-test has no commands then the matrix job reports NOT_CONFIGURED and fails instead of passing', () => fixture(async root => {
      await pullRequest(root, { [specPath]: examples }, []);
      const { result, passed } = await runVerifier({ root, base: 'HEAD~1', id: 'rails-authz-test' });
      assert.deepEqual(result.checks.map(c => [c.id, c.status]), [['rails-authz-test', 'NOT_CONFIGURED']]);
      assert.equal(passed, false);
    }));
  });
});
