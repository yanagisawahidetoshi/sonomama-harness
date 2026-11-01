import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Static step of the Security Verifiers that run one directory of tests (#165): the tests exist and none of them is skipped or focused.
// Running them is a separate command in harness.json (RSpec on the local test database, or the app's own Vitest or Jest), which also fails on
// zero examples. What the tests assert is decided in docs/product and ADRs and written by the SBI that implements it, never by the Harness.
// This step reads files only, without Git, so it works the same on the host (compose) and inside the verifier container.
const rspecMarkers = [
  ['xit', /^\s*xit\b/], ['xspecify', /^\s*xspecify\b/], ['xexample', /^\s*xexample\b/], ['xdescribe', /^\s*xdescribe\b/],
  ['xcontext', /^\s*xcontext\b/], ['fit', /^\s*fit\b/], ['fdescribe', /^\s*fdescribe\b/], ['fcontext', /^\s*fcontext\b/],
  // Statement and metadata forms (skip "...", it "...", skip: true / :skip).
  ['skip', /^\s*skip\b|\bskip:|:skip\b/], ['pending', /^\s*pending\b|\bpending:|:pending\b/], ['focus', /\bfocus:|:focus\b/],
];
// Vitest and Jest: modifiers on it / test / describe (it.skip, describe.only, test.skipIf, it.todo), ctx.skip() and the x / f aliases.
const jsMarkers = [
  ['skip', /\.skip(If)?\b/], ['runIf', /\.runIf\b/], ['only', /\.only\b/], ['todo', /\.todo\b/],
  ['xit', /\bxit\s*\(/], ['xtest', /\bxtest\s*\(/], ['xdescribe', /\bxdescribe\s*\(/], ['fit', /\bfit\s*\(/], ['fdescribe', /\bfdescribe\s*\(/],
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
export const inspectJsTest = inspect(jsMarkers, /^\s*(\/\/|\/?\*)/);
const rspec = { spec: /_spec\.rb$/, inspect: inspectRspec, kind: '*_spec.rb' };
const js = { spec: /\.test\.(ts|tsx|js|jsx)$/, inspect: inspectJsTest, kind: '*.test.ts(x)' };
// The verifier ID names its directory; the rule that requires it is in .harness/rules/security.json.
export const securitySpecSuites = {
  'rails-authz-test': { directory: 'apps/api/spec/authorization', ...rspec },
  'authn-test': { directory: 'apps/api/spec/authentication', ...rspec },
  'rails-rls-test': { directory: 'apps/api/spec/rls', ...rspec },
  'data-lifecycle-test': { directory: 'apps/api/spec/data_lifecycle', ...rspec },
  'admin-authn-test': { directory: 'apps/admin/src/features/auth', ...js },
  'mobile-authn-test': { directory: 'apps/mobile/src/features/auth', ...js },
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const id = process.argv[2];
  const result = await checkSecuritySpecs({ root, id });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const f of result.findings) console.error(`NOT RUN ${f.path}:${f.line} ${f.marker}`);
  console.log(`Security specs of ${id} (${result.specs.length} specs, static): ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
