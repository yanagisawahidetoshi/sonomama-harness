import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, commitFixture } from './test-fixture.mjs';
import { inspectJsTest, inspectRspec, checkSecuritySpecs, checkTestReport, rspecRunner, testReport } from './security-specs.mjs';
import { runVerifier } from './impact.mjs';
import { execute, readJson } from './io.mjs';

const config = JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
const script = 'tools/harness/security-specs.mjs';
const rspec = body => `require "rails_helper"\n\nRSpec.describe "Security", type: :request do\n${body}\nend\n`;
const rspecExamples = rspec('  it "returns 401" do\n    expect(response).to have_http_status(:unauthorized)\n  end');
const jsTest = body => `import { describe, expect, it } from 'vitest';\n\ndescribe('signIn', () => {\n${body}\n});\n`;
const jsExamples = jsTest("  it('rejects a wrong password', () => {\n    expect(true).toBe(true);\n  });");
// Each verifier, the directory its tests live in, the spec file a change adds there and the runner that executes it.
const suites = [
  { id: 'authn-test', directory: 'apps/api/spec/authentication', spec: 'apps/api/spec/authentication/sessions_spec.rb', examples: rspecExamples, skipped: rspec('  xit "returns 401" do\n  end'), skippedMarker: 'xit', support: 'apps/api/spec/authentication/support/tokens.rb', code: 'apps/api/app/controllers/sessions_controller.rb', impact: ['AuthN'] },
  { id: 'rails-rls-test', directory: 'apps/api/spec/rls', spec: 'apps/api/spec/rls/lessons_spec.rb', examples: rspecExamples, skipped: rspec('  it "hides other tenants", :focus do\n  end'), skippedMarker: 'focus', support: 'apps/api/spec/rls/support/tenants.rb', code: 'apps/api/db/rls.sql', impact: ['RLS'] },
  { id: 'data-lifecycle-test', directory: 'apps/api/spec/data_lifecycle', spec: 'apps/api/spec/data_lifecycle/retention_spec.rb', examples: rspecExamples, skipped: rspec('  pending "retention period"'), skippedMarker: 'pending', support: 'apps/api/spec/data_lifecycle/support/clock.rb', code: 'apps/api/app/jobs/purge_job.rb', impact: ['DataLifecycle'] },
  { id: 'admin-authn-test', directory: 'apps/admin/src/features/auth', spec: 'apps/admin/src/features/auth/hooks/useSignIn.test.ts', examples: jsExamples, skipped: jsTest("  it.skip('rejects a wrong password', () => {});"), skippedMarker: 'skip', support: 'apps/admin/src/features/auth/hooks/useSignIn.ts', code: 'apps/admin/src/features/auth/index.ts', impact: ['AuthN'] },
  { id: 'mobile-authn-test', directory: 'apps/mobile/src/features/auth', spec: 'apps/mobile/src/features/auth/hooks/useSignIn.test.tsx', examples: jsExamples, skipped: jsTest("  it.only('rejects a wrong password', () => {});"), skippedMarker: 'only', support: 'apps/mobile/src/features/auth/hooks/useSignIn.ts', code: 'apps/mobile/src/features/auth/index.ts', impact: ['AuthN'] },
];
const shipped = id => config.securityVerifiers.find(v => v.id === id);
const write = async (root, path, content) => {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
};

