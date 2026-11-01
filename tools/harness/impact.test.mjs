import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update } from './test-fixture.mjs';
import { readJson } from './io.mjs';
import { analyzeImpact, describeImpact, describeJudge, judgeCi, judgeTestedCommit, runCompletionJudge } from './impact.mjs';
import { renderSbiBody } from './planner.mjs';
import { sbiFromIssue } from './sbi-issue.mjs';
import { withAcceptance } from './acceptance-registry.mjs';
import { snapshotFromIssue, snapshotPath } from './sbi-source.mjs';
import { git } from './workspace.mjs';
import { verify } from './verifier.mjs';
import { check } from './check.mjs';
import { parse } from 'yaml';

const config = await readJson(new URL('../../.harness/config/harness.json', import.meta.url));
const workflow = parse(await readFile(new URL('../../.github/workflows/harness.yml', import.meta.url), 'utf8'));
const compose = parse(await readFile(new URL('../../compose.yaml', import.meta.url), 'utf8'));
const sbi = (affectedAreas, extra = {}) => ({ id: 'SBI-X', acceptanceCriteria: [{ id: 'X-AC-1', verifier: 'admin-acceptance' }], requiredVerifiers: [], affectedAreas, ...extra });
const files = (...paths) => paths.map(path => ({ path }));
const touched = { api: 'apps/api/app/models/lesson.rb', mobile: 'apps/mobile/src/features/home/index.ts', admin: 'apps/admin/src/features/home/index.ts' };
const required = impact => impact.requiredVerifiers;
const reasons = (impact, id) => impact.verifiers.find(v => v.id === id)?.reasons ?? [];
const passingSecurity = { status: 'PASS', requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }], violations: [] };

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
    for (const path of ['apps/mobile/package.json', 'apps/mobile/app.json', 'apps/mobile/app.config.ts', 'apps/mobile/eas.json', 'apps/mobile/metro.config.js', 'apps/mobile/babel.config.js', 'apps/mobile/ios/Podfile', 'apps/mobile/android/build.gradle', '.npmrc', 'pnpm-workspace.yaml', 'package.json', '.node-version', '.nvmrc']) {
      it(`when ${path} changes then selects expo and explains that expo-doctor runs for that path`, () => {
        const impact = analyzeImpact({ config, sbis: [], files: files(path) });
        assert.ok(required(impact).includes('expo'));
        assert.ok(reasons(impact, 'expo').includes(`${doctor}:${path}`), reasons(impact, 'expo').join(', '));
      });
    }

    it('when only pnpm-lock.yaml changes then does not name expo-doctor for any verifier', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files('pnpm-lock.yaml') });
      for (const id of ['expo', 'prototype-mobile']) assert.ok(!reasons(impact, id).some(r => r.startsWith(doctor)), id);
    });

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

  describe('given a shared toolchain changes', () => {
    const everyVerifier = ['admin', 'api-contract', 'expo', 'prototype-mobile', 'prototype-web', 'rails'];
    for (const path of ['.node-version', 'package.json', 'pnpm-workspace.yaml', '.npmrc', '.tool-versions']) {
      it(`when only ${path} changes then triggers the Full Gate and every application verifier with the toolchain path as the reason`, () => {
        const impact = analyzeImpact({ config, sbis: [], files: files(path) });
        assert.equal(impact.fullGate, true);
        assert.deepEqual(impact.fullGateReasons, [`toolchain:${path}`]);
        assert.deepEqual(required(impact), everyVerifier);
        for (const id of everyVerifier) assert.ok(reasons(impact, id).includes(`toolchain:${path}`), `${id}: ${reasons(impact, id)}`);
      });
    }
    it('when .node-version changes then the CI log names the toolchain path for the Full Gate and each verifier', () => {
      const log = describeImpact(analyzeImpact({ config, sbis: [], files: files('.node-version') }));
      assert.ok(log.includes('Full Gate: yes (toolchain:.node-version)'), log.join('\n'));
      assert.ok(log.includes('Verifier rails: toolchain:.node-version'), log.join('\n'));
    });
    it('when an app changes together with .node-version then keeps the diff reason next to the toolchain reason', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files(touched.admin, '.node-version') });
      assert.deepEqual(reasons(impact, 'admin'), [`diff:${touched.admin}`, 'toolchain:.node-version']);
    });
    it('when an app package.json changes then does not treat it as the root toolchain', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files('apps/admin/package.json') });
      assert.equal(impact.fullGate, false);
      assert.deepEqual(required(impact), ['admin']);
    });
    it('when an app dependency changes the lockfile then does not trigger the Full Gate', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files('apps/admin/package.json', 'pnpm-lock.yaml') });
      assert.equal(impact.fullGate, false);
      assert.ok(required(impact).includes('admin'));
    });
  });
});

