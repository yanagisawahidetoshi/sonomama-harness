import { createHash } from 'node:crypto';
import { z } from 'zod';
import { check } from './check.mjs';
import { parseIssueUrl, markerPattern } from './planner.mjs';
import { githubCli } from './planner-github.mjs';
import { githubPrCli, ciStatus } from './github-pr.mjs';
import { issueKind, issueDependsOn, mergedHarnessPull } from './sbi-issue.mjs';
import { judgePbi } from './pbi-judge.mjs';
import { pbiAcceptanceRecords, recordPbiAcceptance } from './pbi-acceptance.mjs';
import { localHumanIdentity } from './human-approvals.mjs';

// harness:pbi-status collects what judgePbi needs from trusted adapters only: GitHub (SBI Issues, merged Harness PRs, required checks on the
// merged head, the Issues the PBI is blocked by), the Maestro E2E Evidence and the signed pbi-acceptance ledger. Nothing comes from an agent or a PR body.
// An adapter that cannot answer adds a reason, and any reason keeps the PBI NOT_DONE; judgePbi itself stays adapter-independent.

// The Maestro result files of #68 (PR #142) are not on main yet. Until they are connected, no SBI has E2E evidence, and that is never read
// as "no E2E target": the PBI stays NOT_DONE. A connected adapter returns { connected: true, e2e: null | { status, api }, evidenceDigest? } (evidenceSchema).
export const maestroEvidenceNotConnected = Object.freeze({
  async read() { return { connected: false, reason: 'Maestro E2E Evidenceが未接続です（#142のマージ後に接続します）' }; },
});

// The adapter answer is validated as a whole: a missing e2e key is invalid evidence, never "no E2E target". Validation needs its evidence digest.
const e2eSchema = z.strictObject({ status: z.string().min(1), api: z.enum(['mock', 'real']) });
const evidenceSchema = z.discriminatedUnion('connected', [
  z.strictObject({ connected: z.literal(false), reason: z.string().min(1) }),
  z.strictObject({ connected: z.literal(true), e2e: e2eSchema.nullable(), evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/).optional() }),
]);
const digestOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256 = /^[0-9a-f]{64}$/;

async function sbisOfPbi(ref, github, problems) {
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
  for (const sbi of sbis) for (const id of sbi.dependsOn) if (!byId.has(id)) problems.push(`SBI ${sbi.id} の依存SBI ${id} がこのPBIのSBI Issueにありません`);
  return sbis;
}

async function requiredChecks(ref, config, githubPr) {
  const base = config.github?.base ?? 'main';
  const configured = (config.github?.requiredChecks ?? []).map(context => ({ context, integrationId: null }));
  return [...new Map([...configured, ...await githubPr.rulesetChecks(ref, base)].map(c => [`${c.context}\0${c.integrationId}`, c])).values()];
}

