import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifySecurity, verifySecurity } from './security-enforcement.mjs';
import { securityPolicySchema } from './schemas.mjs';
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
  const applicationVerifiers = ['authn-test', 'admin-authn-test', 'mobile-authn-test', 'rails-authz-test', 'rails-rls-test', 'migration-safety', 'data-lifecycle-test'];
  describe('given an ADR whose prose describes AuthN, AuthZ, RLS, roles, schema, retention or the production API', () => {
    for (const [ruleId, verifier, prose] of [
      ['SEC-AUTH-001', 'authn-test', 'Users authenticate with Cognito.'],
      ['SEC-AUTHZ-001', 'rails-authz-test', 'This endpoint requires authorization.'],
      ['SEC-RLS-001', 'rails-rls-test', 'Tenants are isolated with ROW LEVEL SECURITY.'],
      ['SEC-ROLE-001', 'rails-authz-test', 'Each member has a role_id.'],
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
    // An ordinary schema change is detected and asks for one review; only a destructive operation reaches LEVEL 3 (#157).
    it('when SEC-SCHEMA-001 matches the prose then asks for one review without requiring migration-safety', () => {
      const result = assess([{ path: 'docs/adr/0002-foo.md', status: 'A', added: 'We will CREATE TABLE invitations.' }]);
      assert.ok(detected(result, 'SEC-SCHEMA-001'));
      assert.equal(result.securitySensitive, true);
      assert.equal(result.requiresPreImplementationGate, false);
      assert.equal(result.minimumRiskLevel, 2);
      assert.equal(result.requiredHumanApprovals, 1);
      assert.equal(result.requiredVerifiers.includes('migration-safety'), false);
    });
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
    // #165: a rule the SBI declares keeps its gate, LEVEL and approvals, but only a changed path in a verifier's appliesTo requires that verifier.
    it('when the SBI declares the AuthZ impact but changes only an ADR then keeps the gate, LEVEL 3 and two approvals without requiring the authorization test', () => {
      const result = classifySecurity({ files: [{ path: 'docs/adr/0002-foo.md', status: 'A', added: 'This endpoint requires authorization.' }], sbi: { securityImpact: ['AuthZ'] } }, policy);
      assert.ok(detected(result, 'SEC-AUTHZ-001'));
      assert.equal(result.requiresPreImplementationGate, true);
      assert.equal(result.minimumRiskLevel, 3);
      assert.equal(result.requiredHumanApprovals, 2);
      assert.equal(result.requiredVerifiers.includes('rails-authz-test'), false);
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
      ['apps/api/app/controllers/sessions_controller.rb', 'before_action :authenticate_user!', 'authn-test'],
      ['apps/admin/src/features/auth/index.ts', 'export const signIn = () => null;', 'admin-authn-test'],
      ['apps/mobile/src/features/auth/index.ts', 'export const signIn = () => null;', 'mobile-authn-test'],
      ['apps/api/app/jobs/purge_job.rb', 'Lesson.destroy_all', 'data-lifecycle-test'],
    ]) {
      it(`when ${path} changes then requires ${verifier}`, () => {
        assert.ok(assess([{ path, status: 'A', added }]).requiredVerifiers.includes(verifier));
      });
    }
  });
  describe('given authentication changes of one application (#165)', () => {
    const authn = ['authn-test', 'admin-authn-test', 'mobile-authn-test'];
    const required = result => authn.filter(id => result.requiredVerifiers.includes(id));
    for (const [path, verifier] of [
      ['apps/api/app/controllers/concerns/authentication.rb', 'authn-test'],
      ['apps/admin/src/features/auth/hooks/useSignIn.ts', 'admin-authn-test'],
      ['apps/mobile/src/features/auth/hooks/useSignIn.ts', 'mobile-authn-test'],
    ]) {
      it(`when only ${path} changes then requires ${verifier} and no authentication test of another application`, () => {
        assert.deepEqual(required(assess([{ path, status: 'A', added: 'export const signIn = () => null;' }])), [verifier]);
      });
    }
    it('when a prototype changes its login then keeps SEC-AUTH-001 with the gate, LEVEL 3 and two approvals without requiring an application authentication test', () => {
      const result = assess([{ path: 'prototypes/web/src/auth/login.ts', status: 'A', added: 'export const signIn = () => null;' }]);
      assert.ok(detected(result, 'SEC-AUTH-001'));
      assert.equal(result.requiresPreImplementationGate, true);
      assert.equal(result.minimumRiskLevel, 3);
      assert.equal(result.requiredHumanApprovals, 2);
      assert.deepEqual(required(result), []);
    });
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

describe('Security Impact Classifier on the verifiers a rule declared by the SBI requires (#165)', () => {
  const authn = ['authn-test', 'admin-authn-test', 'mobile-authn-test'];
  const required = result => authn.filter(id => result.requiredVerifiers.includes(id));
  const admin = [{ path: 'apps/admin/src/features/home/HomePage/index.tsx', status: 'M', added: 'export const HomePage = () => null;' }];
  const keepsGate = result => {
    assert.equal(result.requiresPreImplementationGate, true);
    assert.equal(result.minimumRiskLevel, 3);
    assert.equal(result.requiredHumanApprovals, 2);
  };
  for (const [source, sbi] of [
    ['requiredSecurityRules', { requiredSecurityRules: ['SEC-AUTH-001'] }],
    ['securityImpact', { securityImpact: ['AuthN'] }],
    ['the SBI text', { title: '管理画面のログイン画面', acceptanceCriteria: [{ id: 'AC-1', description: '管理者は認証してから一覧を見る' }] }],
  ]) {
    describe(`given an SBI that brings SEC-AUTH-001 by ${source}`, () => {
      it('when it changes only the admin then requires the admin authentication test and not the API or mobile ones', () => {
        const result = classifySecurity({ files: admin, sbi }, policy);
        assert.ok(detected(result, 'SEC-AUTH-001'));
        keepsGate(result);
        assert.deepEqual(required(result), ['admin-authn-test']);
      });
      it('when no changed path is known yet then requires every authentication test, failing closed', () => {
        const result = classifySecurity({ files: [], sbi }, policy);
        assert.ok(detected(result, 'SEC-AUTH-001'));
        keepsGate(result);
        assert.deepEqual(required(result), authn);
      });
    });
  }
  describe('given an SBI that declares RLS', () => {
    it('when it changes only the admin then keeps the gate without requiring the RLS test', () => {
      const result = classifySecurity({ files: admin, sbi: { securityImpact: ['RLS'] } }, policy);
      keepsGate(result);
      assert.equal(result.requiredVerifiers.includes('rails-rls-test'), false);
    });
    it('when it changes the API then requires the RLS test', () => {
      const result = classifySecurity({ files: [{ path: 'apps/api/app/models/lesson.rb', status: 'M', added: 'class Lesson; end' }], sbi: { securityImpact: ['RLS'] } }, policy);
      assert.ok(result.requiredVerifiers.includes('rails-rls-test'));
    });
  });
  // The detector does not read 「変更を加えない」 as out of scope, and no approval replaces the test: the text match stays fail-closed.
  describe('given an SBI whose text alone matches SEC-DESTRUCTIVE-001 by naming the production API', () => {
    const sbi = { title: '管理画面の一覧', description: '本番APIには変更を加えない', acceptanceCriteria: [] };
    for (const [name, files] of [
      ['changes only the admin', admin],
      ['changes only a document outside every appliesTo', [{ path: 'docs/product/lessons.md', status: 'M', added: '一覧の並び順' }]],
      ['changes the API', [{ path: 'apps/api/app/models/lesson.rb', status: 'M', added: 'class Lesson; end' }]],
      ['has no changed path known yet', []],
    ]) {
      it(`when it ${name} then still requires the data lifecycle test with the gate, LEVEL 3 and two approvals`, () => {
        const result = classifySecurity({ files, sbi }, policy);
        assert.ok(detected(result, 'SEC-DESTRUCTIVE-001'));
        keepsGate(result);
        assert.ok(result.requiredVerifiers.includes('data-lifecycle-test'));
      });
    }
  });
  describe('given an SBI that names a verifier in requiredVerifiers', () => {
    it('when it changes only the admin then still requires that verifier', () => {
      assert.ok(classifySecurity({ files: admin, sbi: { requiredVerifiers: ['authn-test'] } }, policy).requiredVerifiers.includes('authn-test'));
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
    for (const [path, added] of [
      ['apps/api/spec/support/api_contract/openapi.yaml', 'components:\n  securitySchemes:\n    ApiKey:\n      type: apiKey'],
      ['apps/api/spec/support/api_contract/names.json', '["requestBodies", "securitySchemes", "links"]'],
      ['apps/api/spec/support/api_contract/nested/names.rb', names],
    ]) {
      it(`when the contract test support adds them in ${path} then still matches SEC-AUTH-001`, () => {
        assert.ok(detected(assess([{ path, status: 'A', added }]), 'SEC-AUTH-001'));
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
    it('when it is read then only SEC-AUTH-001 has content exceptions: the securitySchemes name in the contract test support, its words in legacy SBIs and Trusted Acceptance, and only the known Harness contexts (#177)', () => {
      for (const rule of policy.rules.filter(r => r.id !== 'SEC-AUTH-001')) assert.equal(rule.contentExceptions, undefined, rule.id);
      const auth = policy.rules.find(r => r.id === 'SEC-AUTH-001');
      assert.deepEqual(auth.contentExceptions, [
        { pathPatterns: ['^apps/api/spec/support/api_contract/[^/]+\\.rb$'], ignoredPatterns: ['\\bsecuritySchemes\\b'] },
        { pathPatterns: ['^\\.harness/state/sbi-(?!\\d+\\.json$)[^/]+\\.json$', '^\\.harness/verification/(lib/)?[^/]+\\.mjs$'], ignoredPatterns: auth.contentPatterns, ignoreCase: true },
        { pathPatterns: ['^tools/harness/[^/]+\\.mjs$'], ignoredPatterns: harnessContexts },
      ]);
    });
    it('when it is read then only SEC-AUTH-001 ignores the words of a legacy SBI', () => {
      for (const rule of policy.rules) assert.equal(rule.ignoreLegacySbiMetadata, rule.id === 'SEC-AUTH-001' ? true : undefined, rule.id);
    });
    for (const [field, pattern] of [['ignoredPatterns', '[\\s\\S]*'], ['ignoredPatterns', ''], ['pathPatterns', '^'], ['pathPatterns', '.*']]) {
      it(`when a content exception has ${field} ${JSON.stringify(pattern)} that matches empty text then rejects the policy`, () => {
        const exception = { pathPatterns: ['^apps/api/spec/support/api_contract/[^/]+\\.rb$'], ignoredPatterns: ['\\bsecuritySchemes\\b'], [field]: [pattern] };
        const broken = { ...policy, rules: policy.rules.map(r => r.id === 'SEC-AUTH-001' ? { ...r, contentExceptions: [exception] } : r) };
        assert.throws(() => securityPolicySchema.parse(broken));
      });
    }
    for (const ignoreCase of ['true', 1, null]) {
      it(`when a content exception sets ignoreCase to ${JSON.stringify(ignoreCase)} instead of a boolean then rejects the policy`, () => {
        const exception = { pathPatterns: ['^apps/api/spec/support/api_contract/[^/]+\\.rb$'], ignoredPatterns: ['\\bsecuritySchemes\\b'], ignoreCase };
        const broken = { ...policy, rules: policy.rules.map(r => r.id === 'SEC-AUTH-001' ? { ...r, contentExceptions: [exception] } : r) };
        assert.throws(() => securityPolicySchema.parse(broken));
      });
    }
  });
});

// The known Harness contexts where an authenticate-prefixed word names the Harness's own approvals, gh login or OpenAPI reading, not an AuthN change.
const harnessContexts = [
  '\\bauthenticatedRecords\\b', '\\bGitHub authenticates\\b', '\\bthe authenticated gh CLI\\b', '\\bauthenticated (local )?ledger\\b',
  '\\b[Aa]uthenticated human\\b', '\\btest-authenticated-adapter\\b', '\\bauthenticated (and authorized )?(endpoints?|response)\\b',
  '\\.authenticated\\b', '\\bauthenticated(?=: )', '\\b(becomes|keeping it) authenticated\\b',
];

describe('Security Impact Classifier on authentication filters named with the authenticate prefix', () => {
  const controller = 'apps/api/app/controllers/application_controller.rb';
  describe('given a Rails authentication filter or helper whose name starts with authenticate', () => {
    for (const [name, change] of [
      ['adds before_action :authenticate_user!', { added: 'before_action :authenticate_user!' }],
      ['removes before_action :authenticate_user!', { deleted: 'before_action :authenticate_user!' }],
      ['changes the filter to authenticate_admin!', { deleted: 'before_action :authenticate_user!', added: 'before_action :authenticate_admin!' }],
      ['adds skip_before_action :authenticate_user!', { added: 'skip_before_action :authenticate_user!, only: :index' }],
      ['adds authenticate_or_request_with_http_token', { added: 'authenticate_or_request_with_http_token { |token| valid?(token) }' }],
      ['adds a check with authenticated?', { added: 'head :unauthorized unless current_user&.authenticated?' }],
    ]) {
      it(`when ${controller} ${name} then matches SEC-AUTH-001 and requires the authentication test`, () => {
        const result = assess([{ path: controller, status: 'M', ...change }]);
        assert.ok(detected(result, 'SEC-AUTH-001'));
        assert.ok(result.requiredVerifiers.includes('authn-test'));
      });
    }
    it('when config/routes.rb adds a Devise authenticated :user block then matches SEC-AUTH-001', () => {
      assert.ok(detected(assess([{ path: 'apps/api/config/routes.rb', status: 'M', added: 'authenticated :user do\n  root to: "lessons#index"\nend' }]), 'SEC-AUTH-001'));
    });
  });
  describe('given the Harness code names its own approvals, gh login or OpenAPI reading with authenticate-prefixed words', () => {
    for (const [path, added] of [
      ['tools/harness/human-approvals.mjs', 'export async function authenticatedRecords(root, runId) {'],
      ['tools/harness/github-approval-records.mjs', '// The CLIs post the line alone, so this costs the human nothing. GitHub authenticates the author.'],
      ['tools/harness/github-pr.mjs', '// Pushes go through local git and API calls through the authenticated gh CLI; this module never handles a token.'],
      ['tools/harness/index.mjs', "  await json(join(directory, 'approvals.json'), { headSha: baselineSha, approvals: [], source: 'authenticated local ledger' });"],
      ['tools/harness/approval-flow.test.mjs', "    it('when the authenticated ledger is altered then refuses all approvals', () => fixture(async root => {"],
      ['tools/harness/pbi-acceptance.mjs', "  if (identity?.kind !== 'human' || !identity.id || !identity.source) throw new Error('Authenticated human identity required');"],
      ['tools/harness/pbi-acceptance.test.mjs', "  describe('given input that is not a decision of an authenticated human', () => {"],
      ['tools/harness/test-fixture.mjs', "export const human = id => () => ({ id, kind: 'human', source: 'test-authenticated-adapter' });"],
      ['tools/harness/api-mock.test.mjs', "  it('when only authenticated endpoints exist then the check passes because at least one endpoint was requested', () => fixture(async root => {"],
      ['tools/harness/api-mock.test.mjs', "  it('when the documented example of an authenticated response breaks its schema then fails with the violation', () => fixture(async root => {"],
      ['tools/harness/api-schema-planner.test.mjs', "    it('when an authenticated and authorized endpoint is removed then the Harness derives AuthN and AuthZ impacts', () => fixture(async root => {"],
      ['tools/harness/api-schema-security.mjs', '      if (old?.authenticated) need(authNImpact, `認証・認可付きのendpointを削除: ${target}`);'],
      ['tools/harness/api-schema-reader.mjs', '      authenticated: (operation.security ?? document.security ?? []).length > 0,'],
      ['tools/harness/api-schema-planner.test.mjs', "    it('when an existing public endpoint becomes authenticated then lists it as a breaking candidate', () => fixture(async root => {"],
      ['tools/harness/api-schema-planner.test.mjs', "    it('when an existing endpoint already requires another scheme name then keeping it authenticated is not a breaking candidate', () => fixture(async root => {"],
    ]) {
      it(`when ${path} adds ${added.trim().slice(0, 60)} then does not match SEC-AUTH-001`, () => {
        assert.equal(detected(assess([{ path, status: 'M', added }]), 'SEC-AUTH-001'), false);
      });
    }
  });
  describe('given an authentication change that the Harness exception must not hide', () => {
    it('when the Harness code adds authenticate_user! then still matches SEC-AUTH-001', () => {
      assert.ok(detected(assess([{ path: 'tools/harness/index.mjs', status: 'M', added: "const filter = 'authenticate_user!';" }]), 'SEC-AUTH-001'));
    });
    it('when the Harness code adds authenticated next to an excluded context then still matches SEC-AUTH-001 for the rest of the line', () => {
      assert.ok(detected(assess([{ path: 'tools/harness/human-approvals.mjs', status: 'M', added: 'const records = await authenticatedRecords(root, runId); if (!authenticated) return;' }]), 'SEC-AUTH-001'));
    });
    for (const path of ['apps/api/app/models/approval.rb', 'packages/shared/src/approvals.ts', 'prototypes/web/src/approvals.ts', 'tools/harness/agents/index.mjs', 'tools/harness/maestro-ci.sh', '.ai/architecture.md']) {
      it(`when ${path} outside the excluded Harness files adds the excluded contexts then still matches SEC-AUTH-001`, () => {
        assert.ok(detected(assess([{ path, status: 'M', added: 'authenticatedRecords: the authenticated local ledger of an authenticated human' }]), 'SEC-AUTH-001'));
      });
    }
    it('when an excluded context moves out of the Harness code then still matches SEC-AUTH-001', () => {
      const moved = [{ path: 'apps/api/app/lib/approvals.rb', previousPath: 'tools/harness/human-approvals.mjs', status: 'R', added: 'authenticatedRecords', deleted: 'authenticatedRecords' }];
      assert.ok(detected(assess(moved), 'SEC-AUTH-001'));
    });
    it('when the excluded context differs in case from the declared one then still matches SEC-AUTH-001', () => {
      assert.ok(detected(assess([{ path: 'tools/harness/index.mjs', status: 'M', added: 'AUTHENTICATEDRECORDS' }]), 'SEC-AUTH-001'));
    });
  });
});

describe('Security Impact Classifier on the security requirement of an OpenAPI document', () => {
  const openapi = 'packages/api-schema/openapi.yaml';
  // Split so this test file's own added lines do not read as an API key assignment to the CI secret content check.
  const otherScheme = `${'Api'}Key`;
  describe('given a security requirement written at the top level or under an operation', () => {
    for (const [name, change] of [
      ['adds an empty top-level security: []', { added: 'security: []' }],
      ['adds an operation-level security: []', { added: '      security: []' }],
      ['adds a block security with a scheme other than bearerAuth', { added: `security:\n  - ${otherScheme}: []` }],
      ['adds an operation-level block security with a scheme other than bearerAuth', { added: `      security:\n        - ${otherScheme}: []` }],
      ['adds an inline security with a scheme other than bearerAuth', { added: `      security: [{ ${otherScheme}: [] }]` }],
      ['removes the top-level security', { deleted: `security:\n  - ${otherScheme}: []` }],
      ['removes an operation-level security: []', { deleted: '      security: []' }],
      ['changes an empty security to a scheme', { deleted: '      security: []', added: `      security: [{ ${otherScheme}: [] }]` }],
      ['adds a security alias', { added: '      security: *default_security' }],
    ]) {
      it(`when ${openapi} ${name} then matches SEC-AUTH-001 and requires the authentication test`, () => {
        const result = assess([{ path: openapi, status: 'M', ...change }]);
        assert.ok(detected(result, 'SEC-AUTH-001'));
        assert.ok(result.requiredVerifiers.includes('authn-test'));
      });
    }
    it('when a JSON OpenAPI document adds "security": [] then matches SEC-AUTH-001', () => {
      assert.ok(detected(assess([{ path: 'apps/api/spec/fixtures/api_contract/students.json', status: 'M', added: '      "security": [],' }]), 'SEC-AUTH-001'));
    });
  });
  describe('given a JavaScript object whose key is named security but whose value is not a requirement list', () => {
    for (const added of ["        security: { status: 'PASS' }, securityVerification: null,", '    security: {', '  security: result, securityVerification: z.looseObject({}),']) {
      it(`when it adds ${added.trim()} then does not match SEC-AUTH-001`, () => {
        assert.equal(detected(assess([{ path: 'tools/harness/health-metrics.mjs', status: 'M', added }]), 'SEC-AUTH-001'), false);
      });
    }
  });
  describe('given only the scheme name changes under an existing security key', () => {
    // Known limitation (#218): the classifier reads changed lines only, so it cannot tell that this list item belongs to security.
    it('when ApiKey is renamed to PartnerKey then does not match SEC-AUTH-001 until #218 compares the parsed documents', () => {
      assert.equal(detected(assess([{ path: openapi, status: 'M', deleted: `        - ${otherScheme}: []`, added: '        - PartnerKey: []' }]), 'SEC-AUTH-001'), false);
    });
  });
});

describe('Security Impact Classifier on a legacy SBI and Trusted Acceptance that only describe authentication (#217)', () => {
  const legacy = { id: 'SBI-API-ENV', title: 'API開発環境', description: '認証Providerの決定とProvider固有実装を分ける', risks: [],
    acceptanceCriteria: [{ id: 'API-AC-18', description: 'JWT / Cognito / Firebase等の認証実装をしていない', verifier: 'api-acceptance' }] };
  const classify = (sbi, legacySbi, files = []) => classifySecurity({ files, sbi, legacySbi }, policy);
  describe('given a legacy hand-written SBI whose words mention 認証', () => {
    it('when it is classified as a legacy SBI then does not match SEC-AUTH-001 or require the authentication test', () => {
      const result = classify(legacy, true);
      assert.equal(detected(result, 'SEC-AUTH-001'), false);
      assert.equal(result.requiredVerifiers.includes('authn-test'), false);
    });
    it('when the same SBI is not a legacy SBI then still matches SEC-AUTH-001 by its words', () => {
      assert.ok(detected(classify(legacy, false), 'SEC-AUTH-001'));
    });
    it('when the legacy SBI declares SEC-AUTH-001 then still matches it and requires the authentication test', () => {
      const result = classify({ ...legacy, requiredSecurityRules: ['SEC-AUTH-001'] }, true);
      assert.ok(detected(result, 'SEC-AUTH-001'));
      assert.ok(result.requiredVerifiers.includes('authn-test'));
    });
    it('when the legacy SBI declares the AuthN impact then still matches SEC-AUTH-001', () => {
      assert.ok(detected(classify({ ...legacy, securityImpact: ['AuthN'] }, true), 'SEC-AUTH-001'));
    });
    it('when its words mention 権限 then still matches SEC-AUTHZ-001, because only SEC-AUTH-001 ignores the words of a legacy SBI', () => {
      assert.ok(detected(classify({ ...legacy, description: '権限を確認する' }, true), 'SEC-AUTHZ-001'));
    });
  });
  describe('given a legacy SBI or Trusted Acceptance adds authentication words', () => {
    for (const path of ['.harness/state/sbi-api-env.json', '.harness/verification/api-env.mjs', '.harness/verification/lib/readme.mjs']) {
      for (const added of ['"description": "JWT / Cognito / Firebase等の認証実装をしていない"', "'Then no JWT, Cognito or Firebase authentication is implemented'", 'bearerAuth oauth2 sign_in authenticate']) {
        it(`when ${path} adds ${added} then does not match SEC-AUTH-001`, () => {
          assert.equal(detected(assess([{ path, status: 'M', added }]), 'SEC-AUTH-001'), false);
        });
      }
    }
    it('when they add authorization then still matches SEC-AUTHZ-001', () => {
      assert.ok(detected(assess([{ path: '.harness/verification/api-env.mjs', status: 'M', added: '// requires authorization' }]), 'SEC-AUTHZ-001'));
    });
    it('when a Trusted Acceptance file is named after authentication then still matches SEC-AUTH-001 by its path', () => {
      assert.ok(detected(assess([{ path: '.harness/verification/auth-env.mjs', status: 'A', added: 'export {};' }]), 'SEC-AUTH-001'));
    });
  });
  describe('given the same words outside legacy SBIs and Trusted Acceptance', () => {
    for (const path of ['.harness/state/sbi-12.json', '.harness/verification/fixtures/api-env.mjs', 'apps/api/app/controllers/application_controller.rb', 'tools/harness/api-env.mjs']) {
      for (const added of ['JWT', 'authentication']) {
        it(`when ${path} adds ${added} then still matches SEC-AUTH-001`, () => {
          assert.ok(detected(assess([{ path, status: 'M', added }]), 'SEC-AUTH-001'));
        });
      }
    }
    it('when a file moves out of Trusted Acceptance with the words then still matches SEC-AUTH-001', () => {
      const moved = [{ path: 'apps/api/app/lib/auth_words.rb', previousPath: '.harness/verification/api-env.mjs', status: 'R', added: 'authentication', deleted: 'authentication' }];
      assert.ok(detected(assess(moved), 'SEC-AUTH-001'));
    });
  });
});

// #157: ordinary infrastructure needs one review; only production infrastructure and a change that turns infrastructure more
// dangerous need two. Only added lines count as the dangerous direction, so narrowing an existing setting stays ordinary.
describe('Security Impact Classifier on infrastructure', () => {
  const infra = (path, added, extra = {}) => assess([{ path, status: 'M', added, deleted: '', ...extra }]);
  const ordinary = result => detected(result, 'SEC-INFRA-001') && !detected(result, 'SEC-PRODINFRA-001') && result.minimumRiskLevel === 2 && result.requiredHumanApprovals === 1;
  const critical = result => detected(result, 'SEC-PRODINFRA-001') && result.minimumRiskLevel === 3 && result.requiredHumanApprovals === 2;
  describe('given an infrastructure change outside production that adds nothing dangerous', () => {
    for (const path of ['live/staging/terragrunt.hcl', 'charts/api/values.yaml', 'cdk/lib/stack.ts', 'infra/staging/main.tf.json', 'environments/staging/main.tf']) {
      it(`when ${path} changes then it is ordinary infrastructure, not level 1`, () => assert.ok(ordinary(infra(path, 'replicas = 2'))));
    }
    it('when the Rails production environment config changes then it is not infrastructure', () => assert.equal(detected(infra('apps/api/config/environments/production.rb', 'config.log_level = :info'), 'SEC-PRODINFRA-001'), false));
    it('when a module is added in staging then it is ordinary infrastructure at level 2 with one review', () => assert.ok(ordinary(infra('infra/staging/network.tf', 'module "vpc" { source = "./vpc" }'))));
    it('when tags change then it is ordinary infrastructure', () => assert.ok(ordinary(infra('terraform/modules/db/main.tf', 'tags = { team = "core" }'))));
    it('when an existing open ingress is narrowed then it stays ordinary', () => assert.ok(ordinary(infra('infra/staging/sg.tf', 'cidr_blocks = ["10.0.0.0/16"]', { deleted: 'cidr_blocks = ["0.0.0.0/0"]' }))));
    it('when an egress rule opens to everywhere then it stays ordinary', () => assert.ok(ordinary(infra('infra/staging/sg.tf', 'egress {\n  from_port = 0\n  cidr_blocks = ["0.0.0.0/0"]\n}'))));
    it('when a non-production directory is named non-prod then it stays ordinary', () => assert.ok(ordinary(infra('infra/non-prod/main.tf', 'replicas = 1'))));
    it('when an ingress description names an egress block then the open ingress is still critical', () => assert.ok(critical(infra('infra/staging/sg.tf', 'ingress {\n  description = "allow egress {"\n  cidr_blocks = ["0.0.0.0/0"]\n}'))));
    it('when a document only mentions a dangerous setting then it is not infrastructure at all', () => assert.equal(detected(infra('docs/product/notes.md', 'Never set force_destroy = true.'), 'SEC-PRODINFRA-001'), false));
  });
  describe('given a change to production infrastructure', () => {
    for (const path of ['infra/production/main.tf', 'terraform/envs/prod/main.tf', 'terraform/envs/prod.tfvars', 'k8s/overlays/production/deployment.yaml', 'deploy/prod/app.yaml',
      'environments/prod/main.tf', 'infra/prd/main.tf', 'live/prod/terragrunt.hcl', 'charts/api/values-production.yaml', '.github/workflows/deploy-production.yml']) {
      it(`when ${path} changes then it is critical at level 3 with two reviews`, () => assert.ok(critical(infra(path, 'replicas = 3'))));
    }
  });
  describe('given an infrastructure change that turns a setting dangerous', () => {
    for (const [name, added] of [
      ['destroy protection is turned off', 'lifecycle { prevent_destroy = false }'],
      ['deletion protection is turned off', 'deletion_protection = false'],
      ['force destroy is turned on', 'force_destroy = true'],
      ['the final snapshot is skipped', 'skip_final_snapshot = true'],
      ['an IAM policy allows every action', 'actions = ["*"]'],
      ['an IAM policy statement allows every resource', '"Resource": "*"'],
      ['an ingress opens to every IPv4 address', 'ingress {\n  from_port = 22\n  cidr_blocks = ["0.0.0.0/0"]\n}'],
      ['an ingress opens to every IPv6 address', 'ipv6_cidr_blocks = ["::/0"]'],
      ['one element of a multi-line IAM list becomes every action', '    "*",'],
      ['an IAM list gains every action after another one', 'actions = ["s3:GetObject", "*"]'],
      ['a YAML policy allows every resource', "Resource: '*'"],
      ['a Kubernetes role allows every resource', 'resources:\n  - "*"'],
      ['CloudFormation turns deletion protection off', 'DeletionProtection: false'],
    ]) {
      it(`when ${name} outside production then it is critical`, () => assert.ok(critical(infra('infra/staging/main.tf', added))));
    }
    for (const [name, deleted] of [
      ['destroy protection is removed', 'lifecycle { prevent_destroy = true }'],
      ['deletion protection is removed', 'deletion_protection = true'],
    ]) {
      it(`when ${name} outside production then it is critical`, () => assert.ok(critical(infra('infra/staging/main.tf', '', { deleted }))));
    }
    it('when deletion protection is turned on then it stays ordinary', () => assert.ok(ordinary(infra('infra/staging/main.tf', 'deletion_protection = true', { deleted: 'deletion_protection = false' }))));
    it('when an infrastructure file is binary then it cannot be inspected and is critical', () => assert.ok(critical(infra('infra/staging/state.bin', '', { binary: true }))));
  });
});

// An SBI that only says a request needs no authentication does not change authentication (#233). Only the Japanese phrasing the Planner
// writes is recognised; an English SBI that names authentication still raises the lane Security Gate (lanes.json). A change that makes an
// existing endpoint public, or that blocks unauthenticated users, still matches, and so does any authentication in the code.
describe('Security Impact Classifier on an SBI that states no authentication is needed', () => {
  const sbi = (description, ac = 'GET /api/v1/health returns 200') => ({ title: 'Health check', description, risks: [], acceptanceCriteria: [{ id: 'AC-1', description: ac }] });
  const classify = (spec, files = []) => classifySecurity({ files, sbi: spec }, policy);
  describe('given an SBI whose text only negates authentication', () => {
    for (const [name, spec] of [
      ['an endpoint that needs no authentication', sbi('Rails API に認証不要の GET /api/v1/health を実装する。')],
      ['a request without an authentication header', sbi('疎通確認を実装する。', '認証ヘッダや Cookie を付けないリクエストでも HTTP 200 が返る')],
      ['a client that has no authentication header', sbi('疎通確認を実装する。', '認証ヘッダも Cookie も持たないクライアントでも 200 が返る')],
      ['an unauthenticated client that can reach it', sbi('未認証クライアントが疎通確認できる。')],
    ]) {
      it(`when it describes ${name} then does not match SEC-AUTH-001`, () => assert.equal(detected(classify(spec), 'SEC-AUTH-001'), false));
    }
  });
  describe('given an SBI or code that changes authentication', () => {
    for (const [name, spec] of [
      ['making an existing endpoint public', sbi('既存の GET /api/v1/courses を認証不要にする。')],
      ['blocking unauthenticated users', sbi('未認証ユーザーは 401 を返す。')],
      ['letting unauthenticated clients call an existing endpoint', sbi('既存の GET /api/v1/courses を未認証クライアントでも呼べるようにする。')],
      ['making an endpoint reachable by unauthenticated clients', sbi('既存の GET /api/v1/courses を未認証クライアントでもアクセス可能にする。')],
      ['letting requests through without authentication', sbi('既存の GET /api/v1/courses に認証なしでアクセスできるようにする。')],
      ['changing it to accept requests without an authentication header', sbi('課金 API を変更する。', '認証ヘッダも Cookie も付けないリクエストでも 200 を返すように変更する')],
      ['adding authentication', sbi('ログインに認証を追加する。')],
      ['an English change that adds authentication', sbi('Add authentication to the courses API.')],
    ]) {
      it(`when it describes ${name} then still matches SEC-AUTH-001`, () => assert.ok(detected(classify(spec), 'SEC-AUTH-001')));
    }
    it('when the SBI negates authentication but the code adds it then still matches SEC-AUTH-001', () => {
      const result = classify(sbi('認証不要の GET /api/v1/health を実装する。'), [{ path: 'apps/api/app/controllers/health_controller.rb', status: 'A', added: 'before_action :authenticate' }]);
      assert.ok(detected(result, 'SEC-AUTH-001'));
    });
  });
});

// Each content exception says whether it ignores its strings in any case; one that does not say matches them case by case (#177).
describe('Security Impact Classifier on the case of the strings a content exception ignores', () => {
  describe('given the legacy SBI and Trusted Acceptance exception, which ignores case', () => {
    for (const added of ['JWT AUTHENTICATION', 'Authenticate_User! BearerAuth', 'SECURITY: []']) {
      it(`when .harness/verification/api-env.mjs adds ${added} then does not match SEC-AUTH-001`, () => {
        assert.equal(detected(assess([{ path: '.harness/verification/api-env.mjs', status: 'M', added }]), 'SEC-AUTH-001'), false);
      });
    }
  });
  describe('given the exceptions that do not set ignoreCase', () => {
    it('when the contract test support adds SECURITYSCHEMES in another case than the OpenAPI name then matches SEC-AUTH-001', () => {
      assert.ok(detected(assess([{ path: 'apps/api/spec/support/api_contract/unsupported.rb', status: 'M', added: 'SECURITYSCHEMES' }]), 'SEC-AUTH-001'));
    });
    it('when the contract test support adds the OpenAPI name securitySchemes then still does not match SEC-AUTH-001', () => {
      assert.equal(detected(assess([{ path: 'apps/api/spec/support/api_contract/unsupported.rb', status: 'M', added: 'requestBodies securitySchemes links' }]), 'SEC-AUTH-001'), false);
    });
    it('when the Harness code adds AUTHENTICATED LOCAL LEDGER in another case than the declared context then matches SEC-AUTH-001', () => {
      assert.ok(detected(assess([{ path: 'tools/harness/index.mjs', status: 'M', added: "source: 'AUTHENTICATED LOCAL LEDGER'" }]), 'SEC-AUTH-001'));
    });
  });
});

describe('Security Impact Classifier on legacy SBIs and Trusted Acceptance that describe authentication with the wider patterns (#177, #217)', () => {
  for (const path of ['.harness/state/sbi-api-env.json', '.harness/verification/api-env.mjs', '.harness/verification/lib/readme.mjs']) {
    for (const added of ["'Then before_action :authenticate_user! guards every controller'", '      security: []', "'Then before_action :require_authentication is not added'", "'devise :database_authenticatable is not used'", "'http_basic_authenticate_with is not used'"]) {
      it(`when ${path} adds ${added.trim()} then does not match SEC-AUTH-001`, () => {
        assert.equal(detected(assess([{ path, status: 'M', added }]), 'SEC-AUTH-001'), false);
      });
    }
  }
  it('when the same words are added to a Run snapshot then still match SEC-AUTH-001', () => {
    assert.ok(detected(assess([{ path: '.harness/state/sbi-12.json', status: 'M', added: '"before_action :authenticate_user!"' }]), 'SEC-AUTH-001'));
  });
});

describe('Security Impact Classifier on Rails 8, Devise and HTTP authentication filters (#177)', () => {
  const controller = 'apps/api/app/controllers/application_controller.rb';
  // Split so this test file's own added lines do not read as a token assignment to the CI secret content check.
  const tokenModule = `${'To'}ken`;
  describe('given a change that adds, removes or skips an authentication filter whose name does not start with authenticate', () => {
    for (const [name, change] of [
      ['adds before_action :require_authentication', { added: 'before_action :require_authentication' }],
      ['removes before_action :require_authentication', { deleted: 'before_action :require_authentication' }],
      ['adds skip_before_action :require_authentication', { added: 'skip_before_action :require_authentication, only: :show' }],
      ['adds allow_unauthenticated_access', { added: 'allow_unauthenticated_access only: %i[new create]' }],
      ['includes the token module of ActionController::HttpAuthentication', { added: `include ActionController::HttpAuthentication::${tokenModule}::ControllerMethods` }],
      ['includes ActionController::HttpAuthentication::Basic::ControllerMethods', { added: 'include ActionController::HttpAuthentication::Basic::ControllerMethods' }],
      ['adds http_basic_authenticate_with', { added: 'http_basic_authenticate_with name: "admin", except: :index' }],
    ]) {
      it(`when ${controller} ${name} then matches SEC-AUTH-001 and requires the authentication test`, () => {
        const result = assess([{ path: controller, status: 'M', ...change }]);
        assert.ok(detected(result, 'SEC-AUTH-001'));
        assert.ok(result.requiredVerifiers.includes('authn-test'));
      });
    }
    for (const added of ['devise :database_authenticatable, :registerable', 'devise :token_authenticatable', 'include Devise::Models::Authenticatable']) {
      it(`when apps/api/app/models/user.rb adds ${added} then matches SEC-AUTH-001`, () => {
        assert.ok(detected(assess([{ path: 'apps/api/app/models/user.rb', status: 'M', added }]), 'SEC-AUTH-001'));
      });
    }
  });
  describe('given ordinary English or identifiers that only contain the letters of authentication', () => {
    for (const added of ['# Unauthenticated requests receive the shared Error schema.', 'render json: { error: "unauthenticated" }, status: :unauthorized', '# The authenticator app shows a code.']) {
      it(`when ${controller} adds ${added} then does not match SEC-AUTH-001`, () => {
        assert.equal(detected(assess([{ path: controller, status: 'M', added }]), 'SEC-AUTH-001'), false);
      });
    }
  });
});

describe('Security Impact Classifier on Devise routes, Devise models, has_secure_password and re-authentication (#177)', () => {
  describe('given an authentication change that does not name authenticate at the start of a word', () => {
    for (const [path, name, change] of [
      ['apps/api/config/routes.rb', 'adds an unauthenticated :user block', { added: 'unauthenticated :user do\n  root to: "sessions#new"\nend' }],
      ['apps/api/config/routes.rb', 'removes devise_for :users', { deleted: 'devise_for :users' }],
      ['apps/api/config/routes.rb', 'adds devise_for :admins with options', { added: 'devise_for :admins, controllers: { sessions: "admins/sessions" }' }],
      ['apps/api/app/models/user.rb', 'adds has_secure_password', { added: '  has_secure_password' }],
      ['apps/api/app/models/user.rb', 'adds devise modules that do not name authenticatable', { added: '  devise :omniauthable, :confirmable, :lockable' }],
      ['apps/api/app/controllers/settings_controller.rb', 'adds a reauthenticate filter', { added: 'before_action :reauthenticate, only: :update' }],
      ['apps/api/app/controllers/settings_controller.rb', 'checks preauthenticated sessions', { added: 'return head :forbidden unless session.preauthenticated?' }],
    ]) {
      it(`when ${path} ${name} then matches SEC-AUTH-001 and requires the authentication test`, () => {
        const result = assess([{ path, status: 'M', ...change }]);
        assert.ok(detected(result, 'SEC-AUTH-001'));
        assert.ok(result.requiredVerifiers.includes('authn-test'));
      });
    }
  });
  describe('given ordinary words that only resemble those declarations', () => {
    for (const added of ['# Unauthenticated users see the sign-up page first.', '# We devise for the admin a simpler list.', '  has_secure_token :invite_code', '# The preview shows a pre-rendered page.']) {
      it(`when apps/api/app/models/user.rb adds ${added.trim()} then does not match SEC-AUTH-001`, () => {
        assert.equal(detected(assess([{ path: 'apps/api/app/models/user.rb', status: 'M', added }]), 'SEC-AUTH-001'), false);
      });
    }
  });
  describe('given the module list of a devise declaration continues on another line', () => {
    // Known limitation: the classifier reads changed lines only, so a continued line does not show that it belongs to devise.
    it('when only the continued line adds :lockable then does not match SEC-AUTH-001 until the classifier reads the declaration', () => {
      assert.equal(detected(assess([{ path: 'apps/api/app/models/user.rb', status: 'M', added: '         :lockable, :timeoutable' }]), 'SEC-AUTH-001'), false);
    });
  });
  describe('given Trusted Acceptance that describes them', () => {
    it('when .harness/verification/api-env.mjs adds them then does not match SEC-AUTH-001', () => {
      assert.equal(detected(assess([{ path: '.harness/verification/api-env.mjs', status: 'M', added: "'Then devise_for :users, has_secure_password and reauthenticate are not used'" }]), 'SEC-AUTH-001'), false);
    });
  });
});