describe('SBI requirement for Production changes', () => {
  describe('given a Production diff without an SBI', () => {
    for (const path of [touched.admin, touched.mobile, touched.api, 'packages/api-schema/openapi.yaml']) {
      it(`when ${path} changes then requires an SBI with the path as the reason`, () => {
        const impact = analyzeImpact({ config, sbis: [], files: files(path, 'docs/architecture/README.md') });
        assert.equal(impact.sbiRequired, true);
        assert.deepEqual(impact.sbiRequiredReasons, [`production:${path}`]);
      });
    }

    it('when the Completion Judge aggregates without checking the source SBI Issue then fails closed', () => {
      const impact = analyzeImpact({ config, sbis: [], files: files(touched.admin) });
      const needs = { impact: { result: 'success' }, verifiers: { result: 'success' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };
      const result = judgeCi({ impact, needs, acceptance: { status: 'PASS', missing: [] }, security: passingSecurity });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reasons.includes('sbi source: not evaluated'));
    });

    it('when the impact is printed then the CI log shows why the SBI is required', () => {
      const lines = describeImpact(analyzeImpact({ config, sbis: [], files: files(touched.api) }));
      assert.ok(lines.includes('Change type: ambiguous / SBI required (fail-closed)'), lines.join('\n'));
      assert.ok(lines.includes(`Change type ambiguous: ${touched.api} (no engineering rule matches)`), lines.join('\n'));
    });
  });

  describe('given a Production diff with a valid SBI from an approved SBI Issue', () => {
    const source = { status: 'PASS', reasons: [] };
    it('when the Completion Judge aggregates then judges the verifiers and acceptance as before', () => {
      const impact = analyzeImpact({ config, sbis: [sbi(['admin'])], files: files(touched.admin) });
      const needs = { impact: { result: 'success' }, verifiers: { result: 'success' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };
      assert.equal(impact.sbiRequired, true);
      assert.deepEqual(required(impact), ['admin']);
      assert.equal(judgeCi({ impact, needs, acceptance: { status: 'PASS', missing: [] }, security: passingSecurity, source }).status, 'PASS');
      assert.equal(judgeCi({ impact, needs, acceptance: { status: 'FAIL', missing: ['X-AC-1'] }, security: passingSecurity, source }).status, 'FAIL');
    });
  });

  describe('given a change outside the Production paths', () => {
    for (const path of ['prototypes/web/src/main.tsx', 'prototypes/mobile/index.ts', 'docs/architecture/README.md', 'tools/harness/verifier.mjs', '.harness/config/harness.json', 'README.md']) {
      it(`when only ${path} changes then does not require an SBI`, () => {
        const impact = analyzeImpact({ config, sbis: [], files: files(path) });
        assert.equal(impact.sbiRequired, false);
        assert.deepEqual(impact.sbiRequiredReasons, []);
        assert.ok(describeImpact(impact).includes('Change type: none (no production path changed) / SBI not required'));
      });
    }

    it('when every verifier is requested on main then does not require an SBI', () => {
      assert.equal(analyzeImpact({ config, sbis: [], files: [], all: true }).sbiRequired, false);
    });
  });
});

describe('Single verifier execution', () => {
  describe('given the verifier selected by Impact Analysis', () => {
    it('when only one verifier is requested then evaluates that verifier alone', () => fixture(async root => {
      const { config: fixtureConfig, sbi: sample } = await check(root);
      await update(root, '.harness/config/harness.json', c => { c.verifiers.find(v => v.id === 'admin').commands = [['node', '-e', 'process.exit(0)']]; });
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
  // Production diffs need an SBI from an approved SBI Issue (#45), so the matrix and Full Gate cases carry one.
  const impact = analyzeImpact({ config, sbis: [sbi(['admin'])], files: files(touched.admin) });
  const harnessImpact = analyzeImpact({ config, sbis: [sbi(['admin'])], files: files('tools/harness/verifier.mjs', touched.admin) });
  const docsImpact = analyzeImpact({ config, sbis: [], files: files('docs/architecture/README.md') });
  const needs = (verifiers, test = 'skipped', demo = 'skipped') => ({ impact: { result: 'success' }, verifiers: { result: verifiers }, 'harness-test': { result: test }, 'harness-demo': { result: demo } });
  const acceptance = { status: 'PASS', missing: [] };
  const source = { status: 'PASS', reasons: [] };
  const judged = options => judgeCi({ security: passingSecurity, source, ...options });

  describe('given the required verifier matrix', () => {
    it('when every required verifier passes then passes', () => {
      assert.equal(judged({ impact, needs: needs('success'), acceptance }).status, 'PASS');
    });

    it('when one required verifier fails then fails', () => {
      const result = judged({ impact, needs: needs('failure'), acceptance });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reasons.includes('verifiers: failure'));
    });

    it('when the matrix was skipped although verifiers were required then fails', () => {
      assert.equal(judged({ impact, needs: needs('skipped'), acceptance }).status, 'FAIL');
    });

    it('when no verifier was required and the matrix was skipped then passes', () => {
      assert.equal(judged({ impact: docsImpact, needs: needs('skipped'), acceptance }).status, 'PASS');
    });
  });

  describe('given the Full Gate', () => {
    it('when Harness changes and harness:test fails then fails', () => {
      assert.equal(judged({ impact: harnessImpact, needs: needs('success', 'failure', 'success'), acceptance }).status, 'FAIL');
    });

    it('when Harness changes and the Full Gate was skipped then fails', () => {
      assert.equal(judged({ impact: harnessImpact, needs: needs('success'), acceptance }).status, 'FAIL');
    });

    it('when Harness changes and both Full Gate jobs pass then passes', () => {
      assert.equal(judged({ impact: harnessImpact, needs: needs('success', 'success', 'success'), acceptance }).status, 'PASS');
    });
  });

  describe('given SBI acceptance', () => {
    it('when an acceptance criterion has no PASS evidence then fails', () => {
      const result = judged({ impact, needs: needs('success'), acceptance: { status: 'FAIL', missing: ['X-AC-1'] } });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reasons.includes('acceptance missing: X-AC-1'));
    });

    it('when the impact job itself failed then fails', () => {
      assert.equal(judged({ impact, needs: { ...needs('success'), impact: { result: 'failure' } }, acceptance }).status, 'FAIL');
    });
  });

  // Runs 40984230168 and 40985538230 (#163): a Gemfile and CI document change with no SBI asked for no Maestro lane, the maestro job
  // still ran and failed, and the Judge passed.
  describe('given a job that ran although the impact did not require it', () => {
    const railsImpact = analyzeImpact({ config, sbis: [], files: files('apps/api/Gemfile', '.ai/workflows/ci.md') });
    const ran = maestro => ({ ...needs('success', 'success', 'success'), maestro: { result: maestro } });

    for (const result of ['failure', 'cancelled']) {
      it(`when the maestro job ended in ${result} then fails although no lane was required`, () => {
        const judgedRun = judged({ impact: railsImpact, needs: ran(result), acceptance });
        assert.deepEqual(railsImpact.maestro, []);
        assert.equal(judgedRun.status, 'FAIL');
        assert.ok(judgedRun.reasons.includes(`maestro: ${result}`), judgedRun.reasons.join('; '));
      });
    }

    for (const result of ['success', 'skipped']) {
      it(`when the maestro job ended in ${result} then passes`, () => {
        assert.equal(judged({ impact: railsImpact, needs: ran(result), acceptance }).status, 'PASS');
      });
    }

    it('when the workflow did not hand over the maestro job then passes, as before the job existed', () => {
      assert.equal(judged({ impact: railsImpact, needs: needs('success', 'success', 'success'), acceptance }).status, 'PASS');
    });

    it('when a job this Judge does not know failed then fails', () => {
      const judgedRun = judged({ impact: railsImpact, needs: { ...needs('success', 'success', 'success'), 'future-job': { result: 'failure' } }, acceptance });
      assert.equal(judgedRun.status, 'FAIL');
      assert.ok(judgedRun.reasons.includes('future-job: failure'), judgedRun.reasons.join('; '));
    });
  });
});

describe('Tested commit of the Completion Judge', () => {
  const head = 'a'.repeat(40), other = 'b'.repeat(40);
  const needs = sha => ({ impact: { result: 'success', outputs: { head_sha: sha } } });

  it('when the checkout, the event head and the impact job are on the same commit then nothing fails', () => {
    assert.deepEqual(judgeTestedCommit({ headSha: head, expectedHeadSha: head, needs: needs(head) }), []);
  });

  for (const [name, expectedHeadSha, impactSha, pattern] of [
    ['the workflow did not say which head it tests', '', head, /head sha: not provided/],
    ['the checkout is not the head of the event', other, head, /checkout aaaaaaaaaaaa is not the head bbbbbbbbbbbb/],
    ['the impact job did not report its commit', head, undefined, /impact: analyzed missing, not aaaaaaaaaaaa/],
    ['the impact job analyzed another commit', head, other, /impact: analyzed bbbbbbbbbbbb, not aaaaaaaaaaaa/],
  ]) {
    it(`when ${name} then fails closed`, () => {
      assert.match(judgeTestedCommit({ headSha: head, expectedHeadSha, needs: needs(impactSha) }).join('\n'), pattern);
    });
  }

  it('when the Judge runs then the checked-out commit must be the head the workflow names', async () => fixture(async root => {
    const headSha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const judgedRun = await runCompletionJudge({ root, base: 'HEAD', needs: needs(headSha), expectedHeadSha: other });
    assert.equal(judgedRun.status, 'FAIL');
    assert.ok(judgedRun.reasons.some(r => r.includes(`is not the head ${other.slice(0, 12)}`)), judgedRun.reasons.join('; '));
  }));
});

describe('CI Completion Judge for Trusted Acceptance and Security', () => {
  const needs = (verifiers = 'success') => ({ impact: { result: 'success' }, verifiers: { result: verifiers }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } });
  const impact = analyzeImpact({ config, sbis: [sbi(['admin'])], files: files(touched.admin) });
  const acceptance = { status: 'PASS', missing: [] };
  const source = { status: 'PASS', reasons: [] };
  const securityWith = (...checks) => ({ status: checks.every(c => c.status === 'PASS') ? 'PASS' : 'FAIL', requiredVerifiers: checks.map(c => c.id), checks: checks.map(c => ({ required: true, ...c })), violations: [] });

  describe('given the Security result of the Completion Judge', () => {
    it('when Security was not evaluated then fails even though the application verifiers passed', () => {
      const result = judgeCi({ impact, needs: needs(), acceptance, source });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.reasons.includes('security: not evaluated'));
    });

    for (const status of ['FAIL', 'NOT_CONFIGURED', 'SKIP']) {
      it(`when a required Security verifier is ${status} then does not treat it as PASS`, () => {
        const result = judgeCi({ impact, needs: needs(), acceptance, source, security: securityWith({ id: 'secret-scan', status: 'PASS' }, { id: 'migration-safety', status }) });
        assert.equal(result.status, 'FAIL');
        assert.ok(result.reasons.includes(`security: migration-safety ${status}`));
      });
    }

    it('when every required Security verifier passes then passes', () => {
      const security = securityWith({ id: 'secret-scan', status: 'PASS' }, { id: 'forbidden-pattern-check', status: 'PASS' });
      assert.equal(judgeCi({ impact, needs: needs(), acceptance, security, source }).status, 'PASS');
    });
  });

  describe('given a Production change with a ready SBI Issue snapshot on a branch', () => {
    const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
    const pbi = { owner: 'acme', repo: 'app', number: 3, url: 'https://github.com/acme/app/issues/3', title: 'CI judge' };
    const planned = {
      id: 'SBI-001', kind: 'implementation', title: 'CI judge', purpose: '名前に応じてあいさつする。',
      scope: { included: ['apps/admin'], excluded: [] },
      acceptanceCriteria: ['AC-1', 'AC-2', 'AC-3'].map(id => ({ id, description: `${id} のあいさつ` })),
      scenarios: [{ name: 'あいさつ', given: ['名前がある'], when: ['greetを呼ぶ'], then: ['あいさつを返す'], acceptanceIds: ['AC-1', 'AC-2', 'AC-3'], test: 'node:test: greeting.test.mjs' }],
      dependsOn: [], changeAreas: ['apps/admin'], layers: ['画面Component'], estimatedFiles: 2, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
      verification: { applicationTest: 'Vitest', acceptance: 'Trusted Acceptance', e2e: '不要' },
    };
    const readyIssue = { number: 7, title: 'SBI-001 CI judge', body: renderSbiBody(planned, pbi), html_url: ref.url, state: 'open', labels: [{ name: 'sbi' }, { name: 'ready' }] };
    // The sample acceptance script registered on main as the Trusted Acceptance of SBI Issue #7.
    const issueAcceptance = { version: 1, sbiIssue: 7, verifiers: [{ id: 'issue-7-acceptance', trustedScript: 'tools/harness/sample-bdd.mjs', planned: ['Trusted Acceptance'], acceptanceIds: ['AC-1', 'AC-2', 'AC-3'] }] };
    const runId = '2026-10-28T00-00-00-000Z-1a2b3c4d';
    const branch = async (root, change) => {
      await mkdir(join(root, '.harness/acceptance'), { recursive: true });
      await writeFile(join(root, '.harness/acceptance/sbi-7.json'), JSON.stringify(issueAcceptance));
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', 'register the Trusted Acceptance of SBI Issue #7']);
      await git(root, ['switch', '-c', 'feature']);
      await mkdir(join(root, 'apps/admin/src'), { recursive: true });
      await writeFile(join(root, 'greeting.mjs'), "export const greet = name => `こんにちは、${name?.trim() || 'ゲスト'}さん`;\n");
      const sbi = sbiFromIssue({ ref, issue: readyIssue, config: await withAcceptance(root, await readJson(join(root, '.harness/config/harness.json')), [7]) });
      const snapshot = snapshotFromIssue({ ref, issue: readyIssue, runId, sbi });
      await writeFile(join(root, snapshotPath(snapshot)), JSON.stringify(snapshot));
      await change(root);
      await git(root, ['add', '--all']);
      await git(root, ['commit', '-m', `feat: ci judge\n\nHarness-Run: ${runId}\nSBI-Issue: ${ref.url}`]);
    };
    // #194: a person with write access marked the Issue ready and left it unedited, so the ready label still covers what the Run took from it.
    const readyUnedited = { issueTimeline: async () => [{ event: 'labeled', label: { name: 'ready' }, created_at: '2026-10-01T00:00:00Z', actor: { login: 'alice', type: 'User' } }], bodyHistory: async () => ({ lastEditedAt: null, edits: [] }), collaboratorPermission: async () => ({ permission: 'write', role_name: 'write' }) };
    const judgeBranch = (root, verifiers = 'success') => runCompletionJudge({ root, base: 'main', needs: needs(verifiers), repository: 'acme/app', github: { fetchIssue: async () => readyIssue, ...readyUnedited } });
    const status = (judged, id) => judged.security.checks.find(c => c.id === id)?.status;

    it('when the Completion Judge runs then executes the Trusted Acceptance of the SBI', () => fixture(async root => {
      await branch(root, root => writeFile(join(root, 'apps/admin/src/main.ts'), 'export const ready = true;\n'));
      const judged = await judgeBranch(root);
      assert.deepEqual(judged.checks.filter(c => c.trust === 'acceptance').map(c => [c.id, c.status]), [['issue-7-acceptance', 'PASS']]);
      assert.equal(judged.acceptance.status, 'PASS');
      assert.equal(judged.status, 'PASS');
    }));

    it('when the Completion Judge runs then always evaluates secret-scan and forbidden-pattern-check', () => fixture(async root => {
      await branch(root, root => writeFile(join(root, 'apps/admin/src/main.ts'), 'export const ready = true;\n'));
      const judged = await judgeBranch(root);
      assert.equal(status(judged, 'secret-scan'), 'PASS');
      assert.equal(status(judged, 'forbidden-pattern-check'), 'PASS');
    }));

    it('when the diff adds a forbidden security pattern then fails on forbidden-pattern-check', () => fixture(async root => {
      const unsafe = ['NODE', 'TLS', 'REJECT', 'UNAUTHORIZED'].join('_');
      await branch(root, root => writeFile(join(root, 'apps/admin/src/main.ts'), `process.env.${unsafe} = '0';\n`));
      const judged = await judgeBranch(root);
      assert.equal(status(judged, 'forbidden-pattern-check'), 'FAIL');
      assert.equal(judged.status, 'FAIL');
    }));

    it('when the diff adds a credential then fails on secret-scan', () => fixture(async root => {
      const token = 'ghp_' + 'z'.repeat(36);
      await branch(root, root => writeFile(join(root, 'apps/admin/src/main.ts'), `export const token = '${token}';\n`));
      const judged = await judgeBranch(root);
      assert.equal(status(judged, 'secret-scan'), 'FAIL');
      assert.equal(judged.status, 'FAIL');
    }));

    // main connects migration-safety; this case disconnects it again so that the required verifier is not configured.
    it('when the Security Impact adds a required verifier that is not configured then fails instead of passing', () => fixture(async root => {
      await update(root, '.harness/config/harness.json', c => { c.securityVerifiers = c.securityVerifiers.filter(v => v.id !== 'migration-safety'); });
      await branch(root, async root => {
        await mkdir(join(root, 'apps/admin/db/migrate'), { recursive: true });
        await writeFile(join(root, 'apps/admin/db/migrate/001_lessons.rb'), 'class Lessons; end\n');
      });
      const judged = await judgeBranch(root);
      assert.ok(judged.security.requiredVerifiers.includes('migration-safety'));
      assert.equal(status(judged, 'migration-safety'), 'NOT_CONFIGURED');
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.includes('security: migration-safety NOT_CONFIGURED'));
    }));

    it('when only an ADR describes authorization then passes with the authorization test skipped as not applicable', () => fixture(async root => {
      await branch(root, async root => {
        await mkdir(join(root, 'docs/adr'), { recursive: true });
        await writeFile(join(root, 'docs/adr/0009-invitation.md'), '# Invitation\n\nThis endpoint requires authorization.\n');
      });
      const judged = await judgeBranch(root);
      assert.equal(judged.security.requiredVerifiers.includes('rails-authz-test'), false);
      assert.equal(status(judged, 'rails-authz-test'), 'SKIP');
      assert.equal(status(judged, 'secret-scan'), 'PASS');
      assert.equal(status(judged, 'forbidden-pattern-check'), 'PASS');
      assert.equal(judged.status, 'PASS');
    }));

    it('when the SBI requires an application verifier then takes its result from the verifier matrix', () => fixture(async root => {
      // An SBI built from an Issue requires no application verifier, so a hand-written SBI JSON on the same branch asks for it.
      await branch(root, async root => {
        const sample = await readJson(join(root, '.harness/state/sample-sbi.json'));
        await writeFile(join(root, '.harness/state/sbi-requires-admin.json'), JSON.stringify({ ...sample, id: 'SBI-REQUIRES-ADMIN', requiredVerifiers: ['admin'] }));
        await writeFile(join(root, 'apps/admin/src/main.ts'), 'export const ready = true;\n');
      });
      assert.equal(status(await judgeBranch(root), 'admin'), 'PASS');
      const failed = await judgeBranch(root, 'failure');
      assert.equal(status(failed, 'admin'), 'FAIL');
      assert.equal(failed.status, 'FAIL');
    }));

    it('when the Trusted Acceptance fails then fails although the application verifiers passed', () => fixture(async root => {
      await branch(root, root => writeFile(join(root, 'greeting.mjs'), 'export const greet = () => "";\n'));
      const judged = await judgeBranch(root);
      assert.equal(judged.acceptance.status, 'FAIL');
      assert.equal(judged.status, 'FAIL');
    }));
  });

  describe('given the CI log', () => {
    it('when the judge is described then shows Application, Acceptance and Security separately', () => {
      const lines = describeJudge({
        needs: needs(), acceptance, checks: [{ id: 'sample-bdd', trust: 'acceptance', status: 'PASS' }],
        security: securityWith({ id: 'secret-scan', status: 'PASS' }), status: 'PASS', reasons: [],
      });
      assert.ok(lines.includes('Application: verifiers=success harness-test=skipped harness-demo=skipped'));
      assert.ok(lines.includes('Acceptance: PASS (sample-bdd: PASS)'));
      assert.ok(lines.includes('Security: PASS (secret-scan: PASS)'));
    });
  });
});

describe('CI workflow setup', () => {
  const runs = job => workflow.jobs[job].steps.filter(s => s.run).map(s => s.run);
  const nodeCache = job => workflow.jobs[job].steps.find(s => s.uses?.startsWith('actions/setup-node@')).with.cache;

  describe('given impact and the Completion Judge on every PR critical path', () => {
    for (const job of ['impact', 'harness']) {
      it(`when ${job} sets up then installs only the root production dependencies from the frozen lockfile without restoring the pnpm store`, () => {
        assert.ok(runs(job).includes('pnpm install --frozen-lockfile --prod --ignore-workspace'));
        assert.ok(!runs(job).includes('pnpm install --frozen-lockfile'));
        assert.equal(nodeCache(job), undefined);
      });
    }
  });

  describe('given verifiers and the Full Gate that build applications', () => {
    for (const job of ['verifiers', 'harness-test', 'harness-demo']) {
      it(`when ${job} sets up then keeps the full workspace install with the pnpm store`, () => {
        assert.ok(runs(job).includes('pnpm install --frozen-lockfile'));
        assert.equal(nodeCache(job), 'pnpm');
      });
    }
  });

  describe('given jobs that build the API image', () => {
    // Under apps/api/tmp: ignored by Git and Docker, hidden from the container, and inside every building verifier's working directory, which bake's filesystem entitlement requires.
    const cacheDir = 'apps/api/tmp/buildkit-cache';
    const stepIndex = (job, prefix) => workflow.jobs[job].steps.findIndex(s => s.uses?.startsWith(prefix));

    it('when verifiers set up then restores the BuildKit layer cache keyed on every Dockerfile and Gemfile.lock before installing', () => {
      const cache = workflow.jobs.verifiers.steps[stepIndex('verifiers', 'actions/cache@')];
      assert.ok(cache, 'actions/cache step');
      assert.ok(stepIndex('verifiers', 'actions/cache@') < stepIndex('verifiers', 'pnpm/action-setup@'));
      assert.equal(cache.with.path, cacheDir);
      assert.match(cache.with.key, /hashFiles\('\*\*\/Dockerfile', '\*\*\/Gemfile\.lock'\)/);
    });

    it('when verifiers build through compose then import and export that cache by absolute path', () => {
      assert.equal(workflow.jobs.verifiers.env.HARNESS_BUILD_CACHE_FROM, `type=local,src=\${{ github.workspace }}/${cacheDir}`);
      assert.equal(workflow.jobs.verifiers.env.HARNESS_BUILD_CACHE_TO, `type=local,dest=\${{ github.workspace }}/${cacheDir},mode=max`);
    });

    it('when any job builds then keeps the bake filesystem entitlement check', () => {
      for (const [name, job] of Object.entries(workflow.jobs)) {
        assert.equal(job.env?.BUILDX_BAKE_ENTITLEMENTS_FS, undefined, name);
        for (const step of job.steps) assert.equal(step.env?.BUILDX_BAKE_ENTITLEMENTS_FS, undefined, name);
      }
      assert.doesNotMatch(JSON.stringify(workflow), /--allow|ENTITLEMENTS/);
    });

    // harness-demo builds inside run worktrees, outside the checkout that holds the cache, so bake would refuse it there.
    for (const job of ['impact', 'harness-test', 'harness-demo', 'harness']) {
      it(`when ${job} sets up then restores no build cache`, () => {
        assert.equal(stepIndex(job, 'actions/cache@'), -1);
        assert.equal(workflow.jobs[job].env?.HARNESS_BUILD_CACHE_FROM, undefined);
      });
    }

    it('when compose builds the API image without the CI variables then it reads a missing cache and writes only an inline one', () => {
      const build = compose.services.api.build;
      assert.equal(build.context, './apps/api');
      assert.deepEqual(build.cache_from, ['${HARNESS_BUILD_CACHE_FROM:-type=local,src=.no-build-cache}']);
      assert.deepEqual(build.cache_to, ['${HARNESS_BUILD_CACHE_TO:-type=inline}']);
    });

    it('when the base image tag moves to a new digest then the Dockerfile and therefore the cache key change', async () => {
      const dockerfile = await readFile(new URL('../../apps/api/Dockerfile', import.meta.url), 'utf8');
      assert.match(dockerfile, /^FROM ruby:3\.4\.\d+-slim@sha256:[0-9a-f]{64}$/m);
    });
  });

  describe('given a faster setup', () => {
    it('when the jobs run then every job still runs the same Harness commands', () => {
      const harness = job => runs(job).filter(r => r.startsWith('pnpm harness:'));
      assert.deepEqual(harness('impact'), ['pnpm harness:check', 'pnpm harness:impact $HARNESS_SCOPE']);
      assert.deepEqual(harness('verifiers'), ['pnpm harness:verify --verifier ${{ matrix.verifier }} $HARNESS_SCOPE']);
      assert.deepEqual(harness('harness-test'), ['pnpm harness:test']);
      assert.deepEqual(harness('harness-demo'), ['pnpm harness:demo $HARNESS_DEMO_SCOPE']);
      assert.deepEqual(harness('harness'), ['pnpm harness:judge $HARNESS_SCOPE']);
    });
  });

  // harness:test was the critical path of a Full Gate pull request (#197): it runs as shards of the same file list in parallel jobs.
  describe('given the Harness tests split into shards', () => {
    const job = workflow.jobs['harness-test'];
    it('when the Full Gate runs then every shard of the same test command runs, and one failing shard does not cancel the others', () => {
      const shards = job.strategy.matrix.shard;
      assert.ok(shards.length > 1);
      assert.deepEqual(shards, shards.map((_, i) => i + 1));
      assert.equal(job.strategy['fail-fast'], false);
      const step = job.steps.find(s => s.run === 'pnpm harness:test');
      assert.equal(step.env.HARNESS_TEST_SHARD, `\${{ matrix.shard }}/${shards.length}`);
    });
    it('when harness:test runs with a shard then node runs only that shard of the full file list, and without one it runs everything', async () => {
      const script = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).scripts['harness:test'];
      assert.match(script, /^node --test \$\{HARNESS_TEST_SHARD:\+--test-shard=\$HARNESS_TEST_SHARD\} /);
      for (const glob of ['tools/harness/*.test.mjs', 'tools/harness/agents/*.test.mjs', '.harness/verification/*.test.mjs', '.harness/verification/lib/*.test.mjs']) assert.ok(script.includes(glob), glob);
    });
  });

  // The self-repair demo was the longest job of a pull request run: every real application verifier ran a second time inside its run
  // worktree, about 7 minutes of an 8 minute run (#192). The loop itself needs no verifier, so a pull request proves the loop and a
  // push to main keeps proving it against the real verifiers.
  describe('given the self-repair demo', () => {
    it('when a pull request runs the Full Gate then the demo adds the real application verifiers only outside a pull request', () => {
      assert.equal(workflow.env.HARNESS_DEMO_SCOPE, "${{ github.event_name != 'pull_request' && '--full' || '' }}");
      assert.doesNotMatch(JSON.stringify(workflow.jobs['harness-demo']), /--full/);
    });
  });

  // A pull_request run reads this workflow from the merge ref but checks out the Harness of the PR head. In runs 40984230168 and
  // 40985538230 (#163) the head was branched before the maestro job existed: its impact reported no maestro output, the job still ran
  // and failed, and the head's Judge, which did not know the job, passed.
  describe('given a PR head whose Harness is older than this workflow', () => {
    const head = '${{ github.event.pull_request.head.sha || github.sha }}';
    const judge = workflow.jobs.harness.steps.find(s => s.run === 'pnpm harness:judge $HARNESS_SCOPE');
    const guards = workflow.jobs.harness.steps.filter(s => s.run && !s.run.startsWith('pnpm ') && /exit 1/.test(s.run));

    it('when the impact job runs then it reports the commit it analyzed', () => {
      assert.equal(workflow.jobs.impact.outputs.head_sha, '${{ steps.impact.outputs.head_sha }}');
    });

    it('when the Judge runs then it is told the head the workflow checked out', () => {
      assert.equal(judge.env.HARNESS_HEAD_SHA, head);
    });

    // #184: a pull request also names its base commit, so the Judge checks that the base it diffs from contains it; a push to main has none.
    it('when the Judge runs on a pull request then it is told the base commit of the event', () => {
      assert.equal(judge.env.HARNESS_BASE_SHA, '${{ github.event.pull_request.base.sha }}');
    });

    it('when the impact reported no maestro output then the maestro job does not start', () => {
      assert.match(workflow.jobs.maestro.if, /needs\.impact\.outputs\.maestro != ''/);
    });

    for (const [name, pattern] of [
      ['a job failed', /contains\(needs\.\*\.result, 'failure'\)/],
      ['a job was cancelled', /contains\(needs\.\*\.result, 'cancelled'\)/],
      ['the impact reported no maestro output', /needs\.impact\.outputs\.maestro == ''/],
    ]) {
      it(`when ${name} then the workflow fails the required check whatever the head's Judge says`, () => {
        assert.ok(guards.some(s => s.if.startsWith('always()') && pattern.test(s.if)), guards.map(s => s.if).join('\n'));
      });
    }

    it('when the Judge reads the maestro results then it downloads them from this run only', () => {
      const download = workflow.jobs.harness.steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
      assert.equal(download.with['run-id'], undefined);
      assert.equal(download.with['github-token'], undefined);
    });
  });
});

