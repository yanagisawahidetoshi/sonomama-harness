import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// admin-authn-test / mobile-authn-test verifier, static step: the app's authentication tests (*.authn.test.ts(x), next to the code they
// test) exist and none of their examples is skipped, focused or left undone. The test runner is a separate command in harness.json.
// It reads the file system, not Git, because it runs inside the verifier container where the worktree's Git directory is not mounted.
const apps = ['admin', 'mobile'];
const authnTest = /\.authn\.test\.tsx?$/;
const markers = [
  // it.skip, describe.only, it.concurrent.skip, it.skipIf(...), test.todo, it.failing ...
  [/^\s*(?:describe|context|suite|it|test)(?:\.\w+)*?\.(skip|only|todo|skipIf|runIf|failing|fails)\b/, m => m[0].trim()],
  [/^\s*(xit|xtest|xdescribe|fit|fdescribe)\b/, m => m[1]],
];

export function inspectAuthnTest(source) {
  const findings = [];
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    for (const [pattern, marker] of markers) {
      const match = pattern.exec(text);
      if (match) { findings.push({ line: index + 1, marker: marker(match) }); break; }
    }
  });
  return findings;
}

async function listTests(root, directory) {
  const found = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true }).catch(() => [])) {
    const path = `${directory}/${entry.name}`;
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...await listTests(root, path));
    else if (entry.isFile() && authnTest.test(entry.name)) found.push(path);
  }
  return found;
}

export async function checkAuthnTests({ root, app }) {
  if (!apps.includes(app)) throw new Error(`unknown app ${app} (${apps.join(', ')})`);
  const directory = `apps/${app}/src`;
  const tests = (await listTests(root, directory)).sort();
  const errors = tests.length ? [] : [`${directory}: no authentication test (*.authn.test.ts or *.authn.test.tsx) to run`];
  const findings = [];
  for (const path of tests) for (const finding of inspectAuthnTest(await readFile(join(root, path), 'utf8'))) findings.push({ path, ...finding });
  return { status: errors.length || findings.length ? 'FAIL' : 'PASS', tests, findings, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const app = process.argv[2];
  if (!apps.includes(app)) {
    console.error(`ERROR unknown app ${app} (${apps.join(', ')})`);
    process.exitCode = 2;
  } else {
    const result = await checkAuthnTests({ root, app });
    for (const line of result.errors) console.error(`ERROR ${line}`);
    for (const f of result.findings) console.error(`NOT RUN ${f.path}:${f.line} ${f.marker}`);
    console.log(`${app} authentication tests (${result.tests.length} files, static): ${result.status}`);
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  }
}
