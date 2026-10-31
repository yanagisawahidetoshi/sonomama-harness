import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessRisk } from './risk-classifier.mjs';
import { mergeDecision } from './merge-policy.mjs';
import { checksPassed } from './verifier.mjs';
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/pr-risk.json', import.meta.url), 'utf8'));
const file = (path, added = 'Simple documentation.', extra = {}) => ({ path, status: 'A', added, deleted: '', binary: false, ...extra });
const risk = (files, extra = {}) => assessRisk({ files, metadata: {}, humanGate: false, ...extra }, policy);
const checks = ['verification', 'policy-review', 'security', 'completion', 'semantic-review'].map(id => ({ id, required: true, status: 'PASS' }));
const approval = (reviewer, extra = {}) => ({ reviewer, kind: 'human', purpose: 'merge', decision: 'APPROVE', commitSha: 'a'.repeat(40), contextDigest: 'context', ...extra });
const decide = (level, approvals = [], extra = {}) => mergeDecision({ risk: { level, requiredHumanApprovals: level === 3 ? 2 : level === 2 ? 1 : 0 }, checks, approvals, securityVerification: { status: 'PASS', violations: [], requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }] }, headSha: 'a'.repeat(40), contextDigest: 'context', humanGate: false, fromSbiIssue: true, ...extra });

// The representative change of each level (#157). LEVEL 1 is the default, so an ordinary change reaches it without any explicit safe rule.
const level1 = [
  ['an admin screen', file('apps/admin/src/features/courses/CourseList.tsx', 'export const CourseList = () => <ul />;')],
  ['a Rails controller that reuses an existing filter', file('apps/api/app/controllers/courses_controller.rb', 'before_action :set_course\n\ndef index\n  render json: current_user.courses\nend')],
  ['Rails routes', file('apps/api/config/routes.rb', 'resources :courses, only: [:index]')],
  ['shared admin configuration', file('apps/admin/src/shared/config/env.ts', 'export const apiBase = import.meta.env.VITE_API_BASE;')],
  ['an added test', file('apps/admin/src/features/courses/CourseList.test.tsx', 'it("renders", () => expect(true).toBe(true));')],
  ['an added assertion in an existing test', file('apps/api/spec/models/course_spec.rb', '  expect(course).to be_published', { status: 'M' })],
  ['an internal refactor', file('apps/api/app/models/course.rb', 'scope :published, -> { where(published: true) }')],
  ['product documentation', file('docs/product/intro.md')],
];
const level2 = [
  ['an additive Rails migration', file('apps/api/db/migrate/20260101000000_add_nickname_to_users.rb', 'add_column :users, :nickname, :string')],
  ['the Rails schema', file('apps/api/db/schema.rb', 'create_table "users" do |t|')],
  ['an additive SQL schema change', file('sql/update.sql', 'ALTER TABLE users ADD COLUMN nickname text;')],
  ['the API contract', file('packages/api-schema/openapi.yaml', 'paths:\n  /courses:\n    get: {}')],
  ['a GitHub Actions workflow', file('.github/workflows/harness.yml', 'jobs:\n  impact: {}')],
  ['a Dockerfile', file('apps/api/Dockerfile', 'FROM ruby:3.4')],
  ['an ADR', file('docs/adr/0008-example.md')],
  ['the Harness implementation', file('tools/harness/verifier.mjs', 'export const noop = () => {};')],
  ['the agent instructions', file('AGENTS.md')],
  ['the agent rules', file('.ai/architecture.md')],
  ['ordinary infrastructure outside production', file('infra/staging/network.tf', 'module "vpc" { source = "./vpc" }')],
  ['a deployment manifest outside production', file('deploy/staging/app.yaml', 'replicas: 2')],
  ['a Helm chart value', file('charts/api/values.yaml', 'replicas: 2')],
  ['a CDK stack', file('cdk/lib/stack.ts', 'new Bucket(this, "assets");')],
  // ADR-0006: weakening a test never merges automatically.
  ['a deleted test file', file('apps/admin/src/features/courses/CourseList.test.tsx', '', { status: 'D', deleted: 'it("renders", () => expect(true).toBe(true));' })],
  ['a focused test', file('apps/admin/src/features/courses/CourseList.test.tsx', 'it.only("renders", () => expect(true).toBe(true));')],
  ['a skipped test', file('apps/admin/src/features/courses/CourseList.test.tsx', 'describe.skip("list", () => {});')],
  ['an RSpec example marked pending', file('apps/api/spec/models/course_spec.rb', '  pending "until the API exists"')],
  ['an RSpec focus tag', file('apps/api/spec/models/course_spec.rb', 'it "publishes", :focus do')],
  ['a removed assertion', file('apps/admin/src/features/courses/CourseList.test.tsx', 'it("renders", () => {});', { status: 'M', deleted: '  expect(screen.getByRole("list")).toBeVisible();' })],
];
const level3 = [
  ['the Risk policy itself', file('.harness/rules/pr-risk.json', '{ "version": 1 }')],
  ['the GitHub Ruleset', file('.github/rulesets/main.json', '{ "name": "main" }')],
  ['the push gate hook', file('.githooks/pre-push', 'pnpm harness:push-gate')],
  ['a destructive Rails migration', file('apps/api/db/migrate/20260101000000_drop_legacy.rb', 'drop_table :legacy_courses')],
  ['a destructive SQL schema change', file('sql/drop.sql', 'DROP TABLE legacy_courses;')],
  ['a row level security policy', file('sql/tenant.sql', 'CREATE POLICY tenant_isolation ON users USING (true);')],
  ['an authorization policy object', file('apps/api/app/policies/course_policy.rb', 'def index?\n  true\nend')],
  ['the security policy document', file('docs/security/authorization.md')],
  ['bulk deletion of production data', file('apps/api/app/jobs/cleanup_job.rb', 'User.delete_all')],
  ['session authentication', file('apps/api/app/controllers/sessions_controller.rb', 'def create\n  head :no_content\nend')],
  ['a production secret file', file('.env.production', 'API_TOKEN=')],
  ['production infrastructure', file('infra/production/main.tf', 'resource "aws_db_instance" "main" {}')],
  ['production Terraform variables', file('terraform/envs/prod.tfvars', 'instance_count = 3')],
];

