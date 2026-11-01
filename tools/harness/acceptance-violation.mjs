// #147: controlled violation. Detection (G) is proven per Scenario: one that fails on its expectation before the implementation is its own
// natural violation; one that already passes must fail once a minimal change to the application breaks it. The generation agent only proposes
// the change as JSON; the Harness accepts it mechanically, applies it to a disposable copy (never the run workspace) and keeps only its digest.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { isGeneratedAcceptanceInput } from './acceptance-generation.mjs';
import { expectationNotMet } from './acceptance-run.mjs';
import { hasSecret } from './evidence-protection.mjs';
import { execute } from './io.mjs';
import { relativePath } from './schemas.mjs';
import { git } from './workspace.mjs';

export const violationLimits = Object.freeze({ files: 2, changedLines: 20 });
const applicationCode = /^apps\/api\/app\//;
const sha256 = text => createHash('sha256').update(text).digest('hex');

const answerSchema = z.strictObject({
  violations: z.array(z.strictObject({ scenario: z.string(), files: z.array(z.strictObject({ path: z.string(), content: z.string() })) })),
  escalation: z.string().nullable(),
});
// The claude CLI cannot resolve the draft 2020-12 meta-schema Zod names in $schema, so the schema goes without it.
const { $schema: violationDraft, ...violationResponse } = z.toJSONSchema(answerSchema);
export const violationResponseSchema = violationResponse;
export const parseViolationAnswer = answer => answerSchema.safeParse(answer);

export function violationPrompt({ sbiIssue, scenarios }) {
  return [
    'あなたはTrusted Acceptanceの検出能力を確かめるための controlled violation の提案担当です。ファイルは書かず、JSONだけを返してください。',
    `対象: SBI Issue #${sbiIssue}。次のScenarioは実装前からPASSしています。Scenarioごとに、そのScenarioの期待結果（Then）だけが外れるようになる最小の変更を1つ提案してください。`,
    ...scenarios.map(s => `- ${s.scenario}（${s.acceptanceIds.join(', ')}）: ${s.examples.join(' / ')}`),
    `規則: 変更できるのは既存の apps/api/app/** のファイルだけ（新規作成・削除は不可）。spec・fixture・config・migration・DB schemaは変更しない。1つのScenarioにつき${violationLimits.files}ファイル・${violationLimits.changedLines}行まで。構文エラーや読み込みエラーで落とすのではなく、期待結果そのものが外れる変更にする。`,
    '各ファイルは変更後の内容全体を content に入れる。安全に作れない場合は violations を空にし、escalation に理由を書く。',
  ].join('\n');
}

async function throughSymlink(root, path) {
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (info?.isSymbolicLink()) return true;
    if (!info) return false;
  }
  return false;
}
// Added plus deleted lines, as git counts them.
async function changedLines(before, after) {
  const temp = await mkdtemp(join(tmpdir(), 'harness-violation-diff-'));
  try {
    await writeFile(join(temp, 'before'), before);
    await writeFile(join(temp, 'after'), after);
    const result = await execute('git', ['diff', '--no-index', '--numstat', '--', 'before', 'after'], { cwd: temp });
    return result.stdout.trim().split('\n').filter(Boolean).reduce((sum, line) => sum + line.split('\t').slice(0, 2).reduce((n, v) => n + (Number(v) || 0), 0), 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function inspectViolation({ workspace, proposal }) {
  const findings = [], add = (path, message) => findings.push({ path, message });
  let lines = 0;
  if (!proposal.files.length) add('(proposal)', 'changes nothing');
  if (proposal.files.length > violationLimits.files) add('(proposal)', `changes ${proposal.files.length} files; at most ${violationLimits.files} files`);
  if (new Set(proposal.files.map(f => f.path)).size !== proposal.files.length) add('(proposal)', 'the same path is named more than once');
  for (const file of proposal.files) {
    if (!relativePath.safeParse(file.path).success || !applicationCode.test(file.path) || isGeneratedAcceptanceInput(file.path)) { add(file.path, 'is not application code under apps/api/app/'); continue; }
    if (await throughSymlink(workspace, file.path)) { add(file.path, 'would be written through a symlink'); continue; }
    const before = await readFile(join(workspace, file.path), 'utf8').catch(() => null);
    if (before === null) { add(file.path, 'does not exist; a violation changes existing behavior only'); continue; }
    if (hasSecret(file.content)) add(file.path, 'carries a credential-shaped value');
    if (before === file.content) add(file.path, 'changes nothing');
    else lines += await changedLines(before, file.content);
  }
  if (lines > violationLimits.changedLines) add('(proposal)', `changes ${lines} lines; at most ${violationLimits.changedLines} lines`);
  const files = [...proposal.files].sort((a, b) => a.path.localeCompare(b.path));
  return { findings, changedLines: lines, files: files.map(f => f.path), patchDigest: sha256(JSON.stringify(files)) };
}

// The disposable copy: the committed workspace, the generated tests not yet committed, and the violation. Removed after the run.
export async function withViolationCopy({ workspace, directory, carried, proposal }, run) {
  await mkdir(directory, { recursive: true });
  const copy = await mkdtemp(join(directory, 'violation-'));
  try {
    const archive = join(copy, '..', `${copy.split('/').at(-1)}.tar`);
    await git(workspace, ['archive', '--format=tar', '-o', archive, 'HEAD']);
    const extracted = await execute('tar', ['-xf', archive, '-C', copy]);
    await rm(archive, { force: true });
    if (!extracted.ok) throw new Error(`the disposable copy could not be made: ${extracted.stderr || extracted.error}`);
    for (const file of [...carried, ...proposal.files]) {
      await mkdir(join(copy, dirname(file.path)), { recursive: true });
      await writeFile(join(copy, file.path), file.content);
    }
    return await run(copy);
  } finally { await rm(copy, { recursive: true, force: true }); }
}

// Only the target Scenario's examples count. A failure that is not an expectation (load, syntax, DB, timeout) never counts as detection.
export function judgeViolation({ registration, scenario, report }) {
  if (report.error) return { outcome: 'environment', reason: report.error };
  if (report.errorsOutsideOfExamples) return { outcome: 'undeterminable', reason: `${report.errorsOutsideOfExamples} errors occurred outside of examples (the specs could not be loaded)` };
  const examples = registration.mapping.find(m => m.scenario === scenario)?.examples ?? [];
  const failures = [], problems = [];
  for (const { description } of examples) {
    const result = report.examples.find(e => e.description === description);
    if (!result) problems.push(`"${description}" did not run`);
    else if (result.status === 'failed' && expectationNotMet.has(result.exceptionClass)) failures.push({ description, message: result.message ?? null });
    else if (result.status !== 'passed') problems.push(`"${description}" ${result.status}${result.exceptionClass ? ` with ${result.exceptionClass}` : ''}, which is not a failed expectation`);
  }
  if (!examples.length) problems.push(`no example is mapped to "${scenario}"`);
  if (problems.length) return { outcome: 'undeterminable', reason: problems.join('; ') };
  if (!failures.length) return { outcome: 'missed', reason: `"${scenario}" still passed with the proposed violation applied` };
  return { outcome: 'detected', failures };
}
