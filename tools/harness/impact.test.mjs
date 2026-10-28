import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update } from './test-fixture.mjs';
import { readJson } from './io.mjs';
import { analyzeImpact, describeImpact, describeJudge, judgeCi, runCompletionJudge } from './impact.mjs';
import { renderSbiBody } from './planner.mjs';
import { sbiFromIssue } from './sbi-issue.mjs';
import { withAcceptance } from './acceptance-registry.mjs';
import { snapshotFromIssue, snapshotPath } from './sbi-source.mjs';
import { git } from './workspace.mjs';
import { verify } from './verifier.mjs';
import { check } from './check.mjs';

const config = await readJson(new URL('../../.harness/config/harness.json', import.meta.url));
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
      assert.ok(lines.includes(`SBI required: yes (production:${touched.api})`));
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
        assert.ok(describeImpact(impact).includes('SBI required: no (no production path changed)'));
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
    const judgeBranch = (root, verifiers = 'success') => runCompletionJudge({ root, base: 'main', needs: needs(verifiers), repository: 'acme/app', github: { fetchIssue: async () => readyIssue } });
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
