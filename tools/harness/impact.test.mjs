import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update } from './test-fixture.mjs';
import { readJson } from './io.mjs';
import { analyzeImpact, judgeCi } from './impact.mjs';
import { verify } from './verifier.mjs';
import { check } from './check.mjs';

const config = await readJson(new URL('../../.harness/config/harness.json', import.meta.url));
const sbi = (affectedAreas, extra = {}) => ({ id: 'SBI-X', acceptanceCriteria: [{ id: 'X-AC-1', verifier: 'admin-acceptance' }], requiredVerifiers: [], affectedAreas, ...extra });
const files = (...paths) => paths.map(path => ({ path }));
const touched = { api: 'apps/api/app/models/lesson.rb', mobile: 'apps/mobile/src/features/home/index.ts', admin: 'apps/admin/src/features/home/index.ts' };
const required = impact => impact.requiredVerifiers;
const reasons = (impact, id) => impact.verifiers.find(v => v.id === id)?.reasons ?? [];

describe('SBI Impact Analysis', () => {
  describe('given an SBI and a diff that agree', () => {
    for (const [areas, expected] of [
      [['admin'], ['admin']],
      [['mobile'], ['expo']],
      [['api'], ['rails']],
      [['api', 'mobile'], ['api-contract', 'expo', 'rails']],
      [['api', 'admin'], ['admin', 'api-contract', 'rails']],
      [['api', 'mobile', 'admin'], ['admin', 'api-contract', 'expo', 'rails']],
    ]) {
      it(`when the SBI affects ${areas.join(' + ')} then requires ${expected.join(' / ')}`, () => {
        const impact = analyzeImpact({ config, sbis: [sbi(areas)], files: files(...areas.map(area => touched[area])) });
        assert.deepEqual(required(impact), expected);
        assert.deepEqual(impact.affectedAreas, [...areas].sort());
      });
    }

    it('when the SBI affects prototype-web then requires only the prototype-web verifier', () => {
      const impact = analyzeImpact({ config, sbis: [sbi(['prototype-web'])], files: files('prototypes/web/src/main.tsx') });
      assert.deepEqual(required(impact), ['prototype-web']);
    });

    it('when the SBI affects prototype-mobile then requires only the prototype-mobile verifier', () => {
      const impact = analyzeImpact({ config, sbis: [sbi(['prototype-mobile'])], files: files('prototypes/mobile/index.ts') });
      assert.deepEqual(required(impact), ['prototype-mobile']);
    });

    it('when api and mobile are affected then explains api-contract as a cross-layer requirement', () => {
      const impact = analyzeImpact({ config, sbis: [sbi(['api', 'mobile'])], files: files(touched.api, touched.mobile) });
      assert.ok(reasons(impact, 'api-contract').includes('cross-layer:api+mobile'));
      assert.equal(impact.verifiers.find(v => v.id === 'api-contract').mandatory, false);
    });

    it('when the SBI names areas then marks their verifiers mandatory with the SBI as the reason', () => {
      const impact = analyzeImpact({ config, sbis: [sbi(['admin'])], files: files(touched.admin) });
      assert.equal(impact.verifiers.find(v => v.id === 'admin').mandatory, true);
      assert.ok(reasons(impact, 'admin').includes('sbi:SBI-X affectedAreas:admin'));
      assert.ok(reasons(impact, 'admin').includes(`diff:${touched.admin}`));
    });

    it('when the SBI lists required verifiers then requires them even without a matching diff', () => {
      const impact = analyzeImpact({ config, sbis: [sbi([], { requiredVerifiers: ['rails'] })], files: files('docs/architecture/README.md') });
      assert.deepEqual(required(impact), ['rails']);
      assert.ok(reasons(impact, 'rails').includes('sbi:SBI-X requiredVerifiers'));
    });

    it('when the SBI has acceptance criteria then hands the acceptance verifiers to the Completion Judge instead of the matrix', () => {
      const impact = analyzeImpact({ config, sbis: [sbi(['admin'])], files: files(touched.admin) });
      assert.deepEqual(impact.acceptanceVerifiers, ['admin-acceptance']);
      assert.ok(!required(impact).includes('admin-acceptance'));
    });
  });

  describe('given an SBI and a diff that disagree', () => {
    it('when the diff touches an area the SBI did not name then adds that verifier on the safe side', () => {
      const impact = analyzeImpact({ config, sbis: [sbi(['admin'])], files: files(touched.admin, touched.mobile) });
      assert.deepEqual(required(impact), ['admin', 'expo']);
      assert.ok(reasons(impact, 'expo').includes('diff-not-in-sbi'));
      assert.deepEqual(impact.affectedAreas, ['admin', 'mobile']);
    });

    it('when the diff adds the api area to an admin SBI then also requires api-contract', () => {
      const impact = analyzeImpact({ config, sbis: [sbi(['admin'])], files: files(touched.admin, touched.api) });
      assert.deepEqual(required(impact), ['admin', 'api-contract', 'rails']);
    });
  });

  describe('given a diff without an SBI', () => {
    it('when only apps/admin changes then requires admin from the diff', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files(touched.admin) });
      assert.deepEqual(required(impact), ['admin']);
      assert.deepEqual(reasons(impact, 'admin'), [`diff:${touched.admin}`]);
      assert.equal(impact.verifiers.find(v => v.id === 'admin').mandatory, false);
    });

    it('when the OpenAPI Source of Truth changes then requires api-contract', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files('packages/api-schema/openapi.yaml') });
      assert.ok(required(impact).includes('api-contract'));
    });

    it('when only documentation changes then requires no verifier', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files('docs/architecture/README.md') });
      assert.deepEqual(required(impact), []);
      assert.equal(impact.fullGate, false);
    });
  });

  describe('given Harness itself changes', () => {
    for (const path of ['tools/harness/verifier.mjs', '.harness/config/harness.json', '.harness/verification/admin-env.mjs', '.harness/rules/pr-risk.json', '.github/workflows/harness.yml', '.ai/security-rules.md']) {
      it(`when ${path} changes then triggers the Full Gate with the path as the reason`, () => {
        const impact = analyzeImpact({ config, sbis: [], files: files(path) });
        assert.equal(impact.fullGate, true);
        assert.deepEqual(impact.fullGateReasons, [`diff:${path}`]);
      });
    }

    it('when an app alone changes then does not trigger the Full Gate', () => {
      assert.equal(analyzeImpact({ config, sbis: [], files: files(touched.admin, touched.api) }).fullGate, false);
    });

    it('when every verifier is requested then selects all application verifiers and the Full Gate', () => {
      const impact = analyzeImpact({ config, sbis: [], files: [], all: true });
      assert.deepEqual(required(impact), ['admin', 'api-contract', 'expo', 'prototype-mobile', 'prototype-web', 'rails']);
      assert.equal(impact.fullGate, true);
    });
  });
  describe('given the Expo dependency check that only dependency and native config changes need', () => {
    const doctor = 'gate:pnpm run doctor';
    for (const path of ['apps/mobile/package.json', 'pnpm-lock.yaml', 'apps/mobile/app.json', 'apps/mobile/app.config.ts', 'apps/mobile/eas.json', 'apps/mobile/metro.config.js', 'apps/mobile/babel.config.js', 'apps/mobile/ios/Podfile', 'apps/mobile/android/build.gradle', '.npmrc', 'pnpm-workspace.yaml', 'package.json', '.node-version', '.nvmrc']) {
      it(`when ${path} changes then selects expo and explains that expo-doctor runs for that path`, () => {
        const impact = analyzeImpact({ config, sbis: [], files: files(path) });
        assert.ok(required(impact).includes('expo'));
        assert.ok(reasons(impact, 'expo').includes(`${doctor}:${path}`), reasons(impact, 'expo').join(', '));
      });
    }

    it('when only apps/mobile source changes then selects expo without the expo-doctor reason', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files(touched.mobile) });
      assert.deepEqual(reasons(impact, 'expo'), [`diff:${touched.mobile}`]);
    });

    it('when a mobile SBI changes only source then keeps the expo-doctor reason out of the mandatory selection', () => {
      const impact = analyzeImpact({ config, sbis: [sbi(['mobile'])], files: files(touched.mobile) });
      assert.ok(!reasons(impact, 'expo').some(r => r.startsWith(doctor)));
    });

    it('when only an unrelated file changes then selects neither expo nor prototype-mobile', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files('docs/architecture/README.md', touched.admin) });
      assert.ok(!required(impact).includes('expo'));
      assert.ok(!required(impact).includes('prototype-mobile'));
    });

    it('when prototypes/mobile dependencies change then explains that the prototype expo-doctor runs', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files('prototypes/mobile/package.json') });
      assert.ok(reasons(impact, 'prototype-mobile').includes(`${doctor}:prototypes/mobile/package.json`));
      assert.ok(!reasons(impact, 'expo').some(r => r.startsWith(doctor)));
    });

    it('when only prototypes/mobile source changes then selects prototype-mobile without the expo-doctor reason', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files('prototypes/mobile/src/app/index.tsx') });
      assert.deepEqual(reasons(impact, 'prototype-mobile'), ['diff:prototypes/mobile/src/app/index.tsx']);
    });

    it('when every verifier is requested then still does not run expo-doctor without a matching change', () => {
      const impact = analyzeImpact({ config, sbis: [], files: [], all: true });
      for (const id of ['expo', 'prototype-mobile']) assert.deepEqual(reasons(impact, id), ['all']);
    });
  });
});

