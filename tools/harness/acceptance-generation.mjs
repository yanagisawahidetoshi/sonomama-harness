import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { acceptancePath, generatedVerifierId } from './acceptance-registry.mjs';
export { generatedVerifierId };
import { acceptanceDirectory, inspectGeneratedAcceptance } from './acceptance-quality.mjs';
import { hasSecret } from './evidence-protection.mjs';
import { fenced, sections } from './sbi-issue.mjs';
import { specDigest } from './spec-approval.mjs';
import { generatedRegistrationSchema, relativePath } from './schemas.mjs';
// #147: the generation agent only answers with JSON (files and their AC / Scenario mapping). The Harness checks the answer and only then
// writes the tests and a version 2 registration into the run workspace, so they reach the implementation PR together.
// Everything is checked before the first write, so a rejected answer leaves nothing behind.
const sha256 = text => createHash('sha256').update(text).digest('hex');
const maxFileBytes = 65536;
// What the generated request specs run with; the implementation must not change these after the tests were checked.
const supportPaths = ['apps/api/.rspec', 'apps/api/spec/spec_helper.rb', 'apps/api/spec/rails_helper.rb'];
const supportDirectory = 'apps/api/spec/support/';

export function approvedSpec(issue) {
  const parts = sections(issue.body);
  const acceptanceCriteria = (parts.get('受け入れ要件') ?? []).flatMap(line => { const m = /^- \[[ xX]\] (\S+?): (.+)$/.exec(line.trim()); return m ? [{ id: m[1], description: m[2].trim() }] : []; });
  const gherkin = fenced(parts.get('Gherkin') ?? []) ?? [];
  const scenarios = gherkin.flatMap(line => { const m = /^\s*Scenario(?: Outline)?: (.+?)\s*$/.exec(line); return m ? [m[1]] : []; });
  return { sbiIssue: issue.number, title: issue.title, digest: specDigest(issue.body), acceptanceCriteria, scenarios, gherkin: gherkin.join('\n') };
}

const answerSchema = z.strictObject({
  files: z.array(z.strictObject({ path: z.string(), content: z.string() })),
  mapping: z.array(z.strictObject({ scenario: z.string(), acceptanceIds: z.array(z.string()), examples: z.array(z.strictObject({ path: z.string(), description: z.string() })) })),
  escalation: z.string().nullable(),
});
export const generationResponseSchema = z.toJSONSchema(answerSchema);

function prompt(spec) {
  return [
    'あなたはTrusted Acceptance（受け入れ判定用のテスト）の生成担当です。実装はしません。ファイルは書かず、JSONだけを返してください。',
    `対象: SBI Issue #${spec.sbiIssue} ${spec.title}（Rails の request spec）`,
    `テストは ${acceptanceDirectory(spec.sbiIssue)} の *_spec.rb にだけ置きます。それ以外のパスは書けません。`,
    '受け入れ要件:', ...spec.acceptanceCriteria.map(a => `- ${a.id}: ${a.description}`),
    'Gherkin:', spec.gherkin,
    '規則: 全てのACと全てのScenarioを、実在するexampleに対応させる。各exampleはThenの期待結果をexpectで確かめる。skip・pending・focus・定数どうしのexpect・検証対象（Policy・Controller等）のstubは使わない。',
    '仕様が曖昧で判定できない場合は、files と mapping を空にし、escalation に理由を書く。',
  ].join('\n');
}

async function filesUnder(root, directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) files.push(...entry.isDirectory() ? await filesUnder(root, `${directory}${entry.name}/`) : [`${directory}${entry.name}`]);
  return files;
}
async function snapshot(root, paths) {
  const result = [];
  for (const path of paths) { const text = await readFile(join(root, path), 'utf8').catch(() => null); if (text !== null) result.push({ path, sha256: sha256(text) }); }
  return result;
}
const supportFiles = async root => snapshot(root, [...supportPaths, ...(await filesUnder(root, supportDirectory)).sort()]);
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

