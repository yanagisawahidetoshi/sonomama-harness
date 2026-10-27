import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify as toYaml } from 'yaml';
import { check } from './check.mjs';
import { json, evidenceText } from './io.mjs';
import { runAgent } from './agents/index.mjs';
import { apiSchemaResponseSchema, apiSchemaJsonSchema } from './schemas.mjs';
import { parseIssueUrl } from './planner.mjs';
import { githubCli } from './planner-github.mjs';
import { readExistingSchema, schemaExtract, contractExtract } from './api-schema-reader.mjs';
import { diffContract } from './api-schema-diff.mjs';
import { apiSchemaApprovalStatus } from './api-schema-approval.mjs';
import { reviewLabels, approvedLabel, proposalDirectory, sha256, assertReplaceable, recordGeneration } from './api-schema-files.mjs';
import { judgeApiSchema, reservedComponents, supportedStatuses, limits } from './api-schema-judge.mjs';
import { renderOpenApi, renderSummary } from './api-schema-render.mjs';
import { withEvidenceProtection, redactText, hasSecret } from './evidence-protection.mjs';

export { reviewLabels, approvedLabel };
export const proposalMarker = issueUrl => `<!-- sonomama-api-schema issue=${issueUrl} -->`;
// GitHub rejects comments over 65536 characters; summary.md always keeps the full text.
const commentLimit = 60000;

