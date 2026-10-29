import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './workspace.mjs';
// rails-authz-test verifier, static step: the API authorization specs exist and none of their examples is skipped or focused.
// Running them on the local test database is a separate command in harness.json. Which role may do what is decided in
// docs/product and ADRs and written into these specs by the SBI that implements it; the Harness does not decide it.
const directory = 'apps/api/spec/authorization';
const authorizationSpec = /^apps\/api\/spec\/authorization\/.+_spec\.rb$/;
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

export async function checkAuthorizationSpecs({ root }) {
  const listed = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', directory]);
  const specs = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(path => authorizationSpec.test(path)).sort();
  const errors = specs.length ? [] : [`${directory}: no authorization spec (*_spec.rb) to run`];
  const findings = [];
  for (const path of specs) for (const finding of inspectAuthorizationSpec(await readFile(join(root, path), 'utf8'))) findings.push({ path, ...finding });
  return { status: errors.length || findings.length ? 'FAIL' : 'PASS', specs, findings, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const result = await checkAuthorizationSpecs({ root });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const f of result.findings) console.error(`NOT RUN ${f.path}:${f.line} ${f.marker}`);
  console.log(`Authorization specs (${result.specs.length} specs, static): ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