describe('Single verifier execution', () => {
  describe('given the verifier selected by Impact Analysis', () => {
    it('when only one verifier is requested then evaluates that verifier alone', () => fixture(async root => {
      const { config: fixtureConfig, sbi: sample } = await check(root);
      await update(root, '.harness/config/harness.json', c => { c.verifiers.find(v => v.id === 'admin').commands = [[process.execPath, '-e', 'process.exit(0)']]; });
      await writeFile(join(root, 'apps/admin/package.json'), '{"private":true}');
      const current = await readJson(join(root, '.harness/config/harness.json'));
      const result = await verify({ root, workspace: root, config: current, sbi: { ...sample, acceptanceCriteria: [], requiredVerifiers: [] }, files: files(touched.admin), only: new Set(['admin']), selected: new Map([['admin', true]]) });
      assert.deepEqual(result.checks.map(c => [c.id, c.status]), [['admin', 'PASS']]);
      assert.ok(result.checks[0].selectionReasons.includes('impact-required'));
      assert.ok(fixtureConfig.verifiers.length > 1);
    }));

    it('when a cross-layer verifier finds no OpenAPI document then skips it as a placeholder', () => fixture(async root => {
      const { config: fixtureConfig, sbi: sample } = await check(root);
      const result = await verify({ root, workspace: root, config: fixtureConfig, sbi: { ...sample, acceptanceCriteria: [], requiredVerifiers: [] }, files: files(touched.api, touched.mobile), only: new Set(['api-contract']), selected: new Map([['api-contract', false]]) });
      assert.deepEqual(result.checks.map(c => [c.id, c.status, c.reason]), [['api-contract', 'SKIP', 'missing app (placeholder)']]);
      assert.equal(result.status, 'PASS');
    }));

    it('when an SBI requires a verifier whose app is missing then fails instead of skipping', () => fixture(async root => {
      const { config: fixtureConfig, sbi: sample } = await check(root);
      const result = await verify({ root, workspace: root, config: fixtureConfig, sbi: { ...sample, acceptanceCriteria: [], requiredVerifiers: [] }, files: files(touched.api), only: new Set(['api-contract']), selected: new Map([['api-contract', true]]) });
      assert.equal(result.checks[0].status, 'FAIL');
    }));
  });
});

