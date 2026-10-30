import { createHash } from 'node:crypto';
import { z } from 'zod';
import { check } from './check.mjs';
import { parseIssueUrl } from './planner.mjs';
import { githubCli } from './planner-github.mjs';
import { githubPrCli, ciStatus } from './github-pr.mjs';
import { mergedHarnessPull } from './sbi-issue.mjs';
import { parsePlan, planDigest, pbiSbis, comparePlan, planPrefix, planRevision, approvalKey } from './pbi-plan.mjs';
import { readCommentApprovals } from './github-approval-records.mjs';
import { judgePbi } from './pbi-judge.mjs';
import { pbiAcceptanceRecords, recordPbiAcceptance, evidenceManifests, recordEvidenceManifest } from './pbi-acceptance.mjs';
import { localHumanIdentity } from './human-approvals.mjs';
import { maestroEvidence } from './maestro-evidence.mjs';

// harness:pbi-status collects what judgePbi needs from trusted adapters only: GitHub (SBI Issues, merged Harness PRs, required checks on the
// merged head, the Issues the PBI is blocked by), the Maestro E2E Evidence and the signed pbi-acceptance ledger. Nothing comes from an agent or a PR body.
// An adapter that cannot answer adds a reason, and any reason keeps the PBI NOT_DONE; judgePbi itself stays adapter-independent.

// The evidence adapter (maestro-evidence.mjs by default) answers { connected: true, e2e: null | { status, api }, evidenceDigest? }
// or { connected: false, reason }; a missing answer is never read as "no E2E target" (evidenceSchema).

// The adapter answer is validated as a whole: a missing e2e key is invalid evidence, never "no E2E target". Validation needs its evidence digest.
const e2eSchema = z.strictObject({ status: z.string().min(1), api: z.enum(['mock', 'real']) });
const evidenceSchema = z.discriminatedUnion('connected', [
  z.strictObject({ connected: z.literal(false), reason: z.string().min(1) }),
  z.strictObject({ connected: z.literal(true), e2e: e2eSchema.nullable(), evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    source: z.strictObject({ workflowRunId: z.number().int().positive(), artifactId: z.number().int().positive(), lane: z.enum(['mock', 'real']), resultDigest: z.string().regex(/^[0-9a-f]{64}$/) }).optional() }),
]);
const digestOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256 = /^[0-9a-f]{64}$/;

async function requiredChecks(ref, config, githubPr) {
  const base = config.github?.base ?? 'main';
  const configured = (config.github?.requiredChecks ?? []).map(context => ({ context, integrationId: null }));
  return [...new Map([...configured, ...await githubPr.rulesetChecks(ref, base)].map(c => [`${c.context}\0${c.integrationId}`, c])).values()];
}

