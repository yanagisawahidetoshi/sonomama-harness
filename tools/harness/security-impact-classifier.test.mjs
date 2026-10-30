import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifySecurity, verifySecurity } from './security-enforcement.mjs';
// This file is the classifier's own fixture: it must spell out the strings the content patterns detect.
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
const assess = files => classifySecurity({ files, sbi: {} }, policy);
const detected = (result, ruleId) => result.matchedRules.includes(ruleId);

describe('Security Impact Classifier on Markdown citations', () => {
  describe('given a Markdown document that names security files and rule IDs', () => {
    const doc = added => assess([{ path: 'docs/adr/0002-foo.md', status: 'A', added }]);
    it('when it links to authorization.md then does not require the authorization test', () => {
      const result = doc('- 詳しくは[authorization.md](../security/authorization.md)と`docs/security/authorization.md`を見る。');
      assert.equal(detected(result, 'SEC-AUTHZ-001'), false);
      assert.equal(result.requiredVerifiers.includes('rails-authz-test'), false);
    });
    it('when it cites the role rule ID then does not match the role rule', () => {
      const result = doc('- 実装はSEC-AUTH-001とSEC-ROLE-001の対象になる。');
      assert.equal(detected(result, 'SEC-ROLE-001'), false);
      assert.equal(result.requiredVerifiers.includes('rails-authz-test'), false);
    });
    it('when its prose describes authorization then still classifies it as AuthZ', () => {
      const result = doc('This endpoint requires authorization.');
      assert.ok(detected(result, 'SEC-AUTHZ-001'));
    });
    it('when it mentions user.email then still classifies it as PII', () => {
      const result = doc('登録時に`user.email`を保存する。');
      assert.ok(detected(result, 'SEC-PII-001'));
      assert.ok(result.requiredVerifiers.includes('pii-log-check'));
    });
  });
});

describe('Security Impact Classifier on its own implementation and fixture', () => {
  const samples = ['// requires authorization', "it('cites SEC-ROLE-001')", 'logger.info(user.email)'];
  describe('given the classifier implementation or this fixture adds detected strings', () => {
    for (const path of ['tools/harness/security-enforcement.mjs', 'tools/harness/security-impact-classifier.test.mjs']) {
      it(`when ${path} changes then content patterns infer no AuthZ, role or PII impact`, () => {
        const result = assess([{ path, status: 'M', added: samples.join('\n') }]);
        for (const ruleId of ['SEC-AUTHZ-001', 'SEC-ROLE-001', 'SEC-PII-001', 'SEC-LOG-001']) assert.equal(detected(result, ruleId), false, ruleId);
        assert.equal(result.requiredVerifiers.includes('rails-authz-test'), false);
        assert.equal(result.requiredVerifiers.includes('pii-log-check'), false);
      });
      it(`when ${path} changes then path rules and always-required checks still apply`, () => {
        const result = assess([{ path, status: 'M', added: samples.join('\n') }]);
        assert.ok(detected(result, 'SEC-CONFIG-001'));
        assert.ok(result.requiredVerifiers.includes('secret-scan'));
        assert.ok(result.requiredVerifiers.includes('forbidden-pattern-check'));
      });
    }
  });
  describe('given other files add the same strings', () => {
    it('when another Harness test adds them then still requires the authorization and PII log checks', () => {
      const result = assess([{ path: 'tools/harness/impact.test.mjs', status: 'M', added: samples.join('\n') }]);
      assert.ok(detected(result, 'SEC-AUTHZ-001'));
      assert.ok(result.requiredVerifiers.includes('pii-log-check'));
    });
    it('when production code logs user.email then still requires the PII log check', () => {
      const result = assess([{ path: 'apps/api/app/models/user.rb', status: 'M', added: 'logger.info(user.email)' }]);
      assert.ok(detected(result, 'SEC-LOG-001'));
      assert.ok(result.requiredVerifiers.includes('pii-log-check'));
    });
    it('when production code names authorization.md then still requires the authorization test', () => {
      const result = assess([{ path: 'apps/api/lib/policy_docs.rb', status: 'A', added: "POLICY = 'docs/security/authorization.md'" }]);
      assert.ok(detected(result, 'SEC-AUTHZ-001'));
    });
  });
});

