import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './io.mjs';
import { git } from './workspace.mjs';
// migration-safety verifier, static step: every Rails migration must be additive. Applying and rolling back on the
// local test database are separate commands in harness.json so each one gets its own timeout.
// There is no bypass marker: a destructive migration needs a human decision outside this verifier.
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
  const errors = [], findings = [], migrations = [];
  for (const path of paths) {
    if (!railsMigration.test(path)) { errors.push(`${path}: only timestamped Rails migrations in apps/api/db/migrate can be verified`); continue; }
    migrations.push(path);
    for (const finding of inspectMigration(await readFile(join(root, path), 'utf8'))) findings.push({ path, ...finding });
  }
  return { status: errors.length || findings.length ? 'FAIL' : 'PASS', migrations, findings, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const result = await checkMigrations({ root });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const f of result.findings) console.error(`DANGEROUS ${f.path}:${f.line} ${f.operation}`);
  console.log(`Migration safety (${result.migrations.length} migrations, static): ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
