import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assessRisk } from './risk-classifier.mjs';
import { mergeDecision } from './merge-policy.mjs';
import { checksPassed } from './verifier.mjs';
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/pr-risk.json', import.meta.url), 'utf8'));
const file = (path, added = 'Simple documentation.', extra = {}) => ({ path, status: 'A', added, deleted: '', binary: false, ...extra });
const risk = (files, extra = {}) => assessRisk({ files, metadata: {}, humanGate: false, ...extra }, policy);
const checks = ['verification', 'policy-review', 'security', 'completion'].map(id => ({ id, required: true, status: 'PASS' }));
const approval = (reviewer, extra = {}) => ({ reviewer, kind: 'human', purpose: 'merge', decision: 'APPROVE', commitSha: 'a'.repeat(40), contextDigest: 'context', ...extra });
const decide = (level, approvals = [], extra = {}) => mergeDecision({ risk: { level, requiredHumanApprovals: level === 3 ? 2 : level === 2 ? 1 : 0 }, checks, approvals, securityVerification: { status: 'PASS', violations: [], requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }] }, headSha: 'a'.repeat(40), contextDigest: 'context', gateApproved: true, humanGate: false, ...extra });

describe('PR risk rules', () => {
  describe('given the default risk is medium', () => {
    it('when a safe docs-only addition is observed then explicitly downgrades to level 1', () => {
      const result = risk([file('docs/product/intro.md')]);
      assert.equal(result.level, 1);
      assert.ok(result.reasons.includes('explicit_safe_docs_only'));
    });
    for (const path of ['apps/mobile/screen.tsx', 'apps/admin/component.tsx', 'tests/foo.test.mjs', 'pnpm-lock.yaml', 'unknown.bin']) {
      it(`when ${path} changes then stays at level 2`, () => assert.equal(risk([file(path)]).level, 2));
    }
    it('when no diff is available then does not claim safe', () => assert.equal(risk([]).level, 2));
    it('when docs are renamed or binary then does not downgrade', () => {
      assert.equal(risk([file('docs/intro.md', '', { status: 'R', previousPath: 'auth/access.md' })]).level, 3);
      assert.equal(risk([file('docs/intro.md', '', { binary: true })]).level, 2);
    });
    for (const [path, reason] of [['apps/api/db/migrate/001.rb', 'migration'], ['apps/api/db/schema.rb', 'schema'], ['apps/api/auth/login.rb', 'auth'], ['security/rls.sql', 'security'], ['docs/adr/0001.md', 'adr'], ['.github/workflows/deploy.yml', 'cicd'], ['infrastructure/main.tf', 'infrastructure'], ['.harness/rules/pr-risk.json', 'harness_policy']]) {
      it(`when ${reason} changes alongside docs then level 3 always wins`, () => {
        assert.equal(risk([file('docs/intro.md'), file(path)], { aiRisk: 1 }).level, 3);
      });
    }
    for (const tag of ['RLS', 'PII', 'AuthN', 'AuthZ', 'Migration', 'ADR', 'breaking_api', 'retention', 'production_data', 'destructive_operation', 'secret', 'permission_model']) {
      it(`when SBI declares ${tag} then level 3 overrides AI LOW`, () => assert.equal(risk([file('docs/intro.md')], { metadata: { risks: [tag] }, aiRisk: 1 }).level, 3));
    }
    it('when Human Gate applies then level 3 is mandatory', () => assert.equal(risk([file('docs/intro.md')], { humanGate: true }).level, 3));
    it('when AI detects more risk then it may raise the default', () => assert.equal(risk([file('apps/admin/page.tsx')], { aiRisk: 3 }).level, 3));
    it('when AI reports LOW for runtime code then it cannot downgrade the default', () => assert.equal(risk([file('apps/admin/page.tsx')], { aiRisk: 1 }).level, 2));
    it('when docs describe a permission change then they are not safe docs', () => assert.equal(risk([file('docs/access.md', 'Change the permission model')]).level, 3));
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
    it('when enabled semantic review is missing then blocks', () => assert.equal(decide(1, [], { semanticEnabled: true }).decision, 'BLOCKED'));
    it('when a human gate has not been approved then waits for that separate gate', () => assert.equal(decide(3, [approval('A'), approval('B')], { humanGate: true, gateApproved: false }).decision, 'WAITING_FOR_HUMAN_GATE'));
    it('when no real HEAD is available then blocks', () => assert.equal(decide(1, [], { headSha: null }).decision, 'BLOCKED'));
  });
});