describe('Security spec static inspection', () => {
  describe('given an RSpec file whose examples all run', () => {
    it('when inspected then reports nothing', () => assert.deepEqual(inspectRspec(rspecExamples), []));
  });
  describe('given an RSpec file that skips or focuses an example', () => {
    for (const [marker, line] of [['xit', 'xit "returns 401" do'], ['skip', 'it "returns 401", skip: true do'], ['pending', 'pending "token table"'], ['focus', 'it "returns 401", :focus do'], ['fdescribe', 'fdescribe "sessions" do'],
      // Forms that do not start the line (review of #246).
      ['skip', 'it("returns 401") { skip }'], ['skip', 'before { skip }'], ['skip', 'it "returns 401" do skip "later" end'], ['pending', 'it("returns 401") { pending }'],
      ['xdescribe', 'RSpec.xdescribe "sessions" do'], ['fdescribe', 'RSpec.fdescribe "sessions" do'], ['xit', 'let(:user) { nil }; xit "returns 401" do']]) {
      it(`when it uses ${line} then reports ${marker} with its line number`, () => {
        assert.deepEqual(inspectRspec(rspec(`  ${line}`)), [{ line: 4, marker }]);
      });
    }
  });
  describe('given a Vitest or Jest file whose tests all run', () => {
    it('when inspected then reports nothing', () => assert.deepEqual(inspectJsTest(jsExamples), []));
  });
  describe('given a Vitest or Jest file that skips, focuses or leaves a test to do', () => {
    for (const [marker, line] of [
      ['skip', "it.skip('rejects', () => {});"], ['skip', "describe.skip('signIn', () => {});"], ['skip', "test.skipIf(process.env.CI)('rejects', () => {});"],
      ['skip', "it('rejects', (ctx) => { ctx.skip(); });"], ['runIf', "it.runIf(false)('rejects', () => {});"], ['only', "it.only('rejects', () => {});"],
      ['only', "describe.only('signIn', () => {});"], ['todo', "it.todo('rejects');"], ['xit', "xit('rejects', () => {});"], ['xtest', "xtest('rejects', () => {});"],
      ['xdescribe', "xdescribe('signIn', () => {});"], ['fit', "fit('rejects', () => {});"], ['fdescribe', "fdescribe('signIn', () => {});"],
      // Forms the first static check let through (review of #246).
      ['skip', "it('rejects', { skip: true }, () => {});"], ['only', "it('rejects', { only: true }, () => {});"], ['todo', "it('rejects', { todo: true }, () => {});"],
      ['fails', "it.fails('rejects', () => {});"], ['failing', "test.failing('rejects', () => {});"], ['skip', "/**/ it.skip('rejects', () => {});"],
      ['skip', "* it.skip('rejects', () => {});"], ['skip', "it['skip']('rejects', () => {});"], ['alias', 'const { skip } = it;'],
    ]) {
      it(`when it uses ${line} then reports ${marker} with its line number`, () => {
        assert.deepEqual(inspectJsTest(jsTest(`  ${line}`)), [{ line: 4, marker }]);
      });
    }
  });
  describe('given the JSON report of a Vitest or Jest run, which counts what the static check cannot see', () => {
    const report = patch => JSON.stringify({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, ...patch });
    it('when every counted test ran and passed then PASSes', () => assert.equal(checkTestReport(report({})).status, 'PASS'));
    for (const [name, patch] of [
      ['no test ran', { numTotalTests: 0, numPassedTests: 0 }], ['a test was skipped', { numPassedTests: 1, numPendingTests: 1 }],
      ['a test is left to do', { numPassedTests: 1, numTodoTests: 1 }], ['a test failed', { numPassedTests: 1, numFailedTests: 1 }],
      ['a suite failed to load', { numFailedTestSuites: 1 }], ['the counts are missing', { numTotalTests: undefined }],
    ]) {
      it(`when ${name} then FAILs`, () => assert.equal(checkTestReport(report(patch)).status, 'FAIL'));
    }
    it('when the report is not JSON then FAILs', () => assert.equal(checkTestReport('not json').status, 'FAIL'));
  });
  describe('given the RSpec runner of the Rails Security Verifiers', () => {
    const source = rspecRunner('spec/authentication');
    it('when it is built then runs only that directory with a JSON report and fails on zero examples', () => {
      assert.match(source, /RSpec::Core::Runner\.run\(\["spec\/authentication"/);
      assert.match(source, /"--format", "json"/);
      assert.match(source, /fail_if_no_examples = true/);
    });
    it('when it judges the run then fails on a pending or skipped example and on an example a filter such as focus left out', () => {
      assert.match(source, /pending_count/);
      assert.match(source, /example_count/);
      assert.match(source, /descendants/);
    });
  });
  describe('given a marker that appears only in a comment', () => {
    it('when an RSpec comment names skip then does not report it', () => assert.deepEqual(inspectRspec(rspec('  # skip is never used here')), []));
    it('when a JavaScript comment names it.only then does not report it', () => assert.deepEqual(inspectJsTest(jsTest('  // it.only is never used here')), []));
  });
});

describe('Security spec verifiers that were NOT_CONFIGURED', () => {
  for (const suite of suites) {
    describe(`given the ${suite.directory} directory of a repository for ${suite.id}`, () => {
      it('when no spec exists then FAILs instead of passing the security change unverified', () => fixture(async root => {
        const result = await checkSecuritySpecs({ root, id: suite.id });
        assert.equal(result.status, 'FAIL');
        assert.match(result.errors.join('\n'), new RegExp(suite.directory));
      }));
      it('when a spec exists and every example runs then PASSes', () => fixture(async root => {
        await write(root, suite.spec, suite.examples);
        const result = await checkSecuritySpecs({ root, id: suite.id });
        assert.equal(result.status, 'PASS');
        assert.deepEqual(result.specs, [suite.spec]);
      }));
      it(`when a spec uses ${suite.skippedMarker} then FAILs and names the file and marker`, () => fixture(async root => {
        await write(root, suite.spec, suite.skipped);
        const result = await checkSecuritySpecs({ root, id: suite.id });
        assert.equal(result.status, 'FAIL');
        assert.deepEqual(result.findings.map(f => [f.path, f.marker]), [[suite.spec, suite.skippedMarker]]);
      }));
      it('when the directory holds only support files and no spec then FAILs', () => fixture(async root => {
        await write(root, suite.support, '# support\n');
        assert.equal((await checkSecuritySpecs({ root, id: suite.id })).status, 'FAIL');
      }));
      it('when no spec exists then the command line entry point exits non-zero and names the directory', () => fixture(async root => {
        const result = await execute(process.execPath, [script, suite.id], { cwd: root });
        assert.equal(result.code, 1);
        assert.match(result.stdout + result.stderr, new RegExp(suite.directory));
      }));
      it('when a spec exists then the command line entry point exits zero', () => fixture(async root => {
        await write(root, suite.spec, suite.examples);
        assert.equal((await execute(process.execPath, [script, suite.id], { cwd: root })).code, 0);
      }));
    });
  }
  describe('given the mobile app, whose Jest also runs *.spec.*, __tests__/ and .mts test files', () => {
    for (const path of ['apps/mobile/src/features/auth/useSignIn.spec.ts', 'apps/mobile/src/features/auth/__tests__/useSignIn.ts', 'apps/mobile/src/features/auth/useSignIn.test.mts']) {
      it(`when only ${path} skips a test then FAILs`, () => fixture(async root => {
        await write(root, 'apps/mobile/src/features/auth/useSignOut.test.ts', jsExamples);
        await write(root, path, jsTest("  it.skip('rejects', () => {});"));
        const result = await checkSecuritySpecs({ root, id: 'mobile-authn-test' });
        assert.equal(result.status, 'FAIL');
        assert.deepEqual(result.findings.map(f => f.path), [path]);
      }));
    }
  });
  describe('given the JSON report a test run left', () => {
    const report = JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0 });
    it('when every test ran then the command line entry point exits zero', () => fixture(async root => {
      await writeFile(join(root, 'report.json'), report);
      assert.equal((await execute(process.execPath, [script, 'admin-authn-test', '--report', 'report.json'], { cwd: root })).code, 0);
    }));
    it('when a test was skipped then the command line entry point exits non-zero and says so', () => fixture(async root => {
      await writeFile(join(root, 'report.json'), report.replace('"numPendingTests":0', '"numPendingTests":1'));
      const result = await execute(process.execPath, [script, 'admin-authn-test', '--report', 'report.json'], { cwd: root });
      assert.equal(result.code, 1);
      assert.match(result.stdout + result.stderr, /pending/i);
    }));
    it('when the report is missing then the command line entry point exits non-zero', () => fixture(async root => {
      assert.equal((await execute(process.execPath, [script, 'admin-authn-test', '--report', 'missing.json'], { cwd: root })).code, 1);
    }));
  });
  describe('given the command line entry point', () => {
    it('when the verifier ID is unknown then exits non-zero instead of passing', () => fixture(async root => {
      assert.equal((await execute(process.execPath, [script, 'unknown-test'], { cwd: root })).code, 1);
    }));
  });
});

