import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './test-fixture.mjs';
import { inspectAuthnTest, checkAuthnTests } from './authn-tests.mjs';
import { classifySecurity } from './security-enforcement.mjs';
import { execute } from './io.mjs';

const config = JSON.parse(await readFile(new URL('../../.harness/config/harness.json', import.meta.url), 'utf8'));
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
const script = 'tools/harness/authn-tests.mjs';
const authnVerifiers = ['rails-authn-test', 'admin-authn-test', 'mobile-authn-test', 'api-schema-authn-check'];
const test = body => `import { describe, expect, it } from 'vitest';\n\ndescribe('sign in', () => {\n${body}\n});\n`;
const examples = test("  it('rejects a wrong password', () => {\n    expect(signIn('x')).toBe(false);\n  });");
const write = async (root, path, content) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); };

describe('Authentication test static inspection for admin and mobile (#165)', () => {
  describe('given an authentication test whose examples all run', () => {
    it('when inspected then reports nothing', () => assert.deepEqual(inspectAuthnTest(examples), []));
  });
  describe('given an authentication test that skips, focuses or leaves an example undone', () => {
    for (const [marker, line] of [
      ['it.skip', "it.skip('rejects', () => {});"], ['test.skip', "test.skip('rejects', () => {});"], ['describe.skip', "describe.skip('sign in', () => {});"],
      ['it.only', "it.only('rejects', () => {});"], ['test.only', "test.only('rejects', () => {});"], ['describe.only', "describe.only('sign in', () => {});"],
      ['it.todo', "it.todo('rejects');"], ['test.todo', "test.todo('rejects');"], ['it.skipIf', "it.skipIf(ci)('rejects', () => {});"],
      ['it.runIf', "it.runIf(ci)('rejects', () => {});"], ['it.failing', "it.failing('rejects', () => {});"], ['it.fails', "it.fails('rejects', () => {});"],
      ['it.concurrent.skip', "it.concurrent.skip('rejects', () => {});"], ['xit', "xit('rejects', () => {});"], ['xtest', "xtest('rejects', () => {});"],
      ['xdescribe', "xdescribe('sign in', () => {});"], ['fit', "fit('rejects', () => {});"], ['fdescribe', "fdescribe('sign in', () => {});"],
    ]) {
      it(`when it uses ${marker} then reports ${marker} with its line number`, () => {
        assert.deepEqual(inspectAuthnTest(test(`  ${line}`)), [{ line: 4, marker }]);
      });
    }
  });
  describe('given a marker that appears only in a comment', () => {
    it('when inspected then does not report it', () => assert.deepEqual(inspectAuthnTest(test('  // it.skip is never used here')), []));
  });
});

