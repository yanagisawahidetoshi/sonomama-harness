import { parseIssueUrl, markerPattern } from './planner.mjs';
import { githubCli } from './planner-github.mjs';
import { relativePath } from './schemas.mjs';
import { assertWritablePath } from './workspace.mjs';
import { acceptancePath } from './acceptance-registry.mjs';
// harness:run SBI_URL reads the SBI from the GitHub Issue a human marked ready. Nothing here is written back to GitHub,
// and nobody transcribes the Issue into SBI JSON: the Harness builds the execution SBI and records it as the Run snapshot.

export function issueReadiness(issue, url) {
  const labels = issue.labels.map(l => l.name), reasons = [];
  if (issue.pull_request) reasons.push(`${url} is a pull request, not an SBI Issue`);
  if (issue.state !== 'open') reasons.push(`${url} is not open (${issue.state ?? 'unknown'})`);
  if (!labels.includes('sbi')) reasons.push(`${url} has no sbi label`);
  if (!labels.includes('ready')) reasons.push(`${url} has no ready label`);
  if (labels.includes('needs-review')) reasons.push(`${url} has needs-review`);
  if (!markerPattern.test(issue.body ?? '')) reasons.push(`${url} has no SONOMAMA Planner marker`);
  return reasons;
}

// A directory scope ends with '/', so apps/admin/ never covers apps/admin-other. Reserved paths stay out of scope inside it.
export function inScope(sbi, path) {
  if (!relativePath.safeParse(path).success) return false;
  try { assertWritablePath(path); } catch { return false; }
  return sbi.allowedFiles.includes(path) || (sbi.allowedDirs ?? []).some(dir => path.startsWith(dir));
}

