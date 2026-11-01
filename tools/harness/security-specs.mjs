import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The Security Verifiers that run one directory of tests (#165). The run decides (#246): RSpec on the local test database, or the app's own
// Vitest or Jest, judged by the counts it reports (rspecRunner, checkTestReport). The static step here (the tests exist, none is skipped,
// focused or made to pass by failing) is an aid that reads files only, without Git, so it works on the host (compose) and in the container.
// What the tests assert is decided in docs/product and ADRs and written by the SBI that implements it, never by the Harness.
// Markers an RSpec file may carry at the start of a statement: line start, after ; { ( or do, or as RSpec.xdescribe (review of #246).
const statement = name => new RegExp(`(?:^|[;{(]|\\bdo\\b|\\bRSpec\\.)\\s*${name}\\b`);
const rspecMarkers = [
  ...['xit', 'xspecify', 'xexample', 'xdescribe', 'xcontext', 'fit', 'fdescribe', 'fcontext'].map(name => [name, statement(name)]),
  // Statement and metadata forms (skip "...", it "...", skip: true / :skip, { skip }, do skip ... end).
  ['skip', new RegExp(`${statement('skip').source}|\\bskip:|:skip\\b`)], ['pending', new RegExp(`${statement('pending').source}|\\bpending:|:pending\\b`)], ['focus', /\bfocus:|:focus\b/],
];
// Vitest and Jest: modifiers on it / test / describe (it.skip, it['skip'], describe.only, test.skipIf, it.todo), test options ({ skip: true }),
// ctx.skip(), the x / f aliases, a modifier taken out of it, and tests that pass by failing (it.fails, test.failing).
const modifier = names => new RegExp(`\\.(?:${names})\\b|\\[\\s*['"\`](?:${names})['"\`]\\s*\\]|\\b(?:${names})\\s*:`);
const jsMarkers = [
  ['skip', modifier('skip|skipIf')], ['runIf', modifier('runIf')], ['only', modifier('only')], ['todo', modifier('todo')], ['fails', modifier('fails')], ['failing', modifier('failing')],
  ['xit', /\bxit\s*\(/], ['xtest', /\bxtest\s*\(/], ['xdescribe', /\bxdescribe\s*\(/], ['fit', /\bfit\s*\(/], ['fdescribe', /\bfdescribe\s*\(/],
  ['alias', /\{[^}]*\b(?:skip|skipIf|runIf|only|todo|fails|failing)\b[^}]*\}\s*=\s*(?:it|test|describe|suite)\b/],
];
const inspect = (markers, comment) => source => {
  const findings = [];
  source.split('\n').forEach((text, index) => {
    if (comment.test(text)) return;
    for (const [marker, pattern] of markers) if (pattern.test(text)) findings.push({ line: index + 1, marker });
  });
  return findings;
};
export const inspectRspec = inspect(rspecMarkers, /^\s*#/);
// Only a // line is a comment here; a marker after /* */ or in a * line still counts, failing closed.
export const inspectJsTest = inspect(jsMarkers, /^\s*\/\//);
const rspec = { spec: /_spec\.rb$/, inspect: inspectRspec, kind: '*_spec.rb' };
// The files each runner runs: Vitest's include of apps/admin, and jest-expo's default testMatch (*.test.*, *.spec.*, __tests__/, .mts / .cts).
const vitest = { spec: /\.test\.tsx?$/, inspect: inspectJsTest, kind: '*.test.ts(x)' };
const jest = { spec: /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$|[./](test|spec)\.[cm]?[jt]sx?$/, inspect: inspectJsTest, kind: '*.test.*, *.spec.*, __tests__/' };
// The verifier ID names its directory; the rule that requires it is in .harness/rules/security.json.
export const securitySpecSuites = {
  'rails-authz-test': { directory: 'apps/api/spec/authorization', ...rspec },
  'authn-test': { directory: 'apps/api/spec/authentication', ...rspec },
  'rails-rls-test': { directory: 'apps/api/spec/rls', ...rspec },
  'data-lifecycle-test': { directory: 'apps/api/spec/data_lifecycle', ...rspec },
  'admin-authn-test': { directory: 'apps/admin/src/features/auth', ...vitest },
  'mobile-authn-test': { directory: 'apps/mobile/src/features/auth', ...jest },
};

async function files(root, directory) {
  try {
    const entries = await readdir(join(root, directory), { recursive: true, withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => relative(root, join(e.parentPath, e.name)).replaceAll('\\', '/'))
      .filter(path => !path.split('/').includes('node_modules'));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function checkSecuritySpecs({ root, id }) {
  const suite = securitySpecSuites[id];
  if (!suite) return { status: 'FAIL', specs: [], findings: [], errors: [`${id}: unknown security spec verifier`] };
  const specs = (await files(root, suite.directory)).filter(path => suite.spec.test(path)).sort();
  const errors = specs.length ? [] : [`${suite.directory}: no spec (${suite.kind}) to run for ${id}`];
  const findings = [];
  for (const path of specs) for (const finding of suite.inspect(await readFile(join(root, path), 'utf8'))) findings.push({ path, ...finding });
  return { status: errors.length || findings.length ? 'FAIL' : 'PASS', specs, findings, errors };
}

// The verification step: the counts of the run, which also catch what the static step cannot read. Vitest's json reporter and Jest's --json
// write the same fields. Every counted test must have run and passed; zero, pending (skipped), todo, failed or an unloadable suite fails.
export const testReport = '/tmp/harness-security-tests.json';
export function checkTestReport(text) {
  let report;
  try { report = JSON.parse(text); } catch { return { status: 'FAIL', errors: ['the test report is not JSON'] }; }
  const count = key => Number.isInteger(report?.[key]) ? report[key] : null;
  const [total, passed, failed, pending, todo] = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'].map(count);
  const errors = [];
  if ([total, passed, failed, pending].includes(null)) errors.push('the test report has no test counts');
  else {
    if (total < 1) errors.push('no test ran');
    if (pending > 0) errors.push(`${pending} pending or skipped`);
    if (todo > 0) errors.push(`${todo} todo`);
    if (failed > 0) errors.push(`${failed} failed`);
    if (passed !== total) errors.push(`${passed} of ${total} passed`);
  }
  if ((count('numFailedTestSuites') ?? 0) > 0) errors.push(`${report.numFailedTestSuites} test suites failed to run`);
  return { status: errors.length ? 'FAIL' : 'PASS', errors };
}
// The RSpec run of the Rails Security Verifiers (ruby -e in the api container): only the directory, zero examples fail, and the JSON summary
// must show no pending (skip, xit, pending) example and every declared example run, so focus or a tag filter cannot leave one out.
export const rspecRunner = directory => [
  'require "rspec/core"; require "json"; out = "tmp/harness-security-rspec.json"',
  'RSpec.configure { |c| c.fail_if_no_examples = true }',
  `status = RSpec::Core::Runner.run(["${directory}", "--format", "progress", "--format", "json", "--out", out])`,
  's = JSON.parse(File.read(out))["summary"]; declared = RSpec.world.example_groups.flat_map(&:descendants).sum { |g| g.examples.size }',
  'problems = []; problems << "no example ran" if s["example_count"].zero?; problems << "#{s["pending_count"]} pending or skipped" if s["pending_count"].positive?',
  'problems << "#{declared - s["example_count"]} of #{declared} examples not run (focus or a filter)" if s["example_count"] != declared',
  'warn "Security specs: #{problems.join("; ")}" unless problems.empty?; exit(status.zero? && problems.empty? ? 0 : 1)',
].join('; ');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const [id, flag, path] = process.argv.slice(2);
  if (flag === '--report') {
    let text = '';
    try { text = await readFile(resolve(path), 'utf8'); } catch { /* judged as no report below */ }
    const judged = text ? checkTestReport(text) : { status: 'FAIL', errors: [`${path}: no test report`] };
    for (const line of judged.errors) console.error(`ERROR ${line}`);
    console.log(`Security tests of ${id} (report): ${judged.status}`);
    process.exit(judged.status === 'PASS' ? 0 : 1);
  }
  const result = await checkSecuritySpecs({ root, id });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const f of result.findings) console.error(`NOT RUN ${f.path}:${f.line} ${f.marker}`);
  console.log(`Security specs of ${id} (${result.specs.length} specs, static): ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
