import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Trusted acceptance for SBI-CI-MATRIX (#34). Reads the worktree and evaluates the pure Impact Analysis; it runs no verifier command.
const root = process.argv[2];
const read = path => readFileSync(join(root, path), 'utf8');
const workflow = () => read('.github/workflows/harness.yml');
const config = () => JSON.parse(read('.harness/config/harness.json'));
const pkg = () => JSON.parse(read('package.json'));
const { analyzeImpact, judgeCi } = await import(pathToFileURL(join(root, 'tools/harness/impact.mjs')).href);
const { verify } = await import(pathToFileURL(join(root, 'tools/harness/verifier.mjs')).href);
const sbi = (affectedAreas, extra = {}) => ({ id: 'SBI-T', acceptanceCriteria: [], requiredVerifiers: [], affectedAreas, ...extra });
const files = (...paths) => paths.map(path => ({ path }));
const paths = { api: 'apps/api/config/routes.rb', mobile: 'apps/mobile/src/app/index.tsx', admin: 'apps/admin/src/main.tsx' };
const requiredFor = areas => analyzeImpact({ config: config(), sbis: [sbi(areas)], files: files(...areas.map(a => paths[a])) }).requiredVerifiers;
const job = name => workflow().match(new RegExp(`^ {2}${name}:\\n((?: {4,}.*\\n|\\s*\\n)*)`, 'm'))?.[1] ?? '';
try {
  const scenarios = [
    ['CI-AC-1', 'Given an SBI, When it names several areas, Then affectedAreas is part of the SBI schema and verifiers declare their areas', () => {
      assert.match(read('tools/harness/schemas.mjs'), /affectedAreas/);
      for (const id of ['rails', 'expo', 'admin', 'prototype-web', 'prototype-mobile', 'api-contract']) assert.ok(config().verifiers.find(v => v.id === id)?.areas?.length, `${id} areas`);
    }],
    ['CI-AC-2', 'Given an SBI and a diff, When analysing impact, Then required verifiers are decided', () => {
      assert.deepEqual(requiredFor(['admin']), ['admin']);
    }],
    ['CI-AC-3', 'Given an SBI and a diff that disagree, When analysing impact, Then the verifier for the extra diff is added', () => {
      const impact = analyzeImpact({ config: config(), sbis: [sbi(['admin'])], files: files(paths.admin, paths.mobile) });
      assert.ok(impact.requiredVerifiers.includes('expo'));
    }],
    ['CI-AC-4', 'Given the Harness CLI, When running one verifier, Then harness:verify --verifier exists', () => {
      assert.match(pkg().scripts['harness:verify'], /cli\.mjs verify/);
      assert.match(read('tools/harness/cli.mjs'), /command === 'verify'/);
    }],
    ['CI-AC-5', 'Given GitHub Actions, When verifiers are required, Then they run as a dynamic matrix', () => {
      const verifiers = job('verifiers');
      assert.match(verifiers, /fail-fast:\s*false/);
      assert.match(verifiers, /fromJson\(needs\.impact\.outputs\.required_verifiers\)/);
      assert.match(verifiers, /harness:verify --verifier \$\{\{ matrix\.verifier \}\}/);
    }],
    ['CI-AC-6', 'Given an admin only SBI, When analysing, Then only admin is required', () => assert.deepEqual(requiredFor(['admin']), ['admin'])],
    ['CI-AC-7', 'Given a mobile only SBI, When analysing, Then only the mobile verifier is required', () => assert.deepEqual(requiredFor(['mobile']), ['expo'])],
    ['CI-AC-8', 'Given an api only SBI, When analysing, Then the rails verifier is required', () => assert.deepEqual(requiredFor(['api']), ['rails'])],
    ['CI-AC-9', 'Given an api + mobile SBI, When analysing, Then rails / mobile / api-contract are required', () => assert.deepEqual(requiredFor(['api', 'mobile']), ['api-contract', 'expo', 'rails'])],
    ['CI-AC-10', 'Given an api + admin SBI, When analysing, Then rails / admin / api-contract are required', () => assert.deepEqual(requiredFor(['api', 'admin']), ['admin', 'api-contract', 'rails'])],
    ['CI-AC-11', 'Given an api + mobile + admin SBI, When analysing, Then rails / mobile / admin / api-contract are required', () => {
      assert.deepEqual(requiredFor(['api', 'mobile', 'admin']), ['admin', 'api-contract', 'expo', 'rails']);
    }],
    ['CI-AC-12', 'Given prototype SBIs, When analysing, Then the prototype verifiers are selected the same way', () => {
      assert.deepEqual(analyzeImpact({ config: config(), sbis: [sbi(['prototype-web'])], files: files('prototypes/web/src/main.tsx') }).requiredVerifiers, ['prototype-web']);
      assert.deepEqual(analyzeImpact({ config: config(), sbis: [sbi(['prototype-mobile'])], files: files('prototypes/mobile/index.ts') }).requiredVerifiers, ['prototype-mobile']);
    }],
    ['CI-AC-13', 'Given the matrix, When one required verifier fails, Then the Completion Judge fails', () => {
      const impact = analyzeImpact({ config: config(), sbis: [], files: files(paths.admin) });
      const needs = { impact: { result: 'success' }, verifiers: { result: 'failure' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };
      assert.equal(judgeCi({ impact, needs, acceptance: { status: 'PASS', missing: [] } }).status, 'FAIL');
      assert.match(job('harness'), /if:\s*always\(\)/);
      assert.match(job('harness'), /harness:judge/);
    }],
    ['CI-AC-14', 'Given a required verifier, When its app is missing or unconfigured, Then the result is not PASS', async () => {
      const result = await verify({ root, workspace: root, config: config(), sbi: sbi([]), files: files(paths.api), only: new Set(['api-contract']), selected: new Map([['api-contract', true]]) });
      assert.notEqual(result.status, 'PASS');
    }],
    ['CI-AC-15', 'Given a Harness change, When analysing, Then the Full Gate runs harness:test and harness:demo --full', () => {
      for (const path of ['tools/harness/verifier.mjs', '.harness/config/harness.json', '.harness/verification/admin-env.mjs', '.harness/rules/pr-risk.json']) {
        assert.equal(analyzeImpact({ config: config(), sbis: [], files: files(path) }).fullGate, true, path);
      }
      assert.match(job('harness-test'), /full_gate == 'true'/);
      assert.match(job('harness-test'), /pnpm harness:test/);
      assert.match(job('harness-demo'), /full_gate == 'true'/);
      assert.match(job('harness-demo'), /pnpm harness:demo --full/);
    }],
    ['CI-AC-16', 'Given a normal SBI, When CI runs, Then the Harness E2E is not run serially every time', () => {
      assert.equal(analyzeImpact({ config: config(), sbis: [sbi(['admin'])], files: files(paths.admin) }).fullGate, false);
      for (const name of ['impact', 'verifiers', 'harness']) assert.doesNotMatch(job(name), /harness:(test|demo)/, name);
    }],
    ['CI-AC-17', 'Given the verifier definitions, When CI selects them, Then the workflow keeps no copy of verifier ids or commands', () => {
      for (const { id, commands } of config().verifiers) {
        assert.doesNotMatch(workflow(), new RegExp(`\\b${id}\\b(?!-)`), `workflow names ${id}`);
        for (const command of commands) assert.ok(!workflow().includes(command.join(' ')), `workflow repeats ${command.join(' ')}`);
      }
    }],
    ['CI-AC-18', 'Given the CI log, When reading the impact job, Then each verifier selection carries its reasons', () => {
      const impact = analyzeImpact({ config: config(), sbis: [sbi(['api', 'mobile'])], files: files(paths.api, paths.mobile) });
      for (const entry of impact.verifiers) assert.ok(entry.reasons.length > 0, entry.id);
      assert.match(job('impact'), /pnpm harness:impact/);
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { await test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
