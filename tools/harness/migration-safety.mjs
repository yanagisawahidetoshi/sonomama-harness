import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './io.mjs';
import { git } from './workspace.mjs';
import { checkException, exceptionPath, exceptionPattern, parseException } from './migration-exception.mjs';
// migration-safety verifier, static step: every Rails migration must be additive. Applying and rolling back on the
// local test database are separate commands in harness.json so each one gets its own timeout.
// There is no bypass marker. A destructive migration passes only as the contract step of expand/contract with a request in
// db/migrate/exceptions whose machine-checkable conditions hold; the two human approvals are checked by the CI Completion Judge.
const railsMigration = /^apps\/api\/db\/migrate\/\d+_[a-z0-9_]+\.rb$/;
const dangerous = [
  'drop_table', 'drop_join_table', 'remove_column', 'remove_columns', 'remove_reference', 'remove_belongs_to', 'remove_timestamps',
  'remove_index', 'remove_foreign_key', 'rename_table', 'rename_column', 'rename_index', 'change_column', 'change_column_null',
  // Raw SQL, data rewrites and other connections are outside what the schema DSL and the rollback check can reason about.
  'execute', 'exec_query', 'exec_update', 'exec_delete', 'exec_insert', 'update_all', 'delete_all', 'destroy_all', 'truncate',
  'establish_connection',
].map(operation => [operation, new RegExp(`\\b${operation}\\b`)]);
// change_table block forms whose names differ from the operations above (t.remove, t.rename, t.change, ...).
const tableBlock = /\b(\w+)\.(remove|remove_references|rename|change|change_null)\b/g;

export function inspectMigration(source) {
  const findings = [];
  source.split('\n').forEach((text, index) => {
    if (text.trim().startsWith('#')) return;
    for (const [operation, pattern] of dangerous) if (pattern.test(text)) findings.push({ line: index + 1, operation });
    for (const match of text.matchAll(tableBlock)) findings.push({ line: index + 1, operation: `${match[1]}.${match[2]}` });
  });
  return findings;
}

export async function checkMigrations({ root }) {
  const policy = await readJson(join(root, '.harness/rules/security.json'));
  // The same paths that make SEC-MIGRATION-001 require this verifier, so nothing it gates is left unchecked.
  const locations = policy.rules.find(r => r.id === 'SEC-MIGRATION-001').pathPatterns.map(p => new RegExp(p, 'i'));
  const listed = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const paths = [...new Set(listed.stdout.split('\0').filter(Boolean))].filter(path => locations.some(p => p.test(path))).sort();
  const errors = [], findings = [], migrations = [], exceptions = [];
  const requests = new Set(paths.filter(path => exceptionPattern.test(path))), unmatched = new Set(requests);
  for (const path of paths) {
    if (requests.has(path)) continue;
    if (!railsMigration.test(path)) { errors.push(`${path}: only timestamped Rails migrations in apps/api/db/migrate can be verified`); continue; }
    migrations.push(path);
    const found = inspectMigration(await readFile(join(root, path), 'utf8'));
    const request = exceptionPath(path);
    if (!found.length || !requests.has(request)) { findings.push(...found.map(f => ({ path, ...f }))); continue; }
    unmatched.delete(request);
    const parsed = parseException(request, await readFile(join(root, request), 'utf8'));
    const problems = parsed.request ? await checkException({ root, path: request, migration: path, request: parsed.request, findings: found }) : parsed.errors;
    if (problems.length) errors.push(...problems); else exceptions.push({ migration: path, request });
  }
  for (const request of unmatched) errors.push(`${request}: 対応する破壊的migrationがありません`);
  return { status: errors.length || findings.length ? 'FAIL' : 'PASS', migrations, findings, errors, exceptions };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const result = await checkMigrations({ root });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const f of result.findings) console.error(`DANGEROUS ${f.path}:${f.line} ${f.operation}`);
  for (const e of result.exceptions) console.log(`EXCEPTION REQUESTED ${e.migration} (${e.request}); two approvals are checked by the CI Completion Judge`);
  console.log(`Migration safety (${result.migrations.length} migrations, static): ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
