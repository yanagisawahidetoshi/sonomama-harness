import { mkdir, appendFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from './check.mjs';
import { json, evidenceText } from './io.mjs';
import { runAgent } from './agents/index.mjs';
import { planResponseSchema, planJsonSchema } from './schemas.mjs';
import { judgePlan, creationOrder, limits } from './planner-judge.mjs';
import { githubCli } from './planner-github.mjs';
import { withEvidenceProtection, redactText } from './evidence-protection.mjs';

// Every generated SBI carries both labels. A human removes needs-review and adds ready; the Planner never does.
export const sbiLabels = Object.freeze(['sbi', 'needs-review']);

export function parseIssueUrl(url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\/?$/.exec(String(url).trim());
  if (!match) throw new Error('Invalid GitHub Issue URL; expected https://github.com/<owner>/<repo>/issues/<number>');
  return { owner: match[1], repo: match[2], number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}` };
}

const steps = (keyword, lines) => lines.map((line, index) => `  ${index ? 'And' : keyword} ${line}`);
export function renderGherkin(scenarios) {
  return scenarios.map(s => [`Scenario: ${s.name}`, ...steps('Given', s.given), ...steps('When', s.when), ...steps('Then', s.then)].join('\n')).join('\n\n');
}
export function renderSbiBody(sbi, pbi, issueNumbers = {}) {
  const security = sbi.securityImpact.filter(category => category !== 'None');
  return [
    '## 目的', '', sbi.purpose, '',
    '## 対象範囲', '', ...sbi.scope.included.map(item => `- ${item}`),
    ...(sbi.scope.excluded.length ? ['', '対象外:', ...sbi.scope.excluded.map(item => `- ${item}`)] : []), '',
    '## 受け入れ要件', '', ...sbi.acceptanceCriteria.map(a => `- [ ] ${a.id}: ${a.description}`), '',
    '## Gherkin', '', '```gherkin', renderGherkin(sbi.scenarios), '```', '',
    '## 依存SBI', '', ...(sbi.dependsOn.length ? sbi.dependsOn.map(id => `- ${id}${issueNumbers[id] ? ` (#${issueNumbers[id]})` : ''}`) : ['なし']), '',
    '## 想定変更範囲', '', '```text', ...sbi.changeAreas, '```', '',
    '## Risk / Security Impact', '', '```text', `Risk: ${sbi.riskCandidate} candidate`, `Security: ${security.length ? security.join(', ') : 'None'}`, '```', '',
    '## 検証方法', '', '```text', `Application Test: ${sbi.verification.applicationTest}`, `受け入れ要件: ${sbi.verification.acceptance}`, `E2E: ${sbi.verification.e2e}`, '```', '',
    '## 元PBI', '', `#${pbi.number} ${pbi.title}`, '',
    '_SONOMAMA Harness Plannerが生成。最終Risk判定はExecution Harnessが行う。`needs-review`の間はExecution Harnessの対象外。_', '',
  ].join('\n');
}
export function renderGeneratedComment(created) {
  return ['## Generated SBI', '', ...created.map(c => `- #${c.number} ${c.title}`), ''].join('\n');
}
export function renderCreatedList(created) {
  return ['Created SBI Issues', '', ...created.flatMap(c => [`✓ #${c.number} ${c.title}`, `  ${c.url}`, ''])].join('\n');
}
export function renderJobSummary(created, pbi) {
  return ['## Created SBI Issues', '', `PBI: [#${pbi.number} ${pbi.title}](${pbi.url})`, '', ...created.map(c => `- [#${c.number} ${c.title}](${c.url})`), ''].join('\n');
}

async function makePlanPrompt(root, pbi, securityCategories) {
  return redactText([
    await readFile(join(root, '.harness/skills/plan.md'), 'utf8'),
    'Return JSON only. Do not use tools or edit files directly.',
    JSON.stringify({ pbi, securityCategories, limits }, null, 2),
  ].join('\n'));
}

