import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './workspace.mjs';
// A destructive migration passes migration-safety only as the contract step of an expand/contract migration, with a request beside it.
// migration-safety checks what a machine can (the operations, the expand commit on main, no remaining reference); two people with write
// access approve the rest by posting the rendered text as a review on the tested commit, which the CI Completion Judge reads from GitHub
// (migration-exception-approval.mjs). This module has no dependency, since migration-safety runs it as a plain script.
export const exceptionPattern = /^apps\/api\/db\/migrate\/exceptions\/(\d+)\.json$/;
export const exceptionPath = migration => `apps/api/db/migrate/exceptions/${/\/(\d+)_[^/]+\.rb$/.exec(migration)?.[1]}.json`;
const sha256 = text => createHash('sha256').update(text).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);

export function exceptionDigest({ migration, source, request }) {
  return sha256(canonical({ migration, migrationDigest: sha256(source), request }));
}

const isoTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && !Number.isNaN(Date.parse(value));
const filled = value => typeof value === 'string' && value.trim().length > 0;
const safePath = value => filled(value) && !value.startsWith('/') && value.split('/').every(s => s && s !== '.' && s !== '..');
const columnName = value => typeof value === 'string' && /^[a-z_][a-z0-9_]*$/.test(value);
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));
// The request is the approval context, so every field is checked strictly; a merge to main is never a production deployment.
function validate(value) {
  const errors = [], need = (ok, field, message) => { if (!ok) errors.push(`${field}: ${message}`); };
  need(only(value, ['version', 'migration', 'operations', 'expand', 'removes', 'rollback', 'dataBackup', 'productionState']), '(root)', '未知の項目があります');
  need(value?.version === 1, 'version', '1 が必要です');
  need(safePath(value?.migration), 'migration', 'migrationのpathが必要です');
  need(Array.isArray(value?.operations) && value.operations.length > 0 && value.operations.every(o => only(o, ['line', 'operation']) && Number.isInteger(o.line) && o.line > 0 && filled(o.operation)), 'operations', '{ line, operation } が1件以上必要です');
  need(only(value?.expand, ['migration', 'commit']) && safePath(value.expand.migration) && /^[0-9a-f]{40}$/.test(value.expand.commit ?? ''), 'expand', '{ migration, commit（40桁のSHA） } が必要です');
  need(Array.isArray(value?.removes) && value.removes.length > 0 && value.removes.every(r => only(r, ['table', 'column']) && columnName(r.table) && (r.column === undefined || columnName(r.column))), 'removes', '{ table, column? } が1件以上必要です');
  // migration-safety rolls every migration back to VERSION=0, so an irreversible contract step cannot pass anyway.
  need(only(value?.rollback, ['possible', 'procedure']) && value.rollback.possible === true && filled(value.rollback.procedure), 'rollback', 'possible: true と procedure が必要です');
  need(only(value?.dataBackup, ['taken', 'location']) && typeof value.dataBackup.taken === 'boolean' && (value.dataBackup.location === undefined || filled(value.dataBackup.location)), 'dataBackup', '{ taken, location? } が必要です');
  const production = value?.productionState;
  need(production?.state === 'deployed' ? only(production, ['state', 'deploymentRef', 'deployedAt', 'confirmedBy']) && filled(production.deploymentRef) && isoTime(production.deployedAt) && filled(production.confirmedBy)
    : production?.state === 'not_provisioned' && only(production, ['state']), 'productionState', 'deployed（deploymentRef・deployedAt・confirmedBy）か not_provisioned が必要です');
  return errors;
}

export function parseException(path, text) {
  let value;
  try { value = JSON.parse(text); } catch (error) { return { errors: [`${path}: JSONとして読めません（${error.message}）`] }; }
  const errors = validate(value);
  return errors.length ? { errors: [`${path}: ${errors.join(', ')}`] } : { request: value, errors: [] };
}

// The machine-checkable conditions of the contract step. Returns the errors; none means the request may go to human approval.
export async function checkException({ root, path, migration, request, findings, base = 'main' }) {
  const errors = [];
  if (request.migration !== migration) errors.push(`${path}: migration ${request.migration} は ${migration} ではありません`);
  const key = f => `${f.line}:${f.operation}`;
  const listed = request.operations.map(key).sort(), found = findings.map(key).sort();
  if (listed.join() !== found.join()) errors.push(`${path}: operations ${listed.join(', ')} が ${migration} の破壊操作 ${found.join(', ')} と一致しません`);
  const { commit, migration: expandMigration } = request.expand;
  if (expandMigration === migration) errors.push(`${path}: expand migration が破壊的migration自身です`);
  if (!(await git(root, ['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${base}`], true)).ok) errors.push(`${path}: expand commit ${commit.slice(0, 12)} が origin/${base} にmergeされていません`);
  else if (!(await git(root, ['cat-file', '-e', `${commit}:${expandMigration}`], true)).ok) errors.push(`${path}: expand migration ${expandMigration} が expand commit ${commit.slice(0, 12)} にありません`);
  // The application, its configuration and the API contract must no longer name what is removed; ignored_columns is the expand step itself.
  const listedFiles = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps/api/app', 'apps/api/lib', 'apps/api/config', 'packages/api-schema'])).stdout.split('\0').filter(Boolean);
  for (const { table, column } of request.removes) {
    const name = column ?? table, word = new RegExp(`\\b${name}\\b`);
    for (const file of listedFiles) {
      const lines = (await readFile(join(root, file), 'utf8').catch(() => '')).split('\n');
      lines.forEach((text, index) => { if (word.test(text) && !text.includes('ignored_columns')) errors.push(`${path}: ${name} がまだ ${file}:${index + 1} から参照されています`); });
    }
  }
  return errors;
}

export function renderExceptionReview({ migration, source, request }) {
  const production = request.productionState.state === 'deployed'
    ? `deployed（${request.productionState.deploymentRef}、${request.productionState.deployedAt}、確認: ${request.productionState.confirmedBy}）` : 'not_provisioned（本番環境はまだ無い）';
  return [
    '破壊的Migrationの例外を承認する（承認を取り消すときは最後の行の exception を exception-revoke に変えて投稿する）', '',
    `- migration: ${migration}`,
    `- operations: ${request.operations.map(o => `${o.operation}（${o.line}行目）`).join(', ')}`,
    `- expand: ${request.expand.migration} @ ${request.expand.commit}`,
    `- removes: ${request.removes.map(r => r.column ? `${r.table}.${r.column}` : r.table).join(', ')}`,
    `- rollback: ${request.rollback.procedure}`,
    `- dataBackup: ${request.dataBackup.taken ? `あり（${request.dataBackup.location ?? '場所未記載'}）` : 'なし'}`,
    `- productionState: ${production}`, '',
    `harness-migration-exception: ${exceptionDigest({ migration, source, request })}`, '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const path = process.argv[2];
  const { request, errors } = parseException(path ?? '(none)', await readFile(join(root, path ?? ''), 'utf8').catch(() => ''));
  if (!request) { for (const e of errors) console.error(e); process.exit(1); }
  process.stdout.write(renderExceptionReview({ migration: request.migration, source: await readFile(join(root, request.migration), 'utf8'), request }));
}
