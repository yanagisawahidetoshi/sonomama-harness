import { createHash } from 'node:crypto';
import { parseIssueUrl, markerPattern } from './planner.mjs';
import { githubCli } from './planner-github.mjs';
import { issueKind, issueDependsOn } from './sbi-issue.mjs';
import { hasSecret } from './evidence-protection.mjs';
import { approvalLine, readCommentApprovals } from './github-approval-records.mjs';

// The PBI plan is the complete SBI set of a PBI. The Planner writes it into the PBI Issue as ## SBI構成 and a human approves it once with a
// harness-pbi-plan comment (github-approval-records.mjs). harness:pbi-status trusts neither the Issue list nor the section alone: the approved
// plan, the PBI marker of each SBI Issue and the SBI Issues GitHub finds for the PBI must be the same set.
export const planPrefix = 'harness-pbi-plan';
const kinds = ['implementation', 'validation'];
const startMarker = pbiUrl => `<!-- sonomama-pbi-plan pbi=${pbiUrl} -->`;
const endMarker = '<!-- /sonomama-pbi-plan -->';
const entryPattern = /^- (SBI-\d{3}): #([1-9]\d*) (\S+)(?: 依存: (SBI-\d{3}(?:, SBI-\d{3})*))?$/;

export const planOf = (pbiNumber, sbis) => ({
  version: 1, pbi: pbiNumber,
  sbis: sbis.map(({ id, number, kind, dependsOn = [] }) => ({ id, number, kind, dependsOn: [...new Set(dependsOn)].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
});
export const planDigest = plan => createHash('sha256').update(JSON.stringify(planOf(plan.pbi, plan.sbis))).digest('hex');

export function renderPlanSection(pbiUrl, plan) {
  return [
    startMarker(pbiUrl), '## SBI構成', '',
    ...plan.sbis.map(s => `- ${s.id}: #${s.number} ${s.kind}${s.dependsOn.length ? ` 依存: ${s.dependsOn.join(', ')}` : ''}`), '',
    `PBI plan digest: \`${planDigest(plan)}\``, `確認後に承認する: \`pnpm harness:pbi-plan-approve ${pbiUrl}\``,
    '_SONOMAMA Harnessが生成。この節を編集するとdigestが変わり、承認は無効になる。_', endMarker, '',
  ].join('\n');
}

export function parsePlan(body, pbiUrl) {
  const text = String(body ?? '').replaceAll('\r\n', '\n'), start = text.indexOf(startMarker(pbiUrl));
  if (start < 0) return { plan: null, errors: ['PBI本文に ## SBI構成 がありません'] };
  const end = text.indexOf(endMarker, start);
  if (end < 0) return { plan: null, errors: ['## SBI構成 の終わりのmarkerがありません'] };
  const errors = [], sbis = [];
  for (const line of text.slice(start, end).split('\n').map(l => l.trim()).filter(l => l.startsWith('- '))) {
    const match = entryPattern.exec(line);
    if (!match || !kinds.includes(match[3])) { errors.push(`## SBI構成 の行 ${JSON.stringify(line)} を読めません`); continue; }
    sbis.push({ id: match[1], number: Number(match[2]), kind: match[3], dependsOn: match[4] ? match[4].split(', ') : [] });
  }
  if (!sbis.length) errors.push('## SBI構成 にSBIがありません');
  for (const key of ['id', 'number']) if (new Set(sbis.map(s => s[key])).size !== sbis.length) errors.push(`## SBI構成 に同じ${key === 'id' ? 'SBI ID' : 'Issue番号'}が複数あります`);
  return errors.length ? { plan: null, errors } : { plan: planOf(parseIssueUrl(pbiUrl).number, sbis), errors };
}

export function withPlanSection(body, section) {
  const text = String(body ?? '').replaceAll('\r\n', '\n'), start = text.search(/<!-- sonomama-pbi-plan pbi=\S+ -->/);
  if (start < 0) return `${text.trimEnd()}\n\n${section}`;
  const end = text.indexOf(endMarker, start);
  const rest = end < 0 ? '' : text.slice(end + endMarker.length).replace(/^\n/, '');
  return `${text.slice(0, start)}${section}${rest}`;
}

// The SBI Issues GitHub finds for the PBI: the sbi label and a Planner marker that names this PBI.
export async function pbiSbis(ref, github, problems) {
  const issues = (await github.listIssues(ref, 'sbi')).filter(issue => !issue.pull_request && markerPattern.exec(issue.body ?? '')?.[1] === ref.url);
  const byId = new Map();
  for (const issue of issues) {
    const id = markerPattern.exec(issue.body)[2];
    byId.set(id, [...(byId.get(id) ?? []), issue]);
  }
  const sbis = [];
  for (const [id, found] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    // A replaced SBI Issue loses its sbi label (pbi-sbi-planner.md); two that still claim one ID are a human decision, not ours.
    if (found.length > 1) { problems.push(`SBI ${id} を名乗るIssueが複数あります（${found.map(i => `#${i.number}`).join(', ')}）。古いIssueから sbi ラベルを外してください`); continue; }
    const [issue] = found;
    sbis.push({ id, kind: issueKind(issue.body), dependsOn: issueDependsOn(issue.body), number: issue.number, title: issue.title, issueUrl: issue.html_url });
  }
  if (!sbis.length && !problems.length) problems.push(`${ref.url} に紐づくSBI Issue（sbiラベルとPlannerのmarker）がありません`);
  // An SBI that dropped out of the list (label or marker removed) is still named by the SBIs that depend on it.
  for (const sbi of sbis) for (const dependency of sbi.dependsOn) if (!byId.has(dependency)) problems.push(`SBI ${sbi.id} の依存SBI ${dependency} がこのPBIのSBI Issueにありません`);
  return sbis;
}

export function comparePlan(plan, sbis, label = '承認済みPBI plan') {
  const problems = [], found = new Map(sbis.map(s => [s.number, s]));
  for (const entry of plan.sbis) {
    const sbi = found.get(entry.number);
    if (!sbi) { problems.push(`SBI #${entry.number} が見つかりません（${label}の ${entry.id}。sbiラベルかPlannerのmarkerがありません）`); continue; }
    const current = planOf(plan.pbi, [sbi]).sbis[0];
    if (JSON.stringify(current) !== JSON.stringify(entry)) problems.push(`SBI #${entry.number} のID・kind・依存（${current.id} ${current.kind} 依存: ${current.dependsOn.join(', ') || 'なし'}）が${label}と一致しません`);
  }
  for (const sbi of sbis) if (!plan.sbis.some(e => e.number === sbi.number)) problems.push(`SBI #${sbi.number} が${label}に登録されていません`);
  return problems;
}

async function readPlan(ref, github) {
  const issue = await github.fetchIssue(ref);
  if (issue.pull_request) throw new Error(`${ref.url} is a pull request, not a PBI Issue`);
  return { issue, ...parsePlan(issue.body, ref.url) };
}

// pnpm harness:pbi-plan PBI_URL: writes ## SBI構成 from the SBI Issues GitHub finds for the PBI, for a PBI planned before the section existed.
// The result still needs harness:pbi-plan-approve; the human reviews the set before approving it.
export async function writePbiPlan({ pbiUrl, github = githubCli }) {
  const ref = parseIssueUrl(pbiUrl), problems = [];
  const issue = await github.fetchIssue(ref);
  if (issue.pull_request) throw new Error(`${ref.url} is a pull request, not a PBI Issue`);
  const sbis = await pbiSbis(ref, github, problems);
  if (problems.length) throw new Error(['## SBI構成 を書けません。PBI本文は変更していません。', ...problems.map(p => `- ${p}`)].join('\n'));
  const plan = planOf(ref.number, sbis);
  await writePlanSection({ ref, issue, plan, github });
  return { plan, digest: planDigest(plan) };
}
export async function writePlanSection({ ref, issue, plan, github }) {
  const section = renderPlanSection(ref.url, plan);
  if (hasSecret(section)) throw new Error('Secret/Credential detected in ## SBI構成; rejected before any GitHub write');
  const body = withPlanSection(issue.body, section);
  if (body !== String(issue.body ?? '').replaceAll('\r\n', '\n')) await github.updateIssue(ref, { body });
}

// pnpm harness:pbi-plan-approve PBI_URL: the human's gh posts the approval line. Only a plan that matches the SBI Issues on GitHub can be approved.
export async function approvePbiPlan({ pbiUrl, decision = 'approve', github = githubCli }) {
  const ref = parseIssueUrl(pbiUrl);
  if (!['approve', 'revoke'].includes(decision)) throw new Error('Unknown PBI plan decision');
  const { plan, errors } = await readPlan(ref, github);
  if (!plan) throw new Error(['PBI planを読めません。承認していません。', ...errors.map(e => `- ${e}`), `- pnpm harness:pbi-plan ${ref.url} で ## SBI構成 を書けます`].join('\n'));
  const digest = planDigest(plan);
  if (decision === 'approve') {
    const problems = [];
    problems.push(...comparePlan(plan, await pbiSbis(ref, github, problems), 'PBI plan'));
    if (problems.length) throw new Error(['## SBI構成 がGitHubのSBI Issueと一致しません。承認していません。', ...problems.map(p => `- ${p}`)].join('\n'));
  }
  const comment = await github.addComment(ref, approvalLine(planPrefix, digest, decision));
  return { plan, digest, comment: comment.html_url, ...await readCommentApprovals({ ref, prefix: planPrefix, digest, github }) };
}