async function planProtected({ root, issueUrl, provider, quiet, agent, github, stepSummaryPath }) {
  const ref = parseIssueUrl(issueUrl);
  const { config, securityPolicy } = await check(root);
  provider ??= config.provider;
  if (!['codex', 'claude'].includes(provider)) throw new Error(`Planner provider must be codex or claude; the ${provider} provider cannot publish SBI Issues`);
  const id = `plan-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = join(root, '.harness/runs', id);
  await mkdir(directory, { recursive: true });
  const summary = { id, planDir: `.harness/runs/${id}`, pbi: ref, provider, status: 'FETCHING', reason: null, quality: null, created: [], comment: null, startedAt: new Date().toISOString() };
  const save = () => json(join(directory, 'summary.json'), summary);
  const log = message => { if (!quiet) console.log(redactText(`[${id}] ${message}`)); };
  try {
    await save();
    let issue;
    try { issue = await github.fetchIssue(ref); } catch (error) { throw new Error(`GitHub Issue fetch failed for ${ref.url}: ${error.message}`); }
    if (issue.pull_request) throw new Error(`${ref.url} is a pull request, not a PBI Issue`);
    const pbi = { ...ref, title: issue.title, body: issue.body ?? '', state: issue.state ?? null, labels: issue.labels.map(l => l.name) };
    summary.pbi = { ...ref, title: pbi.title };
    await json(join(directory, 'pbi.json'), pbi);
    summary.status = 'DECOMPOSING'; await save(); log(`DECOMPOSING: #${pbi.number} ${pbi.title}`);
    const securityCategories = [...new Set(securityPolicy.rules.flatMap(rule => rule.categories))];
    const prompt = await makePlanPrompt(root, pbi, securityCategories);
    await evidenceText(join(directory, 'prompt.txt'), prompt);
    const response = planResponseSchema.parse(await agent({ provider, prompt, directory, workspace: root, timeoutMs: config.timeoutMs, schema: planJsonSchema }));
    await json(join(directory, 'candidates.json'), response);
    if (response.escalation) throw new Error(`Planner escalation: ${response.escalation}`);
    summary.status = 'JUDGING'; await save();
    summary.quality = judgePlan(response.sbis);
    await json(join(directory, 'quality.json'), summary.quality);
    if (summary.quality.status !== 'PASS') throw new Error(['SBI Quality Judge: FAIL。SBI Issueは作成していません。', ...summary.quality.findings.map(f => `- ${f.sbi}: ${f.reason}`)].join('\n'));
    log(`SBI Quality Judge: PASS (${response.sbis.length} SBI)`);
    summary.status = 'PUBLISHING'; await save();
    await github.ensureLabels(ref, sbiLabels);
    const issueNumbers = {};
    for (const sbiId of creationOrder(response.sbis)) {
      const sbi = response.sbis.find(s => s.id === sbiId);
      const title = `${sbi.id} ${sbi.title}`;
      const created = await github.createIssue(ref, { title, body: renderSbiBody(sbi, pbi, issueNumbers), labels: [...sbiLabels] });
      issueNumbers[sbi.id] = created.number;
      summary.created.push({ sbiId: sbi.id, number: created.number, title, url: created.html_url });
      await json(join(directory, 'issues.json'), { created: summary.created, comment: null });
      await save(); log(`Created #${created.number} ${title}`);
    }
    summary.comment = (await github.addComment(ref, renderGeneratedComment(summary.created))).html_url;
    summary.status = 'DONE'; summary.finishedAt = new Date().toISOString();
    await json(join(directory, 'issues.json'), { created: summary.created, comment: summary.comment });
    await save();
    if (stepSummaryPath) await appendFile(stepSummaryPath, renderJobSummary(summary.created, pbi));
    if (!quiet) console.log(`\n${renderCreatedList(summary.created)}`);
    return summary;
  } catch (error) {
    summary.status = 'FAILED'; summary.reason = redactText(error.message);
    await save();
    if (summary.created.length) error.message += `\n\n作成済みのSBI Issue（元PBIへのコメントは未投稿）:\n${renderCreatedList(summary.created)}`;
    throw error;
  }
}
export async function planIssue(options) {
  const root = await realpath(options.root);
  return withEvidenceProtection(root, () => planProtected({ quiet: false, stepSummaryPath: process.env.GITHUB_STEP_SUMMARY, ...options, root, agent: options.agent ?? runAgent, github: options.github ?? githubCli }));
}