describe('CI Completion Judge', () => {
  const impact = analyzeImpact({ config, sbis: [], files: files(touched.admin) });
  const harnessImpact = analyzeImpact({ config, sbis: [], files: files('tools/harness/verifier.mjs', touched.admin) });
  const docsImpact = analyzeImpact({ config, sbis: [], files: files('docs/architecture/README.md') });
  const needs = (verifiers, test = 'skipped', demo = 'skipped') => ({ impact: { result: 'success' }, verifiers: { result: verifiers }, 'harness-test': { result: test }, 'harness-demo': { result: demo } });
  const acceptance = { status: 'PASS', missing: [] };

  describe('given the required verifier matrix', () => {
    it('when every required verifier passes then passes', () => {
      assert.equal(judgeCi({ impact, needs: needs('success'), acceptance }).status, 'PASS');
    });

    it('when one required verifier fails then fails', () => {
      const result = judgeCi({ impact, needs: needs('failure'), acceptance });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reasons.includes('verifiers: failure'));
    });

    it('when the matrix was skipped although verifiers were required then fails', () => {
      assert.equal(judgeCi({ impact, needs: needs('skipped'), acceptance }).status, 'FAIL');
    });

    it('when no verifier was required and the matrix was skipped then passes', () => {
      assert.equal(judgeCi({ impact: docsImpact, needs: needs('skipped'), acceptance }).status, 'PASS');
    });
  });

  describe('given the Full Gate', () => {
    it('when Harness changes and harness:test fails then fails', () => {
      assert.equal(judgeCi({ impact: harnessImpact, needs: needs('success', 'failure', 'success'), acceptance }).status, 'FAIL');
    });

    it('when Harness changes and the Full Gate was skipped then fails', () => {
      assert.equal(judgeCi({ impact: harnessImpact, needs: needs('success'), acceptance }).status, 'FAIL');
    });

    it('when Harness changes and both Full Gate jobs pass then passes', () => {
      assert.equal(judgeCi({ impact: harnessImpact, needs: needs('success', 'success', 'success'), acceptance }).status, 'PASS');
    });
  });

  describe('given SBI acceptance', () => {
    it('when an acceptance criterion has no PASS evidence then fails', () => {
      const result = judgeCi({ impact, needs: needs('success'), acceptance: { status: 'FAIL', missing: ['X-AC-1'] } });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reasons.includes('acceptance missing: X-AC-1'));
    });

    it('when the impact job itself failed then fails', () => {
      assert.equal(judgeCi({ impact, needs: { ...needs('success'), impact: { result: 'failure' } }, acceptance }).status, 'FAIL');
    });
  });
});