async function writeText(path, text) {
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}
// The merged document also carries the existing schema verbatim, so every key and string is inspected before it is written or published.
function containsSecret(value) {
  if (typeof value === 'string') return hasSecret(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  if (value && typeof value === 'object') return Object.entries(value).some(([key, entry]) => hasSecret(key) || containsSecret(entry));
  return false;
}

async function makePrompt(root, input) {
  return redactText([
    await readFile(join(root, '.harness/skills/api-schema.md'), 'utf8'),
    'Return JSON only. Do not use tools or edit files directly.',
    JSON.stringify(input, null, 2),
  ].join('\n'));
}

async function proposeProtected({ root, issueUrl, provider, quiet, agent, github }) {
  const ref = parseIssueUrl(issueUrl);
  const { config, securityPolicy } = await check(root);
  provider ??= config.provider;
  if (!['codex', 'claude'].includes(provider)) throw new Error(`API Schema Planner provider must be codex or claude; the ${provider} provider cannot publish a proposal`);
  const id = `api-schema-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = `.harness/runs/${id}`, directory = join(root, runDir);
  const proposalDir = proposalDirectory(ref);
  await mkdir(directory, { recursive: true });
  const summary = { id, runDir, issue: ref, provider, status: 'FETCHING', reason: null, quality: null, proposalDir: null, comment: null, startedAt: new Date().toISOString() };
  const save = () => json(join(directory, 'summary.json'), summary);
  const log = message => { if (!quiet) console.log(redactText(`[${id}] ${message}`)); };
  try {
    await save();
    let fetched;
    try { fetched = await github.fetchIssue(ref); } catch (error) { throw new Error(`GitHub Issue fetch failed for ${ref.url}: ${error.message}`); }
    if (fetched.pull_request) throw new Error(`${ref.url} is a pull request, not an Issue`);
    const issue = { ...ref, title: fetched.title, body: fetched.body ?? '', state: fetched.state ?? null, labels: fetched.labels.map(l => l.name) };
    summary.issue = { ...ref, title: issue.title };
    await json(join(directory, 'issue.json'), issue);
    if (issue.labels.includes(approvedLabel)) throw new Error(`#${issue.number} には${approvedLabel}が付いています。承認済みのAPI Schemaは再生成しません。変更する場合は人間がラベルを外してから実行してください`);
    // The signed ledger, not the label, decides whether a proposal is approved. Regenerating would silently void an approval.
    const approval = await apiSchemaApprovalStatus({ root, issueUrl: ref.url });
    if (approval.approvals > 0) throw new Error(`#${issue.number} のAPI Schemaには有効な承認（${approval.approvals}/${approval.required}）があります。再生成する場合は人間が承認をREVOKEしてから実行してください`);
    await assertReplaceable(root, proposalDir, ref.url);

    summary.status = 'READING_SCHEMA'; await save();
    const existing = await readExistingSchema(root);
    await json(join(directory, 'existing-schema.json'), schemaExtract(existing));
    summary.status = 'PROPOSING'; await save(); log(`PROPOSING: #${issue.number} ${issue.title}`);
    const securityCategories = [...new Set(securityPolicy.rules.flatMap(rule => rule.categories))];
    const prompt = await makePrompt(root, { issue: { url: issue.url, number: issue.number, title: issue.title, body: issue.body, labels: issue.labels }, existing: schemaExtract(existing), existingContract: contractExtract(existing), securityCategories, reservedComponents, supportedStatuses, limits });
    await evidenceText(join(directory, 'prompt.txt'), prompt);
    const response = apiSchemaResponseSchema.parse(await agent({ provider, prompt, directory, workspace: root, timeoutMs: config.timeoutMs, schema: apiSchemaJsonSchema }));
    await json(join(directory, 'candidates.json'), response);
    if (response.escalation) throw new Error(`API Schema Planner escalation: ${response.escalation}`);
    if (!response.proposal) throw new Error('API Schema Planner returned no proposal and no escalation');

    summary.status = 'JUDGING'; await save();
    const quality = summary.quality = judgeApiSchema(response.proposal, { securityCategories, existing });
    await json(join(directory, 'quality.json'), quality);
    if (quality.status !== 'PASS') throw new Error(['API Schema Quality Judge: FAIL。Proposalは承認可能状態にしていません（ファイル・GitHubへの書き込みなし）。', ...quality.findings.map(f => `- ${f.target}: ${f.reason}`)].join('\n'));
    log('API Schema Quality Judge: PASS');
    const document = renderOpenApi(response.proposal, existing);
    if (containsSecret(document)) throw new Error('Secret/Credential detected in the rendered OpenAPI document; rejected before any file or GitHub write');
    const contractDiff = existing ? diffContract(existing.document, document) : { breaking: [], nonBreaking: [] };
    await json(join(directory, 'contract-diff.json'), contractDiff);
    const yamlText = toYaml(document, { lineWidth: 0 });
    const summaryText = renderSummary({ issue, proposal: response.proposal, quality, contractDiff, existing, directory: proposalDir, approvedLabel, reviewLabel: reviewLabels[1] });
    const comment = [proposalMarker(ref.url), summaryText.length > commentLimit ? `${summaryText.slice(0, commentLimit)}\n\n（長いため省略。全文は ${proposalDir}/summary.md）` : summaryText].join('\n');
    if (hasSecret(comment)) throw new Error('Secret/Credential detected in the proposal summary; rejected before any file or GitHub write');

    summary.status = 'PUBLISHING'; await save();
    await mkdir(join(root, proposalDir), { recursive: true });
    await writeText(join(root, proposalDir, 'openapi.yaml'), yamlText);
    await writeText(join(root, proposalDir, 'summary.md'), summaryText);
    // files in proposal.json is for reviewers only. Integrity is checked against the signed generation record.
    await json(join(root, proposalDir, 'proposal.json'), {
      version: 1, status: 'NEEDS_REVIEW', issue: { url: ref.url, number: ref.number, title: issue.title },
      generatedBy: { runId: id, provider }, generatedAt: new Date().toISOString(), existingSchema: existing?.path ?? null,
      quality, contractDiff, proposal: response.proposal, files: { 'openapi.yaml': sha256(yamlText), 'summary.md': sha256(summaryText) },
    });
    await recordGeneration(root, ref, { runId: id, required: response.proposal.securityImpact.length ? 2 : 1 });
    summary.proposalDir = proposalDir;
    await save(); log(`Proposal: ${proposalDir}/openapi.yaml`);
    await github.ensureLabels(ref, reviewLabels);
    await github.addLabels(ref, reviewLabels);
    const previous = (await github.listComments(ref)).find(c => (c.body || '').includes(proposalMarker(ref.url)));
    summary.comment = (previous ? await github.updateComment(ref, previous.id, comment) : await github.addComment(ref, comment)).html_url;
    summary.status = 'REVIEW_READY'; summary.finishedAt = new Date().toISOString();
    await save();
    if (!quiet) console.log(`\nAPI Schema Proposal: ${proposalDir}/openapi.yaml\nReview: ${proposalDir}/summary.md\nIssue comment: ${summary.comment}`);
    return summary;
  } catch (error) {
    summary.status = 'FAILED'; summary.reason = redactText(error.message);
    await save();
    throw error;
  }
}
export async function planApiSchema(options) {
  const root = await realpath(options.root);
  return withEvidenceProtection(root, () => proposeProtected({ quiet: false, ...options, root, agent: options.agent ?? runAgent, github: options.github ?? githubCli }));
}
