import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acceptancePath } from './acceptance-registry.mjs';
import { acceptanceDirectory, inspectGeneratedAcceptance } from './acceptance-quality.mjs';
import { sections } from './sbi-issue.mjs';
import { specDigest } from './spec-approval.mjs';
import { generatedRegistrationSchema } from './schemas.mjs';
// #147: the generation agent only answers with JSON (files and their AC / Scenario mapping). The Harness checks the answer and only then
// writes the tests and a version 2 registration into the run workspace, so they reach the implementation PR together.
const sha256 = text => createHash('sha256').update(text).digest('hex');
const fenced = lines => { const start = lines.findIndex(l => l.startsWith('```')), end = lines.findIndex((l, i) => i > start && /^```\s*$/.test(l)); return start < 0 || end < 0 ? [] : lines.slice(start + 1, end); };

export function approvedSpec(issue) {
  const parts = sections(issue.body);
  const acceptanceCriteria = (parts.get('受け入れ要件') ?? []).flatMap(line => { const m = /^- \[[ xX]\] (\S+?): (.+)$/.exec(line.trim()); return m ? [{ id: m[1], description: m[2].trim() }] : []; });
  const gherkin = fenced(parts.get('Gherkin') ?? []);
  const scenarios = gherkin.flatMap(line => { const m = /^\s*Scenario(?: Outline)?: (.+?)\s*$/.exec(line); return m ? [m[1]] : []; });
  return { sbiIssue: issue.number, title: issue.title, digest: specDigest(issue.body), acceptanceCriteria, scenarios, gherkin: gherkin.join('\n') };
}

export const generationResponseSchema = {
  type: 'object', additionalProperties: false, required: ['files', 'mapping', 'escalation'],
  properties: {
    files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    mapping: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['scenario', 'acceptanceIds', 'examples'], properties: {
      scenario: { type: 'string' }, acceptanceIds: { type: 'array', items: { type: 'string' } },
      examples: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'description'], properties: { path: { type: 'string' }, description: { type: 'string' } } } } } } },
    escalation: { type: ['string', 'null'] },
  },
};

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

export async function generateAcceptance({ workspace, issue, provider, runId, agent }) {
  const spec = approvedSpec(issue);
  const reply = await agent({ prompt: prompt(spec), schema: generationResponseSchema });
  if (reply.escalation) return { status: 'ESCALATED', reason: reply.escalation };
  const quality = inspectGeneratedAcceptance({ spec, generated: reply });
  if (quality.status !== 'PASS') return { status: 'REJECTED', findings: quality.findings };
  for (const file of reply.files) {
    await mkdir(join(workspace, dirname(file.path)), { recursive: true });
    await writeFile(join(workspace, file.path), file.content);
  }
  const registration = generatedRegistrationSchema.parse({
    version: 2, sbiIssue: spec.sbiIssue, specDigest: spec.digest, generator: { provider, runId }, adapter: 'rails-request-spec',
    tests: reply.files.map(f => ({ path: f.path, sha256: sha256(f.content) })), mapping: reply.mapping,
  });
  await mkdir(join(workspace, dirname(acceptancePath(spec.sbiIssue))), { recursive: true });
  await writeFile(join(workspace, acceptancePath(spec.sbiIssue)), `${JSON.stringify(registration, null, 2)}\n`);
  return { status: 'REGISTERED', registration };
}

async function listFiles(root, directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) files.push(...entry.isDirectory() ? await listFiles(root, `${directory}${entry.name}/`) : [`${directory}${entry.name}`]);
  return files;
}
// The registration is reused only while the Issue spec and every registered test are exactly what was generated and checked.
export async function verifyGeneratedRegistration({ root, registration, issue }) {
  const reasons = [];
  if (specDigest(issue.body) !== registration.specDigest) reasons.push(`spec digest of the SBI Issue changed since the Trusted Acceptance was generated (${registration.specDigest.slice(0, 12)})`);
  for (const test of registration.tests) {
    const text = await readFile(join(root, test.path), 'utf8').catch(() => null);
    if (text === null) reasons.push(`${test.path} was removed after registration`);
    else if (sha256(text) !== test.sha256) reasons.push(`${test.path} was changed after registration`);
  }
  for (const path of await listFiles(root, acceptanceDirectory(registration.sbiIssue))) {
    if (!registration.tests.some(t => t.path === path)) reasons.push(`${path} was added to the acceptance directory after registration`);
  }
  return reasons;
}
