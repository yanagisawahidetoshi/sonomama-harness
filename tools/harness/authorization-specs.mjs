import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './workspace.mjs';
// Static step of the Rails Security Verifiers (rails-authz-test, rails-authn-test, rails-rls-test, data-lifecycle-test): the suite's
// specs exist and none of their examples is skipped or focused. Running them on the local test database is a separate command in
// harness.json. Which role may do what is decided in docs/product and ADRs and written into these specs by the SBI that implements it;
// the Harness does not decide it.
const suites = ['authorization', 'authentication', 'rls', 'data_lifecycle'];
const suiteDirectory = suite => `apps/api/spec/${suite}`;
const markers = [
  ['xit', /^\s*xit\b/], ['xspecify', /^\s*xspecify\b/], ['xexample', /^\s*xexample\b/], ['xdescribe', /^\s*xdescribe\b/],
  ['xcontext', /^\s*xcontext\b/], ['fit', /^\s*fit\b/], ['fdescribe', /^\s*fdescribe\b/], ['fcontext', /^\s*fcontext\b/],
  // Statement and metadata forms (skip "...", it "...", skip: true / :skip).
  ['skip', /^\s*skip\b|\bskip:|:skip\b/], ['pending', /^\s*pending\b|\bpending:|:pending\b/], ['focus', /\bfocus:|:focus\b/],
];

export function inspectAuthorizationSpec(source) {
  const findings = [];
  source.split('\n').forEach((text, index) => {
    if (text.trim().startsWith('#')) return;
    for (const [marker, pattern] of markers) if (pattern.test(text)) findings.push({ line: index + 1, marker });
  });
  return findings;
}

export async function checkAuthorizationSpecs({ root, directory = suiteDirectory('authorization') }) {
  const listed = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', directory]);
  const specs = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(path => path.startsWith(`${directory}/`) && path.endsWith('_spec.rb')).sort();
  const errors = specs.length ? [] : [`${directory}: no spec (*_spec.rb) to run`];
  const findings = [];
  for (const path of specs) for (const finding of inspectAuthorizationSpec(await readFile(join(root, path), 'utf8'))) findings.push({ path, ...finding });
  return { status: errors.length || findings.length ? 'FAIL' : 'PASS', specs, findings, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const suite = process.argv[2] ?? 'authorization';
  if (!suites.includes(suite)) {
    console.error(`ERROR unknown suite ${suite} (${suites.join(', ')})`);
    process.exitCode = 2;
  } else {
    const result = await checkAuthorizationSpecs({ root, directory: suiteDirectory(suite) });
    for (const line of result.errors) console.error(`ERROR ${line}`);
    for (const f of result.findings) console.error(`NOT RUN ${f.path}:${f.line} ${f.marker}`);
    console.log(`Rails ${suite} specs (${result.specs.length} specs, static): ${result.status}`);
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  }
}