export async function collectPbiStatus({ root, pbiUrl, config, github = githubCli, githubPr = githubPrCli, actions, evidence,
  acceptanceRecords = url => pbiAcceptanceRecords(root, url), manifests = url => evidenceManifests(root, url) }) {
  const ref = parseIssueUrl(pbiUrl);
  evidence ??= maestroEvidence({ ref, github, ...(actions ? { actions } : {}) });
  config ??= (await check(root)).config;
  const problems = [], output = { pbi: { url: ref.url, number: ref.number, title: null }, plan: { digest: null, revision: null, approvalKey: null, approved: false, approvers: [] }, sbis: [], blockers: [] };
  const attempt = async (what, fn, fallback) => { try { return await fn(); } catch (error) { problems.push(`${what}をGitHubから読めません（${error.message}）`); return fallback; } };

  const issue = await attempt(`PBI ${ref.url}`, () => github.fetchIssue(ref), null);
  if (issue?.pull_request) problems.push(`${ref.url} is a pull request, not a PBI Issue`);
  output.pbi.title = issue?.title ?? null;
  const sbis = issue && !issue.pull_request ? await attempt('SBI Issueの一覧', () => pbiSbis(ref, github, problems), []) : [];
  // The approved plan, the PBI marker of each SBI Issue and the SBI Issues found on GitHub must be the same set.
  const { plan, errors: planErrors } = issue && !issue.pull_request ? parsePlan(issue.body, ref.url) : { plan: null, errors: [] };
  problems.push(...planErrors.map(e => `PBI plan: ${e}（pnpm harness:pbi-plan ${ref.url} で生成し、pnpm harness:pbi-plan-approve ${ref.url} で承認する）`));
  if (plan) {
    output.plan.digest = planDigest(plan);
    const versions = await attempt('PBI本文の編集履歴', () => github.bodyVersions(ref), null);
    if (versions) {
      output.plan.revision = planRevision({ versions, currentBody: issue.body, pbiUrl: ref.url });
      output.plan.approvalKey = approvalKey(output.plan.digest, output.plan.revision);
      Object.assign(output.plan, await attempt('PBI planの承認', () => readCommentApprovals({ ref, prefix: planPrefix, digest: output.plan.approvalKey, github }), {}));
    }
    if (!output.plan.approved) problems.push(`PBI plan（digest ${output.plan.digest.slice(0, 12)}）が承認されていません。## SBI構成 を確認して pnpm harness:pbi-plan-approve ${ref.url}`);
    problems.push(...comparePlan(plan, sbis));
  }
  const required = await attempt('必須check', () => requiredChecks(ref, config, githubPr), null);
  const base = config.github?.base ?? 'main', results = {}, merged = [];
  const composition = sbis.map(({ id, number, kind }) => ({ id, number, kind }));
  const pulls = new Map();
  for (const sbi of sbis) pulls.set(sbi.id, await attempt(`SBI ${sbi.id}（#${sbi.number}） のHarness PR`, () => mergedHarnessPull({ ref, dependency: { number: sbi.number }, base, github }), undefined));
  // After an APPROVE the raw artifact may expire. A signed manifest stands in only while the approved plan, the SBI composition and the PR,
  // head and merge commit of every SBI are still the ones it recorded; any change voids the whole manifest.
  let signed;
  const current = (entry, sbi) => { const pull = pulls.get(sbi.id); return entry.id === sbi.id && entry.number === sbi.number && entry.kind === sbi.kind
    && entry.pullRequest === (pull?.number ?? null) && entry.headSha === (pull?.head?.sha ?? null) && entry.mergeCommitSha === (pull?.merge_commit_sha ?? null); };
  const fromManifest = async (sbi, gone) => {
    signed ??= await manifests(ref.url);
    const valid = signed.filter(m => m.plan.approvalKey === output.plan.approvalKey && m.sbis.length === sbis.length && sbis.every((s, i) => current(m.sbis[i], s)));
    const entry = valid.at(-1)?.sbis.find(e => e.id === sbi.id) ?? null;
    // A re-run after APPROVE selects another artifact; the manifest stands in only for the very run and artifact it recorded.
    return entry && entry.workflowRunId === gone.workflowRunId && entry.artifactId === gone.artifactId ? entry : null;
  };
  const entries = [];
  for (const sbi of sbis) {
    const where = `SBI ${sbi.id}（#${sbi.number}）`;
    const pull = pulls.get(sbi.id);
    const row = { ...sbi, merged: Boolean(pull), pullRequest: pull ? { number: pull.number, url: `https://github.com/${ref.owner}/${ref.repo}/pull/${pull.number}`, headSha: pull.head?.sha ?? null } : null,
      requiredVerifiers: null, e2e: null, evidence: 'UNREADABLE', status: null };
    output.sbis.push(row);
    // Required checks of the merged head: the Completion Judge (harness) and the ruleset checks, as the Merge Policy reads them.
    const ci = pull?.head?.sha && required ? await attempt(`${where} のPR #${pull.number} のcheck`, async () => ciStatus({ checkRuns: await githubPr.checkRuns(ref, pull.head.sha), required }), null) : null;
    let read;
    try {
      const parsed = evidenceSchema.safeParse(await evidence.read({ sbi, pull: pull ?? null }));
      if (!parsed.success) problems.push(`${where} のMaestro E2E Evidenceの形式が不正です（${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}）`);
      else if (parsed.data.connected && sbi.kind === 'validation' && !parsed.data.evidenceDigest) problems.push(`${where} のMaestro E2E Evidenceの形式が不正です（validationにevidenceDigestがありません）`);
      else read = parsed.data;
    } catch (error) {
      let entry = null;
      if (error.artifactUnavailable) {
        try { entry = await fromManifest(sbi, error); } catch (manifestError) { problems.push(`${where} のEvidence manifestを読めません（${manifestError.message}）`); }
      }
      if (entry) {
        read = { connected: true, e2e: entry.e2e, evidenceDigest: entry.resultDigest ?? undefined, source: entry.lane ? { workflowRunId: entry.workflowRunId, artifactId: entry.artifactId, lane: entry.lane, resultDigest: entry.resultDigest } : undefined };
        row.evidence = 'MANIFEST';
      } else problems.push(`${where} のMaestro E2E Evidenceを読めません（${error.message}）`);
    }
    if (read && !read.connected) problems.push(`${where}: ${read.reason}`);
    const e2e = read?.connected ? read.e2e : null;
    row.e2e = e2e;
    if (read && row.evidence !== 'MANIFEST') row.evidence = read.connected ? 'CONNECTED' : 'NOT_CONNECTED';
    if (read?.connected) entries.push({ id: sbi.id, number: sbi.number, kind: sbi.kind, pullRequest: pull?.number ?? null, headSha: pull?.head?.sha ?? null, mergeCommitSha: pull?.merge_commit_sha ?? null,
      requiredChecks: (ci?.checks ?? []).map(c => ({ name: c.name, status: c.status })), e2e, lane: read.source?.lane ?? null, resultDigest: read.source?.resultDigest ?? read.evidenceDigest ?? null,
      workflowRunId: read.source?.workflowRunId ?? null, artifactId: read.source?.artifactId ?? null });
    if (sbi.kind === 'validation') {
      // The digest the human approves also binds the SBI composition, so adding, dropping or swapping an SBI voids an earlier APPROVE.
      if (read?.connected) results[sbi.id] = { e2e, evidenceDigest: digestOf({ plan: output.plan.approvalKey, sbis: composition, evidence: read.evidenceDigest }) };
      continue;
    }
    if (pull === null) problems.push(`${where} にmainへmergeされたHarness PR（Closes #${sbi.number} と SBI-Issue trailer）がありません`);
    if (!pull) continue;
    if (!pull.head?.sha) { problems.push(`${where} のPR #${pull.number} のhead SHAがありません`); continue; }
    row.requiredVerifiers = ci?.status ?? null;
    if (!read?.connected || !ci) continue;
    results[sbi.id] = { merged: true, requiredVerifiers: ci.status, e2e };
    merged.push({ sbi: sbi.id, issueUrl: sbi.issueUrl, pullRequest: pull.number, headSha: pull.head.sha, mergeCommitSha: pull.merge_commit_sha ?? null, e2e, e2eDigest: read.evidenceDigest ?? null });
  }

  const implementations = sbis.filter(s => s.kind === 'implementation'), validations = sbis.filter(s => s.kind === 'validation');
  // Without a validation SBI the human confirms the merged implementation evidence; the digest changes whenever any part of it does.
  const evidenceDigest = validations.length ? (sha256.test(results[validations[0].id]?.evidenceDigest ?? '') ? results[validations[0].id].evidenceDigest : null)
    : implementations.length && merged.length === implementations.length ? digestOf({ plan: output.plan.approvalKey, sbis: composition, evidence: merged }) : null;
  output.blockers = issue && !issue.pull_request ? (await attempt('PBIをブロックしているIssue（blocked by）', () => github.blockedBy(ref), [])).map(i => ({ url: i.html_url, title: i.title, state: i.state ?? null })) : [];
  let records = [];
  try { records = await acceptanceRecords(ref.url); } catch (error) { problems.push(`PBI Human Acceptanceの台帳を読めません（${error.message}）`); }

  const judged = judgePbi({ pbiUrl: ref.url, sbis: sbis.map(({ id, kind, dependsOn }) => ({ id, kind, dependsOn })), results, evidenceDigest: evidenceDigest ?? undefined,
    acceptanceRecords: records, blockers: output.blockers });
  for (const row of output.sbis) row.status = judged.sbis[row.id] ?? 'PENDING';
  const ready = !problems.length && sbis.length > 0 && validations.length <= 1 && sbis.every(s => judged.sbis[s.id] === 'DONE') && evidenceDigest !== null
    && output.blockers.every(b => b.state === 'closed');
  const result = {
    status: judged.status === 'DONE' && !problems.length ? 'DONE' : 'NOT_DONE', ...output, acceptance: judged.acceptance,
    evidenceDigest, ready, reasons: [...problems, ...judged.reasons],
  };
  // What harness:pbi-accept signs as the Evidence manifest; kept out of the JSON output.
  Object.defineProperty(result, 'manifestDraft', { value: { evidenceDigest, plan: { digest: output.plan.digest, revision: output.plan.revision, approvalKey: output.plan.approvalKey }, sbis: entries } });
  return result;
}