describe('Security Impact Classifier on the scope of application security verifiers', () => {
  const applicationVerifiers = ['authn-test', 'rails-authz-test', 'rails-rls-test', 'migration-safety', 'data-lifecycle-test'];
  describe('given an ADR whose prose describes AuthN, AuthZ, RLS, roles, schema, retention or the production API', () => {
    for (const [ruleId, verifier, prose] of [
      ['SEC-AUTH-001', 'authn-test', 'Users authenticate with Cognito.'],
      ['SEC-AUTHZ-001', 'rails-authz-test', 'This endpoint requires authorization.'],
      ['SEC-RLS-001', 'rails-rls-test', 'Tenants are isolated with ROW LEVEL SECURITY.'],
      ['SEC-ROLE-001', 'rails-authz-test', 'Each member has a role_id.'],
      ['SEC-SCHEMA-001', 'migration-safety', 'We will CREATE TABLE invitations.'],
      ['SEC-LIFECYCLE-001', 'data-lifecycle-test', 'Invitations follow the retention policy.'],
      ['SEC-DESTRUCTIVE-001', 'data-lifecycle-test', '招待は本番APIで発行する。'],
    ]) {
      it(`when ${ruleId} matches the prose then keeps the gate, LEVEL 3 and two approvals without requiring ${verifier}`, () => {
        const result = assess([{ path: 'docs/adr/0002-foo.md', status: 'A', added: prose }]);
        assert.ok(detected(result, ruleId));
        assert.equal(result.securitySensitive, true);
        assert.equal(result.requiresPreImplementationGate, true);
        assert.equal(result.minimumRiskLevel, 3);
        assert.equal(result.requiredHumanApprovals, 2);
        assert.equal(result.requiredVerifiers.includes(verifier), false);
      });
    }
    it('when it changes then still requires secret-scan and forbidden-pattern-check', () => {
      const result = assess([{ path: 'docs/adr/0002-foo.md', status: 'A', added: 'This endpoint requires authorization.' }]);
      assert.ok(result.requiredVerifiers.includes('secret-scan'));
      assert.ok(result.requiredVerifiers.includes('forbidden-pattern-check'));
    });
    it('when an unrelated API file changes in the same diff then still does not require the authorization test', () => {
      const result = assess([
        { path: 'docs/adr/0002-foo.md', status: 'A', added: 'This endpoint requires authorization.' },
        { path: 'apps/api/app/models/lesson.rb', status: 'M', added: 'class Lesson; end' },
      ]);
      assert.equal(result.requiredVerifiers.includes('rails-authz-test'), false);
    });
    it('when the SBI declares the AuthZ impact then still requires the authorization test', () => {
      const result = classifySecurity({ files: [{ path: 'docs/adr/0002-foo.md', status: 'A', added: 'This endpoint requires authorization.' }], sbi: { securityImpact: ['AuthZ'] } }, policy);
      assert.ok(result.requiredVerifiers.includes('rails-authz-test'));
    });
  });
  describe('given a change to the authorization implementation of the API', () => {
    const files = [{ path: 'apps/api/app/policies/lesson_policy.rb', status: 'A', added: 'def update? = authorize(user, :update)' }];
    it('when classified then requires the authorization test', () => {
      assert.ok(assess(files).requiredVerifiers.includes('rails-authz-test'));
    });
    it('when the policy is moved out of the API then still requires the authorization test', () => {
      const moved = [{ path: 'docs/lesson_policy.rb', previousPath: files[0].path, status: 'R', deleted: files[0].added }];
      assert.ok(assess(moved).requiredVerifiers.includes('rails-authz-test'));
    });
    it('when the authorization test is not configured then Security reports NOT_CONFIGURED and fails', async () => {
      const evidence = await verifySecurity({ workspace: '.', sbi: {}, assessment: assess(files), policy, config: { securityVerifiers: [] }, headSha: 'a'.repeat(40), changed: files.map(f => ({ path: f.path, text: f.added })) });
      assert.equal(evidence.checks.find(c => c.id === 'rails-authz-test').status, 'NOT_CONFIGURED');
      assert.equal(evidence.status, 'FAIL');
    });
  });
  describe('given changes to application code paths', () => {
    for (const [path, added, verifier] of [
      ['apps/api/app/models/membership.rb', 'belongs_to :role_id', 'rails-authz-test'],
      ['apps/api/db/rls.sql', 'CREATE POLICY tenant ON lessons', 'rails-rls-test'],
      ['apps/admin/db/migrate/001_lessons.rb', 'class Lessons; end', 'migration-safety'],
      ['apps/mobile/src/features/auth/index.ts', 'export const signIn = () => null;', 'authn-test'],
      ['prototypes/web/src/auth/login.ts', 'export const signIn = () => null;', 'authn-test'],
      ['apps/api/app/jobs/purge_job.rb', 'Lesson.destroy_all', 'data-lifecycle-test'],
    ]) {
      it(`when ${path} changes then requires ${verifier}`, () => {
        assert.ok(assess([{ path, status: 'A', added }]).requiredVerifiers.includes(verifier));
      });
    }
  });
  describe('given the builtin security verifiers', () => {
    it('when the policy is read then none of them is limited to a path', () => {
      for (const v of policy.verifiers.filter(v => v.kind !== 'command')) assert.equal(v.appliesTo, undefined, v.id);
    });
    it('when the policy is read then every command verifier a rule requires names the paths it applies to', () => {
      for (const id of applicationVerifiers) assert.ok(policy.verifiers.find(v => v.id === id).appliesTo?.length, id);
    });
  });
});