for (const [app, path] of [['admin', 'apps/admin/src/features/auth/signIn.authn.test.tsx'], ['mobile', 'apps/mobile/src/features/auth/signIn.authn.test.ts']]) {
  describe(`Authentication tests of ${app} (#165)`, () => {
    describe(`given the ${app} sources of a repository`, () => {
      it('when no *.authn.test file exists then FAILs instead of passing an authentication change unverified', () => fixture(async root => {
        const result = await checkAuthnTests({ root, app });
        assert.equal(result.status, 'FAIL');
        assert.match(result.errors.join('\n'), new RegExp(`apps/${app}/src`));
      }));
      it('when only ordinary tests exist then still FAILs, because they are not the authentication tests', () => fixture(async root => {
        await write(root, path.replace('.authn.test', '.test'), examples);
        assert.equal((await checkAuthnTests({ root, app })).status, 'FAIL');
      }));
      it('when an authentication test exists only under node_modules then still FAILs', () => fixture(async root => {
        await write(root, `apps/${app}/src/node_modules/pkg/signIn.authn.test.ts`, examples);
        assert.equal((await checkAuthnTests({ root, app })).status, 'FAIL');
      }));
      it('when an authentication test sits next to its code and every example runs then PASSes', () => fixture(async root => {
        await write(root, path, examples);
        assert.deepEqual(await checkAuthnTests({ root, app }), { status: 'PASS', tests: [path], findings: [], errors: [] });
      }));
      it('when an authentication test skips an example then FAILs and names the file, line and marker', () => fixture(async root => {
        await write(root, path, test("  it.skip('rejects', () => {});"));
        const result = await checkAuthnTests({ root, app });
        assert.equal(result.status, 'FAIL');
        assert.deepEqual(result.findings, [{ path, line: 4, marker: 'it.skip' }]);
      }));
    });
    describe('given the command line entry point', () => {
      it('when no authentication test exists then exits non-zero', () => fixture(async root => {
        const result = await execute(process.execPath, [script, app], { cwd: root });
        assert.equal(result.code, 1);
        assert.match(result.stdout + result.stderr, new RegExp(`apps/${app}/src`));
      }));
      it(`when it runs from apps/${app}, as the verifier does, and a test exists then exits zero`, () => fixture(async root => {
        await write(root, path, examples);
        assert.equal((await execute(process.execPath, [`../../${script}`, app], { cwd: join(root, `apps/${app}`) })).code, 0);
      }));
    });
    describe(`given the shipped ${app}-authn-test Security Verifier`, () => {
      const verifier = config.securityVerifiers.find(v => v.id === `${app}-authn-test`);
      it('when it is looked up then it runs in the container from the app directory', () => {
        assert.ok(verifier?.commands.length > 0);
        assert.equal(verifier.directory, `apps/${app}`);
        assert.equal(verifier.isolation, undefined);
      });
      it('when its commands run then the static check comes before the test runner, which runs only the authentication tests and fails on none', () => {
        const commands = verifier.commands.map(c => c.join(' '));
        const check = commands.indexOf(`node ../../${script} ${app}`);
        const runner = app === 'admin'
          ? commands.indexOf('pnpm exec vitest run .authn.test. --passWithNoTests=false')
          : commands.indexOf('pnpm exec jest --testPathPatterns \\.authn\\.test\\.tsx?$ --passWithNoTests=false');
        assert.ok(check >= 0 && runner > check, commands.join(' | '));
        assert.equal(commands.some(c => /--passWithNoTests(?!=false)/.test(c)), false);
      });
    });
    describe(`given a change to the authentication of ${app}`, () => {
      const result = classifySecurity({ files: [{ path: `apps/${app}/src/features/auth/index.ts`, status: 'A', added: 'export const signIn = () => null;' }], sbi: {} }, policy);
      it(`when classified then requires ${app}-authn-test and no other authentication verifier`, () => {
        assert.deepEqual(authnVerifiers.filter(id => result.requiredVerifiers.includes(id)), [`${app}-authn-test`]);
      });
    });
  });
}

describe('Authentication of prototypes (#165)', () => {
  describe('given a prototype change that matches SEC-AUTH-001', () => {
    const result = classifySecurity({ files: [{ path: 'prototypes/web/src/auth/login.ts', status: 'A', added: 'export const signIn = () => null;' }], sbi: {} }, policy);
    it('when classified then requires no authentication verifier', () => {
      assert.ok(result.matchedRules.includes('SEC-AUTH-001'));
      assert.deepEqual(authnVerifiers.filter(id => result.requiredVerifiers.includes(id)), []);
    });
    it('when classified then still stops at the gate with LEVEL 3 and two approvals', () => {
      assert.equal(result.requiresPreImplementationGate, true);
      assert.equal(result.minimumRiskLevel, 3);
      assert.equal(result.requiredHumanApprovals, 2);
    });
  });
});

describe('Authentication verifiers an SBI declaration requires (#165)', () => {
  const declare = (allowedFiles, files = []) => classifySecurity({ files, sbi: { securityImpact: ['AuthN'], allowedFiles } }, policy);
  const authn = result => authnVerifiers.filter(id => result.requiredVerifiers.includes(id));
  describe('given an SBI that declares the AuthN impact', () => {
    it('when its allowed files are in the API then requires only rails-authn-test', () => {
      assert.deepEqual(authn(declare(['apps/api/app/controllers/sessions_controller.rb'])), ['rails-authn-test']);
    });
    it('when its allowed files are in admin and the OpenAPI contract then requires admin-authn-test and api-schema-authn-check', () => {
      assert.deepEqual(authn(declare(['apps/admin/src/features/login/index.tsx', 'packages/api-schema/openapi.yaml'])), ['admin-authn-test', 'api-schema-authn-check']);
    });
    it('when the changed files reach mobile beyond its allowed files then also requires mobile-authn-test', () => {
      assert.deepEqual(authn(declare(['apps/api/app/models/user.rb'], [{ path: 'apps/mobile/src/session.ts', status: 'M', added: 'export {};' }])), ['rails-authn-test', 'mobile-authn-test']);
    });
    it('when it only touches docs then requires no authentication verifier but keeps the gate, LEVEL 3 and two approvals', () => {
      const result = declare(['docs/security/authorization.md']);
      assert.deepEqual(authn(result), []);
      assert.equal(result.requiresPreImplementationGate, true);
      assert.equal(result.minimumRiskLevel, 3);
      assert.equal(result.requiredHumanApprovals, 2);
    });
  });
});
