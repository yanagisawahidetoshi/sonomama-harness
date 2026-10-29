import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderSbiBody } from './planner.mjs';
import { sbiFromIssue } from './sbi-issue.mjs';
import { analyzeImpact, judgeCi } from './impact.mjs';
import { maestroLanes, judgeMaestro, maestroResultFromJunit, readMaestroResults } from './maestro.mjs';
import { execute } from './io.mjs';

const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
const pbi = { owner: 'acme', repo: 'app', number: 3, url: 'https://github.com/acme/app/issues/3', title: '受講生のホーム' };
const planned = (overrides = {}) => ({
  id: 'SBI-001', kind: 'implementation', title: 'ホームに見出しを表示する', purpose: '受講生がホームを開くと見出しが表示される。',
  scope: { included: ['apps/mobile ホーム画面'], excluded: [] },
  acceptanceCriteria: [{ id: 'AC-1', description: '見出しが表示される' }],
  scenarios: [{ name: 'ホームを開く', given: ['受講生である'], when: ['ホームを開く'], then: ['見出しが表示される'], acceptanceIds: ['AC-1'], test: 'Jest: apps/mobile/src/features/home/index.test.tsx' }],
  dependsOn: [], changeAreas: ['apps/mobile'], layers: ['画面Component'], estimatedFiles: 3, oversizeReason: null, riskCandidate: 'L2', securityImpact: [],
  verification: { applicationTest: 'Jest + RNTL', acceptance: 'Trusted Acceptance', e2e: 'Maestro: apps/mobile/.maestro/mock/home.yaml' },
  ...overrides,
});
const config = { verifiers: [{ id: 'issue-7-acceptance', trust: 'acceptance', trustedScript: '.harness/verification/issue-7.mjs', directory: '.', planned: ['ホーム'], commands: [], acceptanceIds: ['AC-1'], sbiIssue: 7 }] };
const sbiOf = overrides => sbiFromIssue({ ref, issue: { number: 7, title: 'SBI-001 ホーム', body: renderSbiBody(planned(overrides), pbi), html_url: ref.url, state: 'open', labels: [] }, config });
// Only the SBI of a Harness Run snapshot (from an approved SBI Issue) picks a lane; hand-written SBI JSON never does.
const lanesOf = (...sbis) => analyzeImpact({ config: { verifiers: [] }, sbis, runSbis: sbis, files: [{ path: 'apps/mobile/src/features/home/index.tsx' }] }).maestro;