describe('PR risk rules', () => {
  describe('given LEVEL 1 is the default', () => {
    for (const [name, change] of level1) {
      it(`when ${name} changes then selects level 1 and allows auto merge`, () => {
        const result = risk([change]);
        assert.equal(result.level, 1);
        assert.equal(result.autoMergeAllowed, true);
        assert.equal(result.requiredHumanApprovals, 0);
      });
    }
    it('when no diff is available then stays at the default level', () => assert.equal(risk([]).level, 1));
    it('when an ordinary change carries no floor then names the default as its reason', () => assert.ok(risk([file('apps/admin/src/app/main.tsx', 'render();')]).reasons.includes('default_low')));
  });

  describe('given a change that needs one human review', () => {
    for (const [name, change] of level2) {
      it(`when ${name} changes then raises the floor to level 2`, () => {
        const result = risk([change]);
        assert.equal(result.level, 2);
        assert.equal(result.autoMergeAllowed, false);
        assert.equal(result.requiredHumanApprovals, 1);
      });
    }
    for (const tag of ['Migration', 'ADR', 'breaking_api', 'スキーマ変更', 'CI/CD']) {
      it(`when the SBI declares ${tag} then the floor is level 2, not level 3`, () => assert.equal(risk([file('docs/product/intro.md')], { metadata: { risks: [tag] } }).level, 2));
    }
    it('when a level 2 path changes alongside an ordinary file then the floor still applies', () => assert.equal(risk([file('apps/admin/src/app/main.tsx', 'render();'), file('apps/api/db/schema.rb')]).level, 2));
  });

  describe('given a change that needs two human reviews', () => {
    for (const [name, change] of level3) {
      it(`when ${name} changes then forces level 3`, () => {
        const result = risk([change]);
        assert.equal(result.level, 3);
        assert.equal(result.requiredHumanApprovals, 2);
      });
    }
    for (const [name, change] of level3) {
      it(`when ${name} changes alongside docs then level 3 wins over an AI LOW`, () => assert.equal(risk([file('docs/product/intro.md'), change], { aiRisk: 1 }).level, 3));
    }
    for (const tag of ['RLS', 'PII', 'AuthN', 'AuthZ', 'retention', 'production_data', 'destructive_operation', 'secret', 'permission_model']) {
      it(`when the SBI declares ${tag} then level 3 overrides AI LOW`, () => assert.equal(risk([file('docs/product/intro.md')], { metadata: { risks: [tag] }, aiRisk: 1 }).level, 3));
    }
    it('when a document describes a permission change then its content raises the floor', () => assert.equal(risk([file('docs/product/access.md', 'Change the permission model')]).level, 3));
    it('when a document is renamed out of an authentication directory then the previous path still counts', () => {
      assert.equal(risk([file('docs/product/intro.md', '', { status: 'R', previousPath: 'auth/access.md' })]).level, 3);
    });
  });

  describe('given the levels only ever move up', () => {
    it('when Human Gate applies then level 3 is mandatory', () => assert.equal(risk([file('docs/product/intro.md')], { humanGate: true }).level, 3));
    it('when AI detects more risk then it may raise the default', () => assert.equal(risk([file('apps/admin/page.tsx')], { aiRisk: 3 }).level, 3));
    it('when AI reports LOW for a level 2 path then it cannot lower the floor', () => assert.equal(risk([file('apps/api/db/schema.rb')], { aiRisk: 1 }).level, 2));
    it('when AI reports LOW for ordinary runtime code then the default already is level 1', () => assert.equal(risk([file('apps/admin/page.tsx')], { aiRisk: 1 }).level, 1));
    it('when the SBI declares its own level then that declaration is the floor', () => {
      for (const minimumRiskLevel of [1, 2, 3]) assert.equal(risk([file('apps/admin/page.tsx')], { metadata: { minimumRiskLevel } }).level, minimumRiskLevel);
    });
    it('when a binary or executable file changes then the default level still applies', () => {
      assert.equal(risk([file('docs/product/diagram.png', '', { binary: true })]).level, 1);
      assert.equal(risk([file('scripts/run.sh', 'echo hi', { mode: '100755', modeChanged: true })]).level, 1);
    });
  });

  // classifySecurity clamps minimumRiskLevel to at least 2 even with no matched rule, so only a matched rule may raise the floor.
  describe('given the Security assessment of the same change', () => {
    it('when no Security rule matched then the unmatched minimum does not raise the level', () => {
      const result = risk([file('apps/admin/page.tsx')], { securityAssessment: { securitySensitive: false, matchedRules: [], minimumRiskLevel: 2, requiredHumanApprovals: 0 } });
      assert.equal(result.level, 1);
      assert.equal(result.autoMergeAllowed, true);
    });
    it('when a Security rule asks for one review then the floor is level 2', () => {
      const result = risk([file('apps/api/config/initializers/cors.rb', 'config.allow_origins')], { securityAssessment: { securitySensitive: true, matchedRules: ['SEC-CONFIG-001'], minimumRiskLevel: 2, requiredHumanApprovals: 1 } });
      assert.equal(result.level, 2);
      assert.equal(result.requiredHumanApprovals, 1);
      assert.ok(result.reasons.includes('security_rule_minimum'));
    });
    it('when a Security rule asks for two reviews then the floor is level 3', () => {
      const result = risk([file('apps/api/app/models/user.rb', 'has_secure_password')], { securityAssessment: { securitySensitive: true, matchedRules: ['SEC-AUTH-001'], minimumRiskLevel: 3, requiredHumanApprovals: 2 } });
      assert.equal(result.level, 3);
      assert.equal(result.requiredHumanApprovals, 2);
    });
  });
});