describe('Applicable verifier checks', () => {
  describe('given optional placeholder checks', () => {
    it('when only a missing optional app is skipped then accepts the checks', () => assert.equal(checksPassed([{ id: 'bdd', required: true, status: 'PASS' }, { id: 'rails', required: false, status: 'SKIP', reason: 'missing app (placeholder)' }]), true));
    it('when a mandatory check is skipped then rejects the checks', () => assert.equal(checksPassed([{ id: 'bdd', required: true, status: 'SKIP' }]), false));
  });
});

describe('Protected architecture and data changes', () => {
  describe('given apparently ordinary file paths', () => {
    it('when the API contract changes then forces level 3', () => assert.equal(risk([file('packages/api-schema/openapi.yaml')]).level, 3));
    it('when SQL changes table structure then forces level 3', () => assert.equal(risk([file('sql/update.sql', 'ALTER TABLE users ADD COLUMN role text;')]).level, 3));
    it('when code performs bulk deletion then forces level 3', () => assert.equal(risk([file('apps/api/job.rb', 'User.delete_all')]).level, 3));
    it('when session authentication code changes then forces level 3', () => assert.equal(risk([file('apps/api/app/controllers/sessions_controller.rb')]).level, 3));
  });
});

describe('Merge gate precedence', () => {
  describe('given an inconsistent LOW classifier response', () => {
    it('when Human Gate is true then still requires at least two post-implementation humans', () => {
      const result = decide(1, [], { humanGate: true, gateApproved: true });
      assert.equal(result.requiredApprovals, 2);
      assert.equal(result.decision, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(result.autoMergeEligible, false);
    });
  });
});

describe('Safe downgrade requires plain document metadata', () => {
  describe('given a markdown path', () => {
    it('when the file becomes executable then remains level 2', () => assert.equal(risk([file('docs/intro.md', 'Welcome', { mode: '100755', modeChanged: true })]).level, 2));
  });
});


describe('Risk contract for prototype lanes', () => {
  describe('given a lightweight prototype lane', () => {
    const lane = { name:'prototype', requiresSecurityGate:false, requiresDesignApproval:false };
    it('when level 2 has no approval then still requires one human', () => {
      const result = decide(2, [], { lane });
      assert.equal(result.requiredApprovals,1);
      assert.equal(result.decision,'WAITING_FOR_HUMAN_REVIEW');
    });
    it('when level 3 applies then still requires two humans', () => {
      const result = decide(3, [approval('A')], { lane });
      assert.equal(result.requiredApprovals,2);
      assert.equal(result.decision,'WAITING_FOR_HUMAN_REVIEW');
    });
    it('when level 1 is safe then keeps auto merge disabled for prototypes', () => {
      const result=decide(1,[],{lane});
      assert.equal(result.decision,'MERGE_ALLOWED');
      assert.equal(result.autoMergeEligible,false);
    });
    it('when prototype has no explicit safe rule then cannot downgrade by lane alone', () => {
      const withoutRule={...policy,safeRules:[]};
      assert.equal(assessRisk({files:[file('prototypes/web/View.tsx')],lane},withoutRule).level,2);
    });
    it('when explicit safe prototype content is ordinary then selects level 1', () => {
      const result=risk([file('prototypes/web/View.tsx','Static dummy card')],{lane});
      assert.equal(result.level,1);assert.equal(result.autoMergeAllowed,false);
      assert.ok(result.reasons.includes('explicit_safe_prototype_only'));
    });
    it('when prototype content has high risk or AI raises it then never downgrades the floor', () => {
      assert.equal(risk([file('prototypes/web/View.tsx','PII')],{lane}).level,3);
      assert.equal(risk([file('prototypes/web/View.tsx')],{lane,aiRisk:3}).level,3);
      assert.equal(risk([file('prototypes/web/View.tsx')],{lane,aiRisk:2}).level,2);
    });
    it('when mixed with production or when binary, deleted or executable then refuses safe classification',()=>{
      for(const change of [file('apps/admin/View.tsx'),file('prototypes/web/image.png','',{binary:true}),file('prototypes/web/View.tsx','',{status:'D'}),file('prototypes/web/View.tsx','',{mode:'100755'})]) {
        assert.notEqual(risk([file('prototypes/web/View.tsx'),change],{lane}).level,1);
      }
    });
  });
});