export async function collectPbiStatus({ root, pbiUrl, config, github = githubCli, githubPr = githubPrCli, evidence = maestroEvidenceNotConnected,
  acceptanceRecords = url => pbiAcceptanceRecords(root, url) }) {
  const ref = parseIssueUrl(pbiUrl);
  config ??= (await check(root)).config;
  const problems = [], output = { pbi: { url: ref.url, number: ref.number, title: null }, sbis: [], blockers: [] };
  const attempt = async (what, fn, fallback) => { try { return await fn(); } catch (error) { problems.push(`${what}をGitHubから読めません（${error.message}）`); return fallback; } };

  const issue = await attempt(`PBI ${ref.url}`, () => github.fetchIssue(ref), null);
  if (issue?.pull_request) problems.push(`${ref.url} is a pull request, not a PBI Issue`);
  output.pbi.title = issue?.title ?? null;
  const sbis = issue && !issue.pull_request ? await attempt('SBI Issueの一覧', () => sbisOfPbi(ref, github, problems), []) : [];
  const required = await attempt('必須check', () => requiredChecks(ref, config, githubPr), null);
  const base = config.github?.base ?? 'main', results = {}, merged = [];
  const composition = sbis.map(({ id, number, kind }) => ({ id, number, kind }));
  for (const sbi of sbis) {
    const where = `SBI ${sbi.id}（#${sbi.number}）`;
    const pull = await attempt(`${where} のHarness PR`, () => mergedHarnessPull({ ref, dependency: { number: sbi.number }, base, github }), undefined);
    const row = { ...sbi, merged: Boolean(pull), pullRequest: pull ? { number: pull.number, url: `https://github.com/${ref.owner}/${ref.repo}/pull/${pull.number}`, headSha: pull.head?.sha ?? null } : null,
      requiredVerifiers: null, e2e: null, evidence: 'UNREADABLE', status: null };
    output.sbis.push(row);
    let read;
    try {
      const parsed = evidenceSchema.safeParse(await evidence.read({ sbi, pull: pull ?? null }));
      if (!parsed.success) problems.push(`${where} のMaestro E2E Evidenceの形式が不正です（${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}）`);
      else if (parsed.data.connected && sbi.kind === 'validation' && !parsed.data.evidenceDigest) problems.push(`${where} のMaestro E2E Evidenceの形式が不正です（validationにevidenceDigestがありません）`);
      else read = parsed.data;
    } catch (error) { problems.push(`${where} のMaestro E2E Evidenceを読めません（${error.message}）`); }
    if (read && !read.connected) problems.push(`${where}: ${read.reason}`);
    const e2e = read?.connected ? read.e2e : null;
    row.e2e = e2e;
    if (read) row.evidence = read.connected ? 'CONNECTED' : 'NOT_CONNECTED';
    if (sbi.kind === 'validation') {
      // The digest the human approves also binds the SBI composition, so adding, dropping or swapping an SBI voids an earlier APPROVE.
      if (read?.connected) results[sbi.id] = { e2e, evidenceDigest: digestOf({ sbis: composition, evidence: read.evidenceDigest }) };
      continue;
    }
    if (pull === null) problems.push(`${where} にmainへmergeされたHarness PR（Closes #${sbi.number} と SBI-Issue trailer）がありません`);
    if (!pull) continue;
    if (!pull.head?.sha) { problems.push(`${where} のPR #${pull.number} のhead SHAがありません`); continue; }
    // Required checks of the merged head: the Completion Judge (harness) and the ruleset checks, as the Merge Policy reads them.
    const ci = required && await attempt(`${where} のPR #${pull.number} のcheck`, async () => ciStatus({ checkRuns: await githubPr.checkRuns(ref, pull.head.sha), required }), null);
    row.requiredVerifiers = ci?.status ?? null;
    if (!read?.connected || !ci) continue;
    results[sbi.id] = { merged: true, requiredVerifiers: ci.status, e2e };
    merged.push({ sbi: sbi.id, issueUrl: sbi.issueUrl, pullRequest: pull.number, headSha: pull.head.sha, mergeCommitSha: pull.merge_commit_sha ?? null, e2e });
  }

  const implementations = sbis.filter(s => s.kind === 'implementation'), validations = sbis.filter(s => s.kind === 'validation');
  // Without a validation SBI the human confirms the merged implementation evidence; the digest changes whenever any part of it does.
  const evidenceDigest = validations.length ? (sha256.test(results[validations[0].id]?.evidenceDigest ?? '') ? results[validations[0].id].evidenceDigest : null)
    : implementations.length && merged.length === implementations.length ? digestOf({ sbis: composition, evidence: merged }) : null;
  output.blockers = issue && !issue.pull_request ? (await attempt('PBIをブロックしているIssue（blocked by）', () => github.blockedBy(ref), [])).map(i => ({ url: i.html_url, title: i.title, state: i.state ?? null })) : [];
  let records = [];
  try { records = await acceptanceRecords(ref.url); } catch (error) { problems.push(`PBI Human Acceptanceの台帳を読めません（${error.message}）`); }

  const judged = judgePbi({ pbiUrl: ref.url, sbis: sbis.map(({ id, kind, dependsOn }) => ({ id, kind, dependsOn })), results, evidenceDigest: evidenceDigest ?? undefined,
    acceptanceRecords: records, blockers: output.blockers });
  for (const row of output.sbis) row.status = judged.sbis[row.id] ?? 'PENDING';
  const ready = !problems.length && sbis.length > 0 && validations.length <= 1 && sbis.every(s => judged.sbis[s.id] === 'DONE') && evidenceDigest !== null
    && output.blockers.every(b => b.state === 'closed');
  return {
    status: judged.status === 'DONE' && !problems.length ? 'DONE' : 'NOT_DONE', ...output, acceptance: judged.acceptance,
    evidenceDigest, ready, reasons: [...problems, ...judged.reasons],
  };
}