describe('Security Impact Classifier on OpenAPI structure names in the API contract test support', () => {
  const contract = 'apps/api/spec/support/api_contract/unsupported.rb';
  const names = 'requestBodies securitySchemes links callbacks content paths';
  describe('given the contract test support lists OpenAPI structure names as identifiers', () => {
    it('when unsupported.rb adds securitySchemes to the list then does not match SEC-AUTH-001 or require the authentication test', () => {
      const result = assess([{ path: contract, status: 'M', added: names }]);
      assert.equal(detected(result, 'SEC-AUTH-001'), false);
      assert.equal(result.requiredVerifiers.includes('authn-test'), false);
    });
    it('when the list is removed then still does not match SEC-AUTH-001', () => {
      assert.equal(detected(assess([{ path: contract, status: 'M', deleted: names }]), 'SEC-AUTH-001'), false);
    });
    it('when it changes then always-required checks still apply', () => {
      const result = assess([{ path: contract, status: 'M', added: names }]);
      assert.ok(result.requiredVerifiers.includes('secret-scan'));
      assert.ok(result.requiredVerifiers.includes('forbidden-pattern-check'));
    });
  });
  describe('given the contract test support adds other authentication keywords', () => {
    for (const added of ["headers['Authorization'] = \"Bearer #{jwt}\"", 'components.dig("securitySchemes", "bearerAuth")', 'before { authenticate(user) }']) {
      it(`when it adds ${added} then still matches SEC-AUTH-001`, () => {
        assert.ok(detected(assess([{ path: contract, status: 'M', added }]), 'SEC-AUTH-001'));
      });
    }
    it('when a support file is named after authentication then still matches SEC-AUTH-001 by its path', () => {
      assert.ok(detected(assess([{ path: 'apps/api/spec/support/api_contract/auth_headers.rb', status: 'A', added: names }]), 'SEC-AUTH-001'));
    });
    it('when it adds authorization then still matches SEC-AUTHZ-001', () => {
      assert.ok(detected(assess([{ path: contract, status: 'M', added: '# requires authorization' }]), 'SEC-AUTHZ-001'));
    });
  });
  describe('given the same structure names outside the contract test support', () => {
    for (const path of ['apps/api/app/controllers/application_controller.rb', 'apps/api/spec/requests/lessons_spec.rb', 'apps/api/spec/support/api_contract_spec.rb', 'apps/api/spec/fixtures/api_contract/students.yaml']) {
      it(`when ${path} adds them then still matches SEC-AUTH-001`, () => {
        assert.ok(detected(assess([{ path, status: 'M', added: names }]), 'SEC-AUTH-001'));
      });
    }
    it('when the list is moved out of the contract test support then still matches SEC-AUTH-001', () => {
      const moved = [{ path: 'apps/api/app/lib/openapi_names.rb', previousPath: contract, status: 'R', added: names, deleted: names }];
      assert.ok(detected(assess(moved), 'SEC-AUTH-001'));
    });
    it('when it is moved into the contract test support then still matches SEC-AUTH-001', () => {
      const moved = [{ path: contract, previousPath: 'apps/api/app/lib/openapi_names.rb', status: 'R', added: names, deleted: names }];
      assert.ok(detected(assess(moved), 'SEC-AUTH-001'));
    });
  });
  describe('given a change to the authentication of the API', () => {
    for (const [path, added] of [
      ['apps/api/app/controllers/application_controller.rb', 'before_action :authenticate'],
      ['apps/api/app/controllers/concerns/authentication.rb', 'module Authentication; end'],
      ['packages/api-schema/openapi.yaml', 'components:\n  securitySchemes:\n    bearerAuth:\n      type: http\n      scheme: bearer'],
      ['packages/api-schema/openapi.yaml', 'security:\n  - bearerAuth: []'],
    ]) {
      it(`when ${path} adds ${added.split('\n').at(-1).trim()} then matches SEC-AUTH-001 and requires the authentication test`, () => {
        const result = assess([{ path, status: 'M', added }]);
        assert.ok(detected(result, 'SEC-AUTH-001'));
        assert.ok(result.requiredVerifiers.includes('authn-test'));
      });
    }
    it('when openapi.yaml removes the bearer requirement then matches SEC-AUTH-001', () => {
      assert.ok(detected(assess([{ path: 'packages/api-schema/openapi.yaml', status: 'M', deleted: 'security:\n  - bearerAuth: []', added: 'security: []' }]), 'SEC-AUTH-001'));
    });
  });
  describe('given the security policy', () => {
    it('when it is read then only SEC-AUTH-001 ignores content in the contract test support, and only the securitySchemes name', () => {
      for (const rule of policy.rules.filter(r => r.id !== 'SEC-AUTH-001')) assert.equal(rule.contentExceptions, undefined, rule.id);
      assert.deepEqual(policy.rules.find(r => r.id === 'SEC-AUTH-001').contentExceptions, [{ pathPatterns: ['^apps/api/spec/support/api_contract/'], ignoredPatterns: ['\\bsecuritySchemes\\b'] }]);
    });
  });
});