describe('CI Completion Judge for a legacy hand-written SBI (#217)', () => {
  const needs = { impact: { result: 'success' }, verifiers: { result: 'success' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };
  const legacy = async root => ({ ...await readJson(join(root, '.harness/state/sample-sbi.json')), id: 'SBI-API-ENV', description: '認証Providerの決定とProvider固有実装を分ける' });
  // Commits the SBI file on main, then edits its description on a feature branch, so the PR only changes that file.
  const edit = async (root, path) => {
    const sbi = await legacy(root);
    await writeFile(join(root, path), `${JSON.stringify(sbi, null, 2)}\n`);
    await git(root, ['add', '--all']);
    await git(root, ['commit', '-m', 'add the SBI']);
    await git(root, ['switch', '-c', 'feature']);
    await writeFile(join(root, path), `${JSON.stringify({ ...sbi, description: `${sbi.description}。JWT / Cognito等の認証実装をしていない` }, null, 2)}\n`);
    await git(root, ['add', '--all']);
    await git(root, ['commit', '-m', 'docs: edit the SBI']);
  };

  describe('given a PR that only edits a legacy SBI, whose name is not an Issue number', () => {
    it('when judged then no SBI source is required and the source check passes, because a legacy SBI is not a Run snapshot', async () => fixture(async root => {
      await edit(root, '.harness/state/sbi-api-env.json');
      const result = await runCompletionJudge({ root, base: 'main', needs });
      assert.deepEqual(result.source.required, []);
      assert.equal(result.source.status, 'PASS', result.source.reasons.join('; '));
    }));

    it('when its words mention 認証 and JWT then the Security check does not require the authentication test', async () => fixture(async root => {
      await edit(root, '.harness/state/sbi-api-env.json');
      const result = await runCompletionJudge({ root, base: 'main', needs });
      assert.deepEqual(result.security.requiredVerifiers.filter(id => /authn/.test(id)), [], JSON.stringify(result.security.reasons ?? result.security));
    }));
  });

  describe('given a PR that edits a file named like a Run snapshot', () => {
    it('when judged then the SBI source is still required and fails, because a broken or hand-made snapshot is not a legacy SBI', async () => fixture(async root => {
      await edit(root, '.harness/state/sbi-12.json');
      const result = await runCompletionJudge({ root, base: 'main', needs });
      assert.deepEqual(result.source.required, ['sbi-snapshot']);
      assert.equal(result.source.status, 'FAIL');
    }));
  });
});

// #184: the Completion Judge reads its content targets from the PR diff, or from every tracked file at HEAD on a push to main (--all).
describe('CI Security content targets (#184)', () => {
  const needs = { impact: { result: 'success' }, verifiers: { result: 'success' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };
  const unsafe = ['NODE', 'TLS', 'REJECT', 'UNAUTHORIZED'].join('_');
  const commit = async (root, message) => { await git(root, ['add', '--all']); await git(root, ['commit', '--allow-empty', '-m', message]); };
  // Commits setup on main, then makes the PR change on a feature branch.
  const pr = async (root, { setup = async () => {}, change }) => {
    await setup(root);
    await commit(root, 'main');
    await git(root, ['switch', '-c', 'feature']);
    if (change) { await change(root); await commit(root, 'feature'); }
  };
  const check = (judged, id = 'forbidden-pattern-check') => judged.security.checks.find(c => c.id === id);

  describe('given a pull request', () => {
    it('when the PR diff is empty then the content checks fail and so does the Judge', () => fixture(async root => {
      await pr(root, {});
      const judged = await runCompletionJudge({ root, base: 'main', needs });
      assert.equal(check(judged).status, 'FAIL');
      assert.match(check(judged).reason, /no changed file/);
      assert.equal(judged.status, 'FAIL');
    }));

    it('when the PR only deletes a file then the content checks pass as deletion-only with the deleted file', () => fixture(async root => {
      await pr(root, { setup: root => writeFile(join(root, 'docs/old-184.md'), '# old\n'), change: root => git(root, ['rm', '-q', 'docs/old-184.md']) });
      const judged = await runCompletionJudge({ root, base: 'main', needs });
      for (const id of ['secret-scan', 'forbidden-pattern-check']) {
        assert.equal(check(judged, id).status, 'PASS', id);
        assert.equal(check(judged, id).reason, 'deletion-only', id);
        assert.deepEqual(check(judged, id).deleted, ['docs/old-184.md'], id);
      }
    }));

    it('when the PR adds an SBI snapshot whose Issue names a forbidden pattern then forbidden-pattern-check excludes it and secret-scan reads it', () => fixture(async root => {
      await pr(root, { change: async root => {
        const sbi = await readJson(join(root, '.harness/state/sample-sbi.json'));
        await writeFile(join(root, '.harness/state/sbi-9.json'), JSON.stringify({ ...sbi, description: `${unsafe} = 0 を使わない` }));
        await writeFile(join(root, 'docs/tls-184.md'), '# TLS\n');
      } });
      const judged = await runCompletionJudge({ root, base: 'main', needs });
      assert.equal(check(judged).status, 'PASS');
      assert.deepEqual(check(judged).excluded, ['.harness/state/sbi-9.json']);
      assert.deepEqual(check(judged, 'secret-scan').scanned, ['.harness/state/sbi-9.json', 'docs/tls-184.md']);
    }));

    it('when the PR adds a binary file then it is uninspectable and not counted as scanned', () => fixture(async root => {
      await pr(root, { change: root => writeFile(join(root, 'docs/logo-184.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0])) });
      const judged = await runCompletionJudge({ root, base: 'main', needs });
      assert.equal(check(judged).status, 'PASS');
      assert.deepEqual(check(judged).scanned, []);
      assert.deepEqual(check(judged).uninspectable, ['docs/logo-184.png']);
    }));

    it('when the base SHA the workflow names is not what the base ref resolves to then fails', () => fixture(async root => {
      await pr(root, { change: root => writeFile(join(root, 'docs/x-184.md'), '# x\n') });
      const judged = await runCompletionJudge({ root, base: 'main', needs, expectedBaseSha: 'b'.repeat(40) });
      assert.equal(judged.status, 'FAIL');
      assert.ok(judged.reasons.some(r => /^base sha: main is /.test(r)), judged.reasons.join('; '));
    }));

    it('when the base SHA the workflow names matches the base ref then no base reason is added', () => fixture(async root => {
      await pr(root, { change: root => writeFile(join(root, 'docs/x-184.md'), '# x\n') });
      const expectedBaseSha = (await git(root, ['rev-parse', 'main'])).stdout.trim();
      const judged = await runCompletionJudge({ root, base: 'main', needs, expectedBaseSha });
      assert.equal(judged.reasons.some(r => r.startsWith('base sha:')), false, judged.reasons.join('; '));
    }));
  });

  describe('given a push to main (--all)', () => {
    it('when judged then every tracked file at HEAD is read in full and nothing untracked is', () => fixture(async root => {
      await writeFile(join(root, 'untracked-184.mjs'), `process.env.${unsafe} = 0;\n`);
      await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
      await writeFile(join(root, 'node_modules/pkg/index.js'), `process.env.${unsafe} = 0;\n`);
      const tracked = (await git(root, ['ls-tree', '-r', '--name-only', 'HEAD'])).stdout.split('\n').filter(Boolean);
      const judged = await runCompletionJudge({ root, all: true, needs });
      const c = check(judged);
      assert.equal(c.status, 'PASS', JSON.stringify(c.findings));
      assert.equal(c.diff.entries, tracked.length);
      assert.equal(c.scanned.length + c.excluded.length + c.uninspectable.length, tracked.length);
      assert.ok(c.scanned.includes('apps/admin/.env.example'));
      assert.equal(c.scanned.includes('untracked-184.mjs'), false);
      assert.equal(c.scanned.some(path => path.startsWith('node_modules/')), false);
      assert.deepEqual(c.exceptions.map(e => e.path), ['tools/harness/security-enforcement.test.mjs']);
    }));

    it('when a tracked fixture spells out a forbidden pattern then the policy exception is recorded with its path and reason', () => fixture(async root => {
      const c = check(await runCompletionJudge({ root, all: true, needs }));
      const policy = await readJson(join(root, '.harness/rules/security.json'));
      assert.deepEqual(c.exceptions, policy.contentScanExceptions.map(e => ({ path: e.path, reason: e.reason })));
    }));

    it('when a tracked file at HEAD holds a forbidden pattern then fails even though the working tree no longer has it', () => fixture(async root => {
      await writeFile(join(root, 'docs/unsafe-184.mjs'), `process.env.${unsafe} = 0;\n`);
      await commit(root, 'unsafe');
      await writeFile(join(root, 'docs/unsafe-184.mjs'), 'export {};\n');
      const judged = await runCompletionJudge({ root, all: true, needs });
      assert.equal(check(judged).status, 'FAIL');
      assert.deepEqual(check(judged).findings.map(f => f.path), ['docs/unsafe-184.mjs']);
    }));
  });
});