describe('Merge Policy Judge', () => {
  describe('given all applicable required checks pass', () => {
    it('when level 1 then allows merge eligibility without executing merge', () => {
      const result = decide(1);
      assert.equal(result.decision, 'MERGE_ALLOWED');
      assert.equal(result.autoMergeEligible, true);
      assert.equal(result.merged, undefined);
    });
    // #220: --sbi PATH has no ready binding or spec approval, so only a run from an approved SBI Issue is ever a candidate for auto merge.
    it('when level 1 comes from --sbi PATH instead of an approved SBI Issue then it is never auto merge eligible', () => {
      const result = decide(1, [], { fromSbiIssue: false });
      assert.equal(result.decision, 'MERGE_ALLOWED');
      assert.equal(result.autoMergeEligible, false);
    });
    it('when it is not said where the SBI came from then it is never auto merge eligible', () => {
      assert.equal(decide(1, [], { fromSbiIssue: undefined }).autoMergeEligible, false);
    });
    it('when level 2 has no approvals then waits for human review', () => assert.equal(decide(2).decision, 'WAITING_FOR_HUMAN_REVIEW'));
    it('when level 2 has one valid human approval then allows merge', () => assert.equal(decide(2, [approval('A')]).decision, 'MERGE_ALLOWED'));
    it('when level 3 has one valid human approval then waits', () => assert.equal(decide(3, [approval('A')]).decision, 'WAITING_FOR_HUMAN_REVIEW'));
    it('when level 3 has two distinct human approvals then allows manual merge only', () => {
      const result = decide(3, [approval('A'), approval('B')]);
      assert.equal(result.decision, 'MERGE_ALLOWED');
      assert.equal(result.autoMergeEligible, false);
    });
    it('when the same reviewer approves twice then counts once', () => assert.equal(decide(3, [approval('A'), approval('A')]).validApprovals, 1));
    it('when AI and a human approve then counts only the human', () => assert.equal(decide(3, [approval('A'), approval('AI', { kind: 'ai' })]).validApprovals, 1));
    it('when implementation gate approvals exist then never counts them as merge approvals', () => assert.equal(decide(3, [approval('A', { purpose: 'implementation-gate' }), approval('B', { purpose: 'implementation-gate' })]).validApprovals, 0));
    it('when HEAD changes then invalidates old approvals', () => assert.equal(decide(2, [approval('A')], { headSha: 'b'.repeat(40) }).validApprovals, 0));
    it('when the approved context changes then invalidates old approvals', () => assert.equal(decide(2, [approval('A')], { contextDigest: 'changed' }).validApprovals, 0));
    it('when approval is revoked then the older approval no longer counts', () => assert.equal(decide(2, [approval('A'), approval('A', { decision: 'REVOKE' })]).validApprovals, 0));
    it('when changes are requested then blocks even with other approvals', () => assert.equal(decide(2, [approval('A'), approval('B', { decision: 'REQUEST_CHANGES' })]).decision, 'REJECTED'));
    it('when a required check is skipped or absent then blocks', () => {
      assert.equal(decide(1, [], { checks: checks.slice(1) }).decision, 'BLOCKED');
      assert.equal(decide(1, [], { checks: checks.map(c => c.id === 'security' ? { ...c, status: 'SKIP' } : c) }).decision, 'BLOCKED');
    });
    it('when AI Review is missing then blocks at every level', () => {
      for (const level of [1, 2, 3]) assert.equal(decide(level, [approval('A'), approval('B')], { checks: checks.filter(c => c.id !== 'semantic-review') }).decision, 'BLOCKED');
    });
    it('when no real HEAD is available then blocks', () => assert.equal(decide(1, [], { headSha: null }).decision, 'BLOCKED'));
  });
});