describe('Security Verifier configuration for authentication, RLS and data lifecycle', () => {
  describe('given the shipped harness configuration', () => {
    it('when every command verifier a security rule requires is looked up then each has commands, so none is NOT_CONFIGURED', () => {
      const command = new Set(policy.verifiers.filter(v => v.kind === 'command').map(v => v.id));
      for (const id of new Set(policy.rules.flatMap(r => r.requiredVerifiers).filter(id => command.has(id)))) assert.ok(shipped(id)?.commands.length > 0, id);
    });
    for (const suite of suites) {
      it(`when ${suite.id} is looked up then it starts with the static step for its own directory`, () => {
        const [first] = shipped(suite.id).commands;
        assert.equal(first[0], 'node');
        assert.match(first[1], /(^|\/)tools\/harness\/security-specs\.mjs$/);
        assert.equal(first[2], suite.id);
      });
    }
    for (const [id, directory, database] of [['rails-authz-test', 'spec/authorization', 'sonomama_authz_test'], ['authn-test', 'spec/authentication', 'sonomama_authn_test'], ['rails-rls-test', 'spec/rls', 'sonomama_rls_test'], ['data-lifecycle-test', 'spec/data_lifecycle', 'sonomama_data_lifecycle_test']]) {
      it(`when ${id} runs Rails then it prepares its own test database before running only ${directory}, failing on zero examples`, () => {
        const verifier = shipped(id);
        assert.equal(verifier.isolation, 'compose');
        const runs = verifier.commands.filter(c => c[0] === 'docker' && c.includes('run'));
        for (const command of runs) {
          assert.ok(command.includes('RAILS_ENV=test'), command.join(' '));
          assert.ok(command.includes(`DATABASE_URL=postgres://postgres@db:5432/${database}`), command.join(' '));
          assert.equal(command.join(' ').includes('production'), false, command.join(' '));
        }
        const tasks = runs.map(c => c.slice(c.indexOf('api') + 1).join(' '));
        const prepare = tasks.indexOf('bin/rails db:prepare');
        const run = tasks.indexOf(`bundle exec ruby -e ${rspecRunner(directory)}`);
        assert.ok(prepare >= 0 && run > prepare, tasks.join(' | '));
        assert.deepEqual(verifier.commands.at(-1), ['docker', 'compose', '-f', 'compose.yaml', 'down']);
      });
    }
    for (const [id, app, runner] of [
      ['admin-authn-test', 'admin', ['pnpm', 'exec', 'vitest', 'run', 'src/features/auth/', '--reporter=default', '--reporter=json', `--outputFile.json=${testReport}`]],
      ['mobile-authn-test', 'mobile', ['pnpm', 'exec', 'jest', '--ci', '--json', `--outputFile=${testReport}`, 'src/features/auth/']],
    ]) {
      it(`when ${id} runs then it installs the ${app} app as setup and judges src/features/auth by the counts its own test runner reports`, () => {
        const verifier = shipped(id);
        assert.equal(verifier.directory, `apps/${app}`);
        assert.equal(verifier.isolation ?? 'container', 'container');
        assert.equal(verifier.network, true);
        assert.deepEqual(verifier.setupCommands, [['pnpm', 'install', '--frozen-lockfile', '--prefer-offline', '--filter', app]]);
        assert.equal(verifier.commands.some(c => c.includes('install')), false);
        assert.deepEqual(verifier.commands.slice(1), [runner, ['node', '../../tools/harness/security-specs.mjs', id, '--report', testReport]]);
        assert.equal(verifier.commands.flat().some(arg => /passWithNoTests/i.test(arg)), false);
      });
    }
  });
});