const mark = ok => ok ? '✅' : '❌';
export function renderPbiStatus(result) {
  const sbiLine = s => [`${mark(s.status === 'DONE')} ${s.id} ${s.kind} (#${s.issueUrl.split('/').pop()})`,
    ...(s.kind === 'implementation' ? [s.merged ? `merged PR #${s.pullRequest.number}` : 'not merged', `verifier ${s.requiredVerifiers ?? '-'}`] : []),
    s.evidence === 'NOT_CONNECTED' ? 'E2E 未接続' : s.evidence === 'UNREADABLE' ? 'E2E unreadable'
      : s.e2e ? `E2E ${s.e2e.api} ${s.e2e.status}${s.evidence === 'MANIFEST' ? ' (manifest)' : ''}` : s.kind === 'validation' ? 'E2E -' : 'E2E none'].join(' / ');
  return [
    `PBI: #${result.pbi.number} ${result.pbi.title ?? '(unreadable)'}`, `Status: ${result.status}`, '',
    'PBI plan', result.plan.digest ? `${mark(result.plan.approved)} ${result.plan.approved ? `APPROVED by ${result.plan.approvers.join(', ')}` : 'NOT_APPROVED'} (digest ${result.plan.digest.slice(0, 12)})` : '❌ ## SBI構成 なし', '',
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
    // APPROVE verifies the raw CI artifacts; evidence that only a previous manifest still holds cannot be approved again.
    const stale = current.sbis.filter(s => s.evidence === 'MANIFEST').map(s => s.id);
    if (stale.length) throw new Error(`PBIはまだ受け入れ確認できません。記録していません。\n- ${stale.join(', ')} のMaestro E2E EvidenceをCIのartifactから検証できません（manifestだけが残っています）`);
    await recordEvidenceManifest({ root, pbiUrl, manifest: current.manifestDraft });
  }
  const record = await recordPbiAcceptance({ root, pbiUrl, evidenceDigest, decision, identityProvider });
  return { record, status: await collectPbiStatus({ root, pbiUrl, ...adapters }) };
}