describe('E2E target of an SBI Issue', () => {
  it('when the Issue names a Maestro flow in its verification then the SBI carries that E2E line', () => {
    assert.equal(sbiOf().e2e, 'Maestro: apps/mobile/.maestro/mock/home.yaml');
  });
  it('when the Issue says E2E is not needed then the SBI carries that answer', () => {
    assert.equal(sbiOf({ verification: { applicationTest: 'Jest + RNTL', acceptance: 'Trusted Acceptance', e2e: '不要' } }).e2e, '不要');
  });
  it('when the Issue was planned without a verification section then the SBI has no E2E line', () => {
    const issue = { number: 7, title: 'SBI-001 ホーム', body: renderSbiBody(planned(), pbi).replace(/## 検証方法\n\n```text\n[\s\S]*?```\n\n/, ''), html_url: ref.url, state: 'open', labels: [] };
    assert.equal(sbiFromIssue({ ref, issue, config }).e2e, null);
  });
});

describe('Maestro lanes from Impact Analysis', () => {
  it('when an implementation SBI changes apps/mobile and asks for E2E then Maestro runs against the mock API', () => {
    assert.deepEqual(lanesOf(sbiOf()), ['mock']);
  });
  it('when a validation SBI changes apps/mobile then Maestro runs against the real API, Rails and DB', () => {
    assert.deepEqual(lanesOf(sbiOf({ kind: 'validation', verification: { applicationTest: '不要', acceptance: 'Trusted Acceptance', e2e: 'Maestro: apps/mobile/.maestro/real/home.yaml' } })), ['real']);
  });
  for (const [name, overrides] of [
    ['an implementation SBI says E2E is not needed', { verification: { applicationTest: 'Jest + RNTL', acceptance: 'Trusted Acceptance', e2e: '不要' } }],
    ['an implementation SBI only changes the admin app', { changeAreas: ['apps/admin'], scope: { included: ['apps/admin ホーム'], excluded: [] } }],
  ]) {
    it(`when ${name} then Maestro does not run`, () => assert.deepEqual(lanesOf(sbiOf(overrides)), []));
  }
  it('when only a hand-written SBI JSON without a source Issue changes apps/mobile then Maestro does not run', () => {
    const handWritten = { id: 'SBI-MOBILE-ENV', kind: 'implementation', allowedFiles: ['apps/mobile/package.json'], acceptanceCriteria: [] };
    assert.deepEqual(analyzeImpact({ config: { verifiers: [] }, sbis: [handWritten], files: [{ path: 'apps/mobile/package.json' }] }).maestro, []);
  });
  it('when a mobile change has no SBI then Maestro does not run, so ordinary mobile PRs stay fast', () => {
    assert.deepEqual(lanesOf(), []);
  });
  it('when both kinds are in one PR then both lanes run', () => {
    assert.deepEqual(lanesOf(sbiOf(), sbiOf({ kind: 'validation' })), ['mock', 'real']);
  });
  it('when the SBI has no E2E line then the lane is still required so a missing answer fails closed', () => {
    assert.deepEqual(maestroLanes([{ kind: 'implementation', allowedDirs: ['apps/mobile/'], e2e: null }]), ['mock']);
  });
});

describe('Maestro result from the JUnit report', () => {
  const junit = cases => `<?xml version="1.0"?><testsuites><testsuite name="Test Suite" tests="${cases.length}">${cases.join('')}</testsuite></testsuites>`;
  const pass = name => `<testcase id="${name}" name="${name}" classname="${name}" time="3.1" status="SUCCESS"/>`;
  const fail = name => `<testcase id="${name}" name="${name}" classname="${name}" time="2.0" status="ERROR"><failure>Element not found: home-title</failure></testcase>`;
  const result = (xml, extra = {}) => maestroResultFromJunit({ lane: 'mock', junit: xml, headSha: 'a'.repeat(40), artifacts: ['maestro-mock'], ...extra });
  it('when every flow passed then the result PASSes and lists each flow', () => {
    assert.deepEqual(result(junit([pass('home'), pass('login')])), { version: 1, lane: 'mock', headSha: 'a'.repeat(40), status: 'PASS', flows: [{ name: 'home', status: 'PASS' }, { name: 'login', status: 'PASS' }], artifacts: ['maestro-mock'] });
  });
  it('when a flow failed then the result FAILs and keeps the failure message', () => {
    const value = result(junit([pass('home'), fail('login')]));
    assert.equal(value.status, 'FAIL');
    assert.deepEqual(value.flows[1], { name: 'login', status: 'FAIL', message: 'Element not found: home-title' });
  });
  it('when the report has no flow then the result FAILs', () => assert.equal(result(junit([])).status, 'FAIL'));
});

describe('Maestro in the Completion Judge', () => {
  const headSha = 'a'.repeat(40);
  const ok = lane => ({ version: 1, lane, headSha, status: 'PASS', flows: [{ name: 'home', status: 'PASS' }], artifacts: [`maestro-${lane}`] });
  const judge = (results, needs = { maestro: { result: 'success' } }, lanes = ['mock']) => judgeMaestro({ lanes, needs, results, headSha });
  it('when no lane is required then nothing is judged', () => assert.deepEqual(judge({}, {}, []), []));
  it('when the job passed and the result covers the lane on the tested commit then it passes', () => assert.deepEqual(judge({ mock: ok('mock') }), []));
  for (const [name, results, needs, pattern] of [
    ['the maestro job was skipped', { mock: ok('mock') }, { maestro: { result: 'skipped' } }, /maestro: skipped/],
    ['the maestro job failed', { mock: ok('mock') }, { maestro: { result: 'failure' } }, /maestro: failure/],
    ['the maestro job did not report', { mock: ok('mock') }, {}, /maestro: missing/],
    ['the result of the lane is missing', {}, undefined, /mock.*result/],
    ['the result is for another commit', { mock: { ...ok('mock'), headSha: 'b'.repeat(40) } }, undefined, /mock.*bbbbbbbbbbbb/],
    ['the result is for another lane', { mock: ok('real') }, undefined, /mock.*lane/],
    ['the result ran no flow', { mock: { ...ok('mock'), flows: [] } }, undefined, /mock.*flow/],
    ['a flow failed', { mock: { ...ok('mock'), status: 'FAIL', flows: [{ name: 'home', status: 'FAIL', message: 'x' }] } }, undefined, /mock.*home/],
    ['no log or screenshot was kept', { mock: { ...ok('mock'), artifacts: [] } }, undefined, /mock.*evidence/],
    ['the result could not be read', { mock: { error: 'Unexpected token' } }, undefined, /mock.*Unexpected token/],
  ]) {
    it(`when ${name} then it fails closed`, () => assert.match(judge(results, needs).join('\n'), pattern));
  }
  it('when Impact Analysis requires a lane then judgeCi fails without the maestro job', () => {
    const impact = { ...analyzeImpact({ config: { verifiers: [] }, files: [] }), maestro: ['mock'] };
    const needs = { impact: { result: 'success' }, verifiers: { result: 'skipped' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };
    const security = { status: 'PASS', requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }], violations: [] };
    const result = judgeCi({ impact, needs, acceptance: { status: 'PASS', missing: [] }, security, maestro: { headSha, results: {} } });
    assert.equal(result.status, 'FAIL');
    assert.ok(result.reasons.some(r => r.startsWith('maestro')), result.reasons.join('; '));
  });
  it('when the results directory is read then each lane file is parsed, and a broken file is kept as an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-maestro-'));
    try {
      await writeFile(join(dir, 'mock.json'), JSON.stringify(ok('mock')));
      await writeFile(join(dir, 'real.json'), '{');
      const results = await readMaestroResults(dir, ['mock', 'real']);
      assert.equal(results.mock.status, 'PASS');
      assert.ok(results.real.error);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('maestro-result CLI', () => {
  it('when the JUnit report is given then writes the result JSON the Completion Judge reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-maestro-cli-'));
    try {
      await writeFile(join(dir, 'report.xml'), '<testsuites><testsuite><testcase name="home" status="SUCCESS"/></testsuite></testsuites>');
      const out = join(dir, 'mock.json');
      const run = await execute(process.execPath, [new URL('./maestro.mjs', import.meta.url).pathname, '--lane', 'mock', '--junit', join(dir, 'report.xml'), '--head', 'a'.repeat(40), '--artifact', 'maestro-mock', '--out', out]);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(JSON.parse(await readFile(out, 'utf8')).status, 'PASS');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