function sections(body) {
  const map = new Map();
  let current = null;
  for (const line of String(body ?? '').replaceAll('\r\n', '\n').split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) map.set(current = heading[1], []);
    else if (current) map.get(current).push(line);
  }
  return map;
}
const fenced = lines => {
  const start = lines.findIndex(l => l.startsWith('```')), end = lines.findIndex((l, i) => i > start && /^```\s*$/.test(l));
  return start < 0 || end < 0 ? null : lines.slice(start + 1, end);
};
// The Planner writes coarse change areas such as apps/admin. Only a plain, writable directory path becomes a scope.
function directoryScope(area) {
  const path = area.endsWith('/') ? area.slice(0, -1) : area;
  if (!/^[A-Za-z0-9._@-]+(\/[A-Za-z0-9._@-]+)*$/.test(path) || !relativePath.safeParse(path).success) return null;
  try { assertWritablePath(path); } catch { return null; }
  return `${path}/`;
}

export function sbiFromIssue({ ref, issue, config }) {
  const parts = sections(issue.body), problems = [];
  for (const name of ['目的', '受け入れ要件', 'Gherkin', '想定変更範囲', 'Risk / Security Impact']) if (!parts.has(name)) problems.push(`## ${name} がありません`);
  const section = name => parts.get(name) ?? [];
  const block = name => parts.has(name) ? fenced(section(name)) : null;
  const purpose = section('目的').join('\n').trim();
  if (parts.has('目的') && !purpose) problems.push('## 目的 が空です');
  const criteria = section('受け入れ要件').flatMap(line => { const m = /^- \[[ xX]\] (\S+?): (.+)$/.exec(line.trim()); return m ? [{ id: m[1], description: m[2].trim() }] : []; });
  if (parts.has('受け入れ要件') && !criteria.length) problems.push('## 受け入れ要件 に要件がありません');
  const gherkin = block('Gherkin');
  if (parts.has('Gherkin') && !gherkin?.some(l => l.trim())) problems.push('## Gherkin にScenarioがありません');
  const areas = block('想定変更範囲');
  if (parts.has('想定変更範囲') && !areas?.length) problems.push('## 想定変更範囲 が空です');
  const allowedDirs = [];
  for (const area of areas ?? []) {
    const dir = directoryScope(area.trim());
    if (dir) allowedDirs.push(dir); else problems.push(`## 想定変更範囲 の ${JSON.stringify(area)} は書き込めるディレクトリとして解釈できません`);
  }
  const risk = block('Risk / Security Impact');
  const candidate = risk?.map(l => /^Risk: (L[123]) candidate$/.exec(l.trim())?.[1]).find(Boolean);
  const security = risk?.map(l => /^Security: (.+)$/.exec(l.trim())?.[1]).find(Boolean);
  if (parts.has('Risk / Security Impact') && (!candidate || !security)) problems.push('## Risk / Security Impact にRiskとSecurityがありません');
  const securityImpact = (security ?? '').split(/,\s*/).map(s => s.trim()).filter(s => s && s !== 'None');
  // Optional for Issues planned before these sections existed: the kind defaults to implementation, and a missing
  // expected number of changed files makes the Completion Judge fail closed instead of blocking the Run here.
  const kind = section('種類').map(l => /（(implementation|validation)）\s*$/.exec(l.trim())?.[1]).find(Boolean) ?? 'implementation';
  const estimate = section('想定変更ファイル数').find(l => l.trim())?.trim();
  const estimatedFiles = /^\d+$/.test(estimate ?? '') ? Number(estimate) : null;
  // The E2E line decides whether a mobile SBI needs the maestro CI job; without it the lane stays required (fail closed).
  const e2e = (block('検証方法') ?? []).map(l => /^E2E: (.*)$/.exec(l.trim())?.[1]).find(v => v !== undefined)?.trim() ?? null;

  // Trusted Acceptance is written, reviewed and registered by a human before ready. Every criterion needs exactly one registration.
  const registered = config.verifiers.filter(v => v.trust === 'acceptance' && v.sbiIssue === ref.number);
  if (!registered.length) problems.push(`Trusted Acceptance が登録されていません（${acceptancePath(ref.number)} がありません）`);
  const acceptanceCriteria = criteria.map(criterion => {
    const owners = registered.filter(v => v.acceptanceIds.includes(criterion.id));
    if (registered.length && owners.length !== 1) problems.push(`${criterion.id} に対応するTrusted Acceptanceが${owners.length}件です（1件必要）`);
    return { ...criterion, verifier: owners[0]?.id ?? 'NOT_REGISTERED' };
  });
  for (const id of new Set(registered.flatMap(v => v.acceptanceIds))) if (!criteria.some(c => c.id === id)) problems.push(`登録済みのTrusted Acceptance ${id} はIssueの受け入れ要件にありません`);
  if (problems.length) throw new Error([`SBI Issue ${ref.url} からExecution SBIを作れません。Runは開始していません。`, ...problems.map(p => `- ${p}`)].join('\n'));
  return {
    id: `ISSUE-${ref.number}`, kind, title: issue.title, description: purpose,
    gherkin: [`Feature: ${issue.title}`, ...gherkin.map(line => line.trim() ? `  ${line}` : '')].join('\n'),
    acceptanceCriteria, allowedFiles: [], allowedDirs, risks: securityImpact, ambiguous: false, requiresDesignDecision: false,
    securityImpact, requiredSecurityRules: [], requiredVerifiers: [], affectedAreas: [], preImplementationGate: false,
    minimumRiskLevel: candidate === 'L3' || securityImpact.length ? 3 : 2, estimatedFiles, e2e, issueUrl: ref.url, pbiUrl: markerPattern.exec(issue.body ?? '')?.[1],
  };
}

// A dependency is done only when its Harness PR was merged into the base branch: merged_at is set, the body says Closes #N and a commit carries
// the SBI-Issue trailer of that Issue. Closing the Issue by hand is not enough, since the canonical packages/api-schema/openapi.yaml
// a Rails or frontend SBI builds on reaches main only by that merge. Anything GitHub cannot answer keeps the run from starting.
async function mergedHarnessPull({ ref, dependency, base, github }) {
  const url = `https://github.com/${ref.owner}/${ref.repo}/issues/${dependency.number}`;
  const pulls = (await github.issueTimeline({ ...ref, number: dependency.number }))
    .map(event => event.event === 'cross-referenced' && event.source?.issue?.pull_request ? event.source.issue : null)
    .filter(source => source?.html_url === `https://github.com/${ref.owner}/${ref.repo}/pull/${source?.number}`);
  for (const number of new Set(pulls.map(p => p.number))) {
    const pull = await github.fetchPull(ref, number);
    if (!pull.merged_at || pull.base.ref !== base || !new RegExp(`^Closes #${dependency.number}\\s*$`, 'm').test(pull.body ?? '')) continue;
    if ((await github.pullCommitMessages(ref, number)).some(message => message.split('\n').some(line => line.trim() === `SBI-Issue: ${url}`))) return pull;
  }
  return null;
}
async function unfinishedDependencies({ ref, issue, config, github }) {
  const lines = (sections(issue.body).get('依存SBI') ?? []).map(l => l.trim()).filter(l => l.startsWith('- '));
  const base = config.github?.base ?? 'main', problems = [];
  for (const line of lines) {
    const number = /\(#([1-9]\d*)\)\s*$/.exec(line)?.[1];
    if (!number) { problems.push(`依存SBI ${line.slice(2)} のIssue番号がありません`); continue; }
    let dependency;
    try { dependency = await github.fetchIssue({ ...ref, number: Number(number) }); }
    catch (error) { problems.push(`依存SBI #${number} を読めません（${error.message}）`); continue; }
    if (dependency.state !== 'closed' || dependency.state_reason !== 'completed') { problems.push(`依存SBI #${number} が完了していません（${dependency.state ?? 'unknown'}${dependency.state_reason ? ` / ${dependency.state_reason}` : ''}）。そのPRのmerge後に実行してください`); continue; }
    let merged;
    try { merged = await mergedHarnessPull({ ref, dependency, base, github }); }
    catch (error) { problems.push(`依存SBI #${number} のPRをGitHubから確認できません（${error.message}）`); continue; }
    if (!merged) problems.push(`依存SBI #${number} はclosedですが、${base}へmergeされたHarness PR（Closes #${number} と SBI-Issue trailer）がありません`);
  }
  return problems;
}

export async function loadSbiIssue({ issueUrl, config, github = githubCli }) {
  const ref = parseIssueUrl(issueUrl);
  let issue;
  try { issue = await github.fetchIssue(ref); } catch (error) { throw new Error(`SBI Issue fetch failed for ${ref.url}: ${error.message}`); }
  const reasons = issueReadiness(issue, ref.url);
  if (reasons.length) throw new Error([`SBI Issue ${ref.url} はreadyではありません。Runは開始していません。`, ...reasons.map(r => `- ${r}`)].join('\n'));
  const sbi = sbiFromIssue({ ref, issue, config });
  const waiting = await unfinishedDependencies({ ref, issue, config, github });
  if (waiting.length) throw new Error([`SBI Issue ${ref.url} の依存SBIが完了していません。Runは開始していません。`, ...waiting.map(p => `- ${p}`)].join('\n'));
  return { ref, issue, sbi };
}