export async function generateAcceptance({ workspace, issue, provider, runId, agent }) {
  const spec = approvedSpec(issue);
  const reject = findings => ({ status: 'REJECTED', findings });
  if (!spec.digest || !spec.acceptanceCriteria.length || !spec.scenarios.length) return reject([{ path: '(spec)', message: 'the approved spec has no spec digest, acceptance criteria or Scenario the Harness can read; fix the SBI Issue format before generating' }]);
  const existing = await readFile(join(workspace, acceptancePath(spec.sbiIssue)), 'utf8').catch(() => null);
  if (existing !== null && JSON.parse(existing)?.version !== 2) return reject([{ path: acceptancePath(spec.sbiIssue), message: 'a hand-written version 1 registration exists; generation does not overwrite it' }]);
  const parsed = answerSchema.safeParse(await agent({ prompt: prompt(spec), schema: generationResponseSchema }));
  if (!parsed.success) return reject([{ path: '(answer)', message: `the generation agent answer does not match the schema: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join(', ')}` }]);
  const reply = parsed.data;
  if (reply.escalation) return { status: 'ESCALATED', reason: reply.escalation };
  const quality = inspectGeneratedAcceptance({ spec, generated: reply });
  const findings = [...quality.findings];
  if (new Set(reply.files.map(f => f.path)).size !== reply.files.length) findings.push({ path: '(answer)', message: 'the same path is returned more than once' });
  for (const file of reply.files) {
    if (!relativePath.safeParse(file.path).success) findings.push({ path: file.path, message: 'not a safe relative path' });
    if (hasSecret(file.content)) findings.push({ path: file.path, message: 'carries a credential-shaped value' });
    if (Buffer.byteLength(file.content) > maxFileBytes) findings.push({ path: file.path, message: `larger than ${maxFileBytes} bytes` });
    if (await throughSymlink(workspace, file.path)) findings.push({ path: file.path, message: 'would be written through a symlink' });
  }
  if (findings.length) return reject(findings);
  const registration = generatedRegistrationSchema.parse({
    version: 2, sbiIssue: spec.sbiIssue, specDigest: spec.digest, generator: { provider, runId }, adapter: 'rails-request-spec',
    tests: reply.files.map(f => ({ path: f.path, sha256: sha256(f.content) })), protectedFiles: await supportFiles(workspace), mapping: reply.mapping,
  });
  // A regeneration replaces the whole directory, so a test from an earlier answer cannot stay behind.
  await rm(join(workspace, acceptanceDirectory(spec.sbiIssue)), { recursive: true, force: true });
  for (const file of reply.files) {
    await mkdir(join(workspace, dirname(file.path)), { recursive: true });
    await writeFile(join(workspace, file.path), file.content);
  }
  await mkdir(join(workspace, dirname(acceptancePath(spec.sbiIssue))), { recursive: true });
  await writeFile(join(workspace, acceptancePath(spec.sbiIssue)), `${JSON.stringify(registration, null, 2)}\n`);
  return { status: 'REGISTERED', registration };
}

// The registration is reused only while it belongs to this SBI, the Issue spec, every registered test and every support file
// are exactly what was generated and checked.
export async function verifyGeneratedRegistration({ root, registration: raw, issue, specDigest: expectedDigest, sbiIssue }) {
  const parsed = generatedRegistrationSchema.safeParse(raw);
  if (!parsed.success) return [`the registration is not a valid version 2 registration (${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join(', ')})`];
  const registration = parsed.data, reasons = [];
  // CI passes the current Issue; a run passes the spec digest it approved at start.
  const number = issue?.number ?? sbiIssue, digest = issue ? specDigest(issue.body) : expectedDigest;
  if (registration.sbiIssue !== number) reasons.push(`the registration is for SBI Issue #${registration.sbiIssue}, not #${number}`);
  if (digest !== registration.specDigest) reasons.push(`spec digest of the SBI Issue changed since the Trusted Acceptance was generated (${registration.specDigest.slice(0, 12)})`);
  const compare = async (entries, label) => {
    for (const entry of entries) {
      const text = await readFile(join(root, entry.path), 'utf8').catch(() => null);
      if (text === null) reasons.push(`${entry.path} was removed after registration (${label})`);
      else if (sha256(text) !== entry.sha256) reasons.push(`${entry.path} was changed after registration (${label})`);
    }
  };
  await compare(registration.tests, 'generated test');
  await compare(registration.protectedFiles, 'spec support');
  for (const path of await filesUnder(root, acceptanceDirectory(registration.sbiIssue))) {
    if (!registration.tests.some(t => t.path === path)) reasons.push(`${path} was added to the acceptance directory after registration`);
  }
  for (const entry of await supportFiles(root)) {
    if (!registration.protectedFiles.some(p => p.path === entry.path)) reasons.push(`${entry.path} was added after registration (spec support)`);
  }
  return reasons;
}

// What the implementation agent must not write once Trusted Acceptance is generated: the tests, the registration and their spec support.
export function isGeneratedAcceptanceInput(path) {
  return /^apps\/[^/]+\/spec\/acceptance\//i.test(path) || /^\.harness\/acceptance\//.test(path)
    || supportPaths.includes(path) || path.startsWith(supportDirectory);
}
// The files the Harness itself commits for the generated Trusted Acceptance of one SBI (outside the SBI's own change scope).
export function isGeneratedRegistrationPath(path, sbi) {
  const number = Number(/\/issues\/(\d+)$/.exec(sbi.issueUrl ?? '')?.[1]);
  return Number.isInteger(number) && number > 0 && (path === acceptancePath(number) || path.startsWith(acceptanceDirectory(number)));
}
