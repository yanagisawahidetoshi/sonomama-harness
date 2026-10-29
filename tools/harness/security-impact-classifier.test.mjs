import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifySecurity } from './security-enforcement.mjs';
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
    it('when its prose describes authorization then still requires the authorization test', () => {
      const result = doc('This endpoint requires authorization.');
      assert.ok(detected(result, 'SEC-AUTHZ-001'));
      assert.ok(result.requiredVerifiers.includes('rails-authz-test'));
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