const mark = ok => ok ? '✅' : '❌';
export function renderPbiStatus(result) {
  const sbiLine = s => [`${mark(s.status === 'DONE')} ${s.id} ${s.kind} (#${s.issueUrl.split('/').pop()})`,
    ...(s.kind === 'implementation' ? [s.merged ? `merged PR #${s.pullRequest.number}` : 'not merged', `verifier ${s.requiredVerifiers ?? '-'}`] : []),
    s.evidence === 'NOT_CONNECTED' ? 'E2E 未接続' : s.evidence === 'UNREADABLE' ? 'E2E unreadable'
      : s.e2e ? `E2E ${s.e2e.api} ${s.e2e.status}` : s.kind === 'validation' ? 'E2E -' : 'E2E none'].join(' / ');
  return [
    `PBI: #${result.pbi.number} ${result.pbi.title ?? '(unreadable)'}`, `Status: ${result.status}`, '',
    'SBI', ...(result.sbis.length ? result.sbis.map(sbiLine) : ['❌ none']), '',
    'Human Acceptance', `${mark(result.acceptance === 'APPROVED')} ${result.acceptance}`,
    ...(result.evidenceDigest ? [`Evidence digest: ${result.evidenceDigest}`] : []),
    ...(result.ready && result.acceptance !== 'APPROVED' ? [`確認後: pnpm harness:pbi-accept ${result.pbi.url} --evidence ${result.evidenceDigest} --decision approve`] : []), '',
    'Blockers', ...(result.blockers.length ? result.blockers.map(b => `${mark(b.state === 'closed')} ${b.url} ${b.title} (${b.state})`) : ['✅ none']),
    ...(result.reasons.length ? ['', 'Reason:', ...result.reasons.map(r => `- ${r}`)] : []),
  ];
}

// APPROVE is the last Gate of the PBI: it is recorded only once every SBI is done, the evidence was read, the digest matches and no blocker is open.
// REQUEST_CHANGES and REVOKE withdraw, so they never wait for GitHub or the evidence.
export async function acceptPbi({ root, pbiUrl, evidenceDigest, decision = 'APPROVE', identityProvider = localHumanIdentity, ...adapters }) {
  if (decision === 'APPROVE') {
    const current = await collectPbiStatus({ root, pbiUrl, ...adapters });
    if (!current.ready) throw new Error(['PBIはまだ受け入れ確認できません。記録していません。', ...current.reasons.map(r => `- ${r}`)].join('\n'));
    if (current.evidenceDigest !== evidenceDigest) throw new Error(`Evidence digest ${evidenceDigest} は現在のEvidence ${current.evidenceDigest} と一致しません。記録していません`);
  }
  const record = await recordPbiAcceptance({ root, pbiUrl, evidenceDigest, decision, identityProvider });
  return { record, status: await collectPbiStatus({ root, pbiUrl, ...adapters }) };
}
