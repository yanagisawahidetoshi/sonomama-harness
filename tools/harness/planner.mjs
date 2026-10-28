import { mkdir, appendFile, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { check } from './check.mjs';
import { json, evidenceText } from './io.mjs';
import { runAgent } from './agents/index.mjs';
import { planResponseSchema, planJsonSchema } from './schemas.mjs';
import { judgePlan, creationOrder, limits } from './planner-judge.mjs';
import { githubCli } from './planner-github.mjs';
import { withEvidenceProtection, redactText, hasSecret } from './evidence-protection.mjs';

// Every generated SBI carries both labels. A human removes needs-review and adds ready; the Planner never does.
export const sbiLabels = Object.freeze(['sbi', 'needs-review']);

// Deterministic markers make re-runs idempotent: an SBI Issue is keyed by PBI URL + SBI ID + content digest, the PBI comment by PBI URL.
// A matching digest means the Issue a human reviews is exactly what this run generated and judged; anything else is a human decision.
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const sbiDigest = sbi => createHash('sha256').update(JSON.stringify(stable(sbi))).digest('hex');
export const sbiMarker = (pbiUrl, id, digest) => `<!-- sonomama-sbi pbi=${pbiUrl} id=${id} digest=${digest} -->`;
const markerPattern = /<!-- sonomama-sbi pbi=(\S+) id=(SBI-\d{3})(?: digest=([0-9a-f]{64}))? -->/;
export const listMarker = pbiUrl => `<!-- sonomama-sbi-list pbi=${pbiUrl} -->`;
export function parseIssueUrl(url) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\/?$/.exec(String(url).trim());
  if (!match) throw new Error('Invalid GitHub Issue URL; expected https://github.com/<owner>/<repo>/issues/<number>');
  return { owner: match[1], repo: match[2], number: Number(match[3]), url: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}` };
}

const steps = (keyword, lines) => lines.map((line, index) => `  ${index ? 'And' : keyword} ${line}`);
export function renderGherkin(scenarios) {
  return scenarios.map(s => [`Scenario: ${s.name}`, ...steps('Given', s.given), ...steps('When', s.when), ...steps('Then', s.then)].join('\n')).join('\n\n');
}
export const kindLabels = Object.freeze({ implementation: '実装SBI', validation: '最終確認SBI', acceptance: '人間確認SBI' });
export function renderSbiBody(sbi, pbi, issueNumbers = {}) {
  const security = sbi.securityImpact.filter(category => category !== 'None');
  return [
    sbiMarker(pbi.url, sbi.id, sbiDigest(sbi)),
    '## 種類', '', `${kindLabels[sbi.kind]}（${sbi.kind}）`, '',
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
export function renderGeneratedComment(created, pbi) {
  return [listMarker(pbi.url), '## Generated SBI', '', ...created.map(c => `- #${c.number} ${c.title}`), ''].join('\n');
}
export function renderCreatedList(created) {
  return ['Created SBI Issues', '', ...created.flatMap(c => [`✓ #${c.number} ${c.title}${c.reused ? '（既存を再利用）' : ''}`, `  ${c.url}`, ''])].join('\n');
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
    summary.quality = judgePlan(response.sbis, { securityCategories });
    await json(join(directory, 'quality.json'), summary.quality);
    if (summary.quality.status !== 'PASS') throw new Error(['SBI Quality Judge: FAIL。SBI Issueは作成していません。', ...summary.quality.findings.map(f => `- ${f.sbi}: ${f.reason}`)].join('\n'));
    log(`SBI Quality Judge: PASS (${response.sbis.length} SBI)`);
    // Provider output is published outside the Harness. Reject credential-like values before any GitHub write, as the execution loop does before applying files.
    if (hasSecret(JSON.stringify(response.sbis))) throw new Error('Secret/Credential detected in planner candidates; rejected before any GitHub write');
    summary.status = 'PUBLISHING'; await save();
    await github.ensureLabels(ref, sbiLabels);
    // The marker only finds candidates. Reuse requires the Issue, as it exists now, to be exactly what this run generated and still awaiting review.
    const existing = new Map((await github.listIssues(ref, sbiLabels[0])).flatMap(issue => { const match = markerPattern.exec(issue.body || ''); return match && match[1] === ref.url ? [[match[2], { issue, digest: match[3] || null }]] : []; }));
    const normalize = text => String(text ?? '').replaceAll('\r\n', '\n').trimEnd();
    const issueNumbers = {}, publications = [], problems = [];
    for (const sbiId of creationOrder(response.sbis)) {
      const sbi = response.sbis.find(s => s.id === sbiId);
      const title = `${sbi.id} ${sbi.title}`;
      const found = existing.get(sbi.id);
      if (!found) { publications.push({ sbi, title, reuse: null }); continue; }
      const reasons = [];
      if (found.digest !== sbiDigest(sbi)) reasons.push('生成内容のdigestが異なる');
      if (found.issue.state !== 'open') reasons.push(`stateが${found.issue.state ?? 'unknown'}でopenではない`);
      if (!found.issue.labels.some(label => label.name === 'needs-review')) reasons.push('needs-reviewラベルがない（レビュー済みの可能性）');
      if (found.issue.title !== title) reasons.push('titleが生成内容と異なる');
      if (normalize(found.issue.body) !== normalize(renderSbiBody(sbi, pbi, issueNumbers))) reasons.push('本文が生成内容と異なる（人間の編集または依存Issueの変更）');
      if (reasons.length) problems.push(`- ${sbi.id}: #${found.issue.number} ${found.issue.html_url}（${reasons.join('、')}）`);
      issueNumbers[sbi.id] = found.issue.number;
      publications.push({ sbi, title, reuse: found.issue });
    }
    if (problems.length) throw new Error(['既存のSBI Issueを再利用できません。GitHubへは書き込んでいません。人間が確認し、古いIssueを閉じて`sbi`ラベルを外すか、内容を確定してから再実行してください。', ...problems].join('\n'));
    for (const { sbi, title, reuse } of publications) {
      const body = renderSbiBody(sbi, pbi, issueNumbers);
      if (hasSecret(title) || hasSecret(body)) throw new Error('Secret/Credential detected in rendered SBI Issue; rejected before any GitHub write');
      const issue = reuse || await github.createIssue(ref, { title, body, labels: [...sbiLabels] });
      issueNumbers[sbi.id] = issue.number;
      summary.created.push({ sbiId: sbi.id, number: issue.number, title, url: issue.html_url, reused: Boolean(reuse) });
      await json(join(directory, 'issues.json'), { created: summary.created, comment: null });
      await save(); log(`${reuse ? 'Reused' : 'Created'} #${issue.number} ${title}`);
    }
    const comment = renderGeneratedComment(summary.created, pbi);
    if (hasSecret(comment)) throw new Error('Secret/Credential detected in PBI comment; rejected before any GitHub write');
    const previous = (await github.listComments(ref)).find(c => (c.body || '').includes(listMarker(ref.url)));
    summary.comment = (previous ? await github.updateComment(ref, previous.id, comment) : await github.addComment(ref, comment)).html_url;
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