describe('Security spec verifiers in the CI verifier matrix', () => {
  // The CI matrix job runs `harness:verify --verifier ID`; the Docker commands are replaced with the static step to stay hermetic,
  // and the container verifiers of the apps run it as a Harness script.
  const pullRequest = async (root, suite, specs) => {
    await update(root, '.harness/config/harness.json', c => {
      const verifier = c.securityVerifiers.find(v => v.id === suite.id);
      verifier.commands = [verifier.commands[0]];
      delete verifier.setupCommands;
      if (verifier.isolation !== 'compose') verifier.isolation = 'harness';
    });
    await commitFixture(root);
    await write(root, suite.code, '# change\n');
    for (const [path, content] of Object.entries(specs)) await write(root, path, content);
    const sample = await readJson(join(root, '.harness/state/sample-sbi.json'));
    await writeFile(join(root, '.harness/state/sbi-security.json'), JSON.stringify({ ...sample, id: 'SBI-SECURITY', allowedFiles: [suite.code, ...Object.keys(specs)], securityImpact: suite.impact, requiredVerifiers: [suite.id] }));
    await commitFixture(root);
  };
  // The fixture copies only tracked files, so the CLI borrows this checkout's installed dependencies.
  const matrix = async (root, id) => {
    await symlink(new URL('../../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
    return execute(process.execPath, ['tools/harness/cli.mjs', 'verify', '--verifier', id, '--base', 'HEAD~1'], { cwd: root });
  };
  for (const suite of suites) {
    describe(`given a Production pull request whose SBI requires ${suite.id}`, () => {
      it('when its specs come with it then the matrix job PASSes instead of reporting NOT_CONFIGURED', () => fixture(async root => {
        await pullRequest(root, suite, { [suite.spec]: suite.examples });
        const { impact, result, passed } = await runVerifier({ root, base: 'HEAD~1', id: suite.id });
        assert.ok(impact.requiredVerifiers.includes(suite.id));
        assert.deepEqual(result.checks.map(c => [c.id, c.status]), [[suite.id, 'PASS']]);
        assert.equal(passed, true);
        assert.equal((await matrix(root, suite.id)).code, 0);
      }));
      it('when no spec exists then the matrix job FAILs', () => fixture(async root => {
        await pullRequest(root, suite, {});
        const { result, passed } = await runVerifier({ root, base: 'HEAD~1', id: suite.id });
        assert.deepEqual(result.checks.map(c => [c.id, c.status]), [[suite.id, 'FAIL']]);
        assert.equal(passed, false);
        assert.equal((await matrix(root, suite.id)).code, 1);
      }));
      it(`when a spec uses ${suite.skippedMarker} then the matrix job FAILs`, () => fixture(async root => {
        await pullRequest(root, suite, { [suite.spec]: suite.skipped });
        const { result, passed } = await runVerifier({ root, base: 'HEAD~1', id: suite.id });
        assert.deepEqual(result.checks.map(c => [c.id, c.status]), [[suite.id, 'FAIL']]);
        assert.equal(passed, false);
      }));
    });
  }
});