describe('Applicable verifier checks', () => {
  describe('given optional placeholder checks', () => {
    it('when only a missing optional app is skipped then accepts the checks', () => assert.equal(checksPassed([{ id: 'bdd', required: true, status: 'PASS' }, { id: 'rails', required: false, status: 'SKIP', reason: 'missing app (placeholder)' }]), true));
    it('when a mandatory check is skipped then rejects the checks', () => assert.equal(checksPassed([{ id: 'bdd', required: true, status: 'SKIP' }]), false));
  });
});

describe('Merge gate precedence', () => {
  describe('given an inconsistent LOW classifier response', () => {
    it('when Human Gate is true then still requires at least two post-implementation humans', () => {
      const result = decide(1, [], { humanGate: true });
      assert.equal(result.requiredApprovals, 2);
      assert.equal(result.decision, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(result.autoMergeEligible, false);
    });
  });
});

describe('Risk contract for prototype lanes', () => {
  describe('given a lightweight prototype lane', () => {
    const lane = { name: 'prototype', requiresSecurityGate: false };
    it('when level 2 has no approval then still requires one human', () => {
      const result = decide(2, [], { lane });
      assert.equal(result.requiredApprovals, 1);
      assert.equal(result.decision, 'WAITING_FOR_HUMAN_REVIEW');
    });
    it('when level 3 applies then still requires two humans', () => {
      const result = decide(3, [approval('A')], { lane });
      assert.equal(result.requiredApprovals, 2);
      assert.equal(result.decision, 'WAITING_FOR_HUMAN_REVIEW');
    });
    // #157: a LEVEL 1 prototype merges automatically under the same conditions as Production.
    it('when level 1 applies then a prototype is auto merge eligible like Production', () => {
      const result = decide(1, [], { lane });
      assert.equal(result.decision, 'MERGE_ALLOWED');
      assert.equal(result.autoMergeEligible, true);
    });
    it('when a promoted prototype has its merge approval then merge does not wait for any Design Approval', () => {
      const result = decide(2, [approval('A')], { lane: { name: 'production', requiresSecurityGate: false, reasons: ['prototype-promotion'] } });
      assert.notEqual(result.decision, 'WAITING_FOR_DESIGN_APPROVAL');
      assert.equal(result.reasons.includes('design_approval_not_approved'), false);
    });
    it('when ordinary prototype content changes then the default level applies and auto merge is allowed', () => {
      const result = risk([file('prototypes/web/View.tsx', 'Static dummy card')], { lane });
      assert.equal(result.level, 1);
      assert.equal(result.autoMergeAllowed, true);
      assert.ok(result.reasons.includes('default_low'));
    });
    it('when prototype content has high risk or AI raises it then never downgrades the floor', () => {
      assert.equal(risk([file('prototypes/web/View.tsx', 'PII')], { lane }).level, 3);
      assert.equal(risk([file('prototypes/web/View.tsx')], { lane, aiRisk: 3 }).level, 3);
      assert.equal(risk([file('prototypes/web/View.tsx')], { lane, aiRisk: 2 }).level, 2);
    });
  });
});
