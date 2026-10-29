import { z } from 'zod';
import { api } from './planner-github.mjs';
import { git } from './workspace.mjs';

// GitHub is the Source of Truth for the pull request, its reviews and CI. Only reviews on the Harness tested SHA count as approvals.
const decisive = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
export const isBot = user => user?.type === 'Bot' || /\[bot\]$/.test(user?.login ?? '');
// GitHub counts reviews only from people with write access; an unreadable permission never grants an approval but still blocks.
export const canMerge = permission => ['admin', 'write'].includes(permission);
export function reviewApprovals({ reviews, headSha, author, permissions }) {
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const login = review.user?.login;
    if (!login || isBot(review.user) || login === author || !decisive.has(review.state)) continue;
    latest.set(login, review);
  }
  const effective = [...latest.values()].filter(r => canMerge(permissions[r.user.login]) || (r.state === 'CHANGES_REQUESTED' && !['read', 'none'].includes(permissions[r.user.login])));
  // An approval of an older commit grants nothing; a request for changes stands until the reviewer re-reviews or it is dismissed.
  const approvedHumans = effective.filter(r => r.state === 'APPROVED' && r.commit_id === headSha).map(r => r.user.login).sort();
  const changesRequestedBy = effective.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.user.login).sort();
  return { approvedHumans, changesRequested: changesRequestedBy.length > 0, changesRequestedBy };
}

export function ciStatus({ checkRuns, required }) {
  if (!required.length) return { status: 'NOT_CONFIGURED', checks: [] };
  // A ruleset may pin a check to the GitHub App expected to report it; a same-named check from another app does not satisfy it.
  const checks = required.map(({ context: name, integrationId = null }) => {
    const id = integrationId === null ? {} : { integrationId };
    const run = checkRuns.filter(r => r.name === name && (integrationId === null || r.app?.id === integrationId)).sort((a, b) => b.id - a.id)[0];
    if (!run) return { name, ...id, status: 'MISSING' };
    if (run.status !== 'completed') return { name, ...id, status: 'PENDING' };
    return { name, ...id, status: run.conclusion === 'success' ? 'SUCCESS' : run.conclusion === 'cancelled' ? 'CANCELLED' : 'FAILURE', conclusion: run.conclusion };
  });
  const status = checks.every(c => c.status === 'SUCCESS') ? 'PASS' : checks.some(c => c.status === 'PENDING') && checks.every(c => ['SUCCESS', 'PENDING'].includes(c.status)) ? 'PENDING' : 'FAIL';
  return { status, checks };
}

const user = z.looseObject({ login: z.string(), type: z.string().optional() });
const pullSchema = z.looseObject({ number: z.number().int(), html_url: z.url(), state: z.string(), merged: z.boolean().optional(), merged_at: z.string().nullable().optional(),
  user, head: z.looseObject({ ref: z.string(), sha: z.string() }), base: z.looseObject({ ref: z.string(), sha: z.string() }) });
const reviewSchema = z.looseObject({ id: z.number(), user: user.nullable(), state: z.string(), commit_id: z.string().nullable() });
const checkRunSchema = z.looseObject({ id: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable(), app: z.looseObject({ id: z.number() }).nullable().optional() });
const ruleSchema = z.looseObject({ type: z.string(), parameters: z.looseObject({}).optional() });
async function pages(endpoint, query, pick) {
  const items = [];
  for (let page = 1; page <= 50; page++) {
    const batch = pick(await api('GET', `${endpoint}?${new URLSearchParams({ ...query, per_page: '100', page: String(page) })}`));
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`gh api GET ${endpoint}: too many pages`);
}

// Pushes go through local git and API calls through the authenticated gh CLI; this module never handles a token.
export const githubPrCli = {
  async repository(root, remote) {
    const url = (await git(root, ['config', '--get', `remote.${remote}.url`], true)).stdout.trim();
    const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
    if (!match) throw new Error(`git remote ${remote} はGitHubのリポジトリではありません`);
    return { owner: match[1], repo: match[2], name: `${match[1]}/${match[2]}` };
  },
  // The merge result equals the tested SHA only while the base branch is still the run baseline.
  async assertBaseIsBaseline(root, { remote, base, baselineSha }) {
    const tip = await this.remoteBranchSha(root, remote, base);
    if (tip !== baselineSha) throw new Error(`${remote}/${base} (${tip?.slice(0, 12) ?? 'なし'}) がrunのbaseline ${baselineSha.slice(0, 12)} と一致しません。mergeの結果をHarnessが検証していないため作成しません。最新の${base}からrunを作り直してください`);
  },
  async remoteBranchSha(root, remote, branch) {
    const listed = await git(root, ['ls-remote', '--heads', '--exit-code', remote, `refs/heads/${branch}`], true);
    if (!listed.ok && listed.code !== 2) throw new Error(`git ls-remote ${remote} ${branch} failed`);
    return listed.stdout.trim().split(/\s+/)[0] || null;
  },
  async push(root, remote, sha, branch) { await git(root, ['push', '--quiet', remote, `${sha}:refs/heads/${branch}`]); },
  async findOpenPull({ owner, repo }, branch) {
    return z.array(pullSchema).parse(await api('GET', `repos/${owner}/${repo}/pulls?${new URLSearchParams({ head: `${owner}:${branch}`, state: 'open' })}`))[0] ?? null;
  },
  async createPull({ owner, repo }, body) { return pullSchema.parse(await api('POST', `repos/${owner}/${repo}/pulls`, body)); },
  async pull({ owner, repo }, number) { return pullSchema.parse(await api('GET', `repos/${owner}/${repo}/pulls/${number}`)); },
  // harness:reverify rewrites the body of the PR it updated; nothing else of the PR is changed.
  async updatePull({ owner, repo }, number, { body }) { return pullSchema.parse(await api('PATCH', `repos/${owner}/${repo}/pulls/${number}`, { body })); },
  reviews: ({ owner, repo }, number) => pages(`repos/${owner}/${repo}/pulls/${number}/reviews`, {}, value => z.array(reviewSchema).parse(value)),
  // GitHub reports maintain as write and triage as read. A non-collaborator is none.
  async permission({ owner, repo }, login) {
    return z.looseObject({ permission: z.string() }).parse(await api('GET', `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`)).permission;
  },
  checkRuns: ({ owner, repo }, sha) => pages(`repos/${owner}/${repo}/commits/${sha}/check-runs`, {}, value => z.array(checkRunSchema).parse(value.check_runs)),
  // Rulesets are optional; without one (or without access) the configured check names still apply.
  async rulesetChecks({ owner, repo }, base) {
    let rules;
    try { rules = await pages(`repos/${owner}/${repo}/rules/branches/${encodeURIComponent(base)}`, {}, value => z.array(ruleSchema).parse(value)); }
    catch (error) { if (['403', '404'].includes(error.httpStatus)) return []; throw error; }
    return rules.filter(r => r.type === 'required_status_checks').flatMap(r => r.parameters?.required_status_checks ?? [])
      .filter(c => c.context).map(c => ({ context: c.context, integrationId: c.integration_id ?? null }));
  },
};

// The projection handed to the Merge Policy Judge. Raw API responses are never written to the run.
// The pull request base SHA is checked together with the live base branch tip, because the base SHA on the pull request may lag behind.
export async function githubState({ github = githubPrCli, root, remote, repository, pullRequest, headSha, requiredChecks }) {
  const pull = await github.pull(repository, pullRequest.number);
  const remoteBaseSha = await github.remoteBranchSha(root, remote, pull.base.ref);
  const configured = requiredChecks.map(context => ({ context, integrationId: null }));
  const required = [...new Map([...configured, ...await github.rulesetChecks(repository, pullRequest.base)].map(c => [`${c.context}\0${c.integrationId}`, c])).values()]
    .sort((a, b) => a.context.localeCompare(b.context) || String(a.integrationId).localeCompare(String(b.integrationId)));
  const reviews = await github.reviews(repository, pull.number);
  const permissions = {};
  for (const login of [...new Set(reviews.filter(r => r.user && decisive.has(r.state) && !isBot(r.user) && r.user.login !== pull.user.login).map(r => r.user.login))].sort()) {
    try { permissions[login] = await github.permission(repository, login); } catch { permissions[login] = 'unknown'; }
  }
  return {
    pullRequest: { number: pull.number, url: pull.html_url, headSha: pull.head.sha, state: pull.state, merged: pull.merged === true || Boolean(pull.merged_at),
      author: pull.user.login, testedShaMatches: pull.head.sha === headSha, baseRef: pull.base.ref, baseSha: pull.base.sha, remoteBaseSha },
    ci: { requiredChecks: required, ...ciStatus({ checkRuns: await github.checkRuns(repository, pull.head.sha), required }) },
    reviews: { ...reviewApprovals({ reviews, headSha, author: pull.user.login, permissions }), permissions },
  };
}

// The api-contract Verifier prints its findings with fixed prefixes (api-contract.mjs, api-mock-check.mjs); the PR of a Schema SBI lists them.
const listed = (items, limit = 50) => [...items.slice(0, limit).map(item => `  - ${item}`), ...(items.length > limit ? [`  - ほか${items.length - limit}件（Evidenceを参照）`] : [])];
function apiSchemaSection(checks) {
  const check = checks.find(c => c.id === 'api-contract' && c.processes?.length);
  if (!check) return [];
  const lines = check.processes.flatMap(p => `${p.stdout ?? ''}\n${p.stderr ?? ''}`.split('\n'));
  const after = prefix => lines.filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length).trim());
  const group = (label, items) => [`- ${label}: ${items.length ? `${items.length}件` : 'なし'}`, ...listed(items)];
  return ['## API Schema', `- api-contract Verifier: ${check.status}`,
    ...group('breaking', after('BREAKING ')), ...group('non-breaking', after('CHANGE ')),
    ...group('Prismで確認したendpoint', after('Prism Mock: PASS ')), ...group('Prismで呼び出していないendpoint（理由）', after('Prism Mock: SKIP ')),
    ...(after('Prism Mock: FAIL ').length ? group('Prism Mockの失敗', after('Prism Mock: FAIL ')) : []), ''];
}
export function pullRequestBody({ summary, sbi }) {
  const last = summary.iterations.at(-1);
  const checks = (last?.verification?.checks ?? []).map(c => `  - ${c.id}: ${c.status}`);
  return [
    `<!-- sonomama-harness run=${summary.id} sha=${summary.headSha} -->`,
    '## SBI', `- ${sbi.id}: ${sbi.title}`, `- Issue: ${sbi.issueUrl ?? '未設定'}`, ...(sbi.pbiUrl ? [`- 元PBI: ${sbi.pbiUrl}`] : []), '',
    // Merging the PR closes the SBI Issue; harness:run of a dependent SBI waits for exactly that.
    ...(summary.sbiIssue ? [`Closes #${summary.sbiIssue.number}`, ''] : []),
    '## 目的', sbi.description, '',
    '## 受け入れ要件', ...sbi.acceptanceCriteria.map(c => `- ${c.id}: ${c.description}`), '',
    ...apiSchemaSection(last?.verification?.checks ?? []),
    '## Harness',
    `- Run ID: ${summary.id}`, `- tested SHA: ${summary.headSha}`,
    // A re-verification run keeps the SBI snapshot and Harness-Run trailer of the run that implemented the SBI (ADR-0003).
    ...(summary.reverify ? [`- 再検証: ${summary.pullRequest.base}が進んだため、実装を保持したまま最新の${summary.pullRequest.base}と統合して検証し直した`,
      `- 親run: ${summary.reverify.parentRunId}（SBIを実装したrun。SBI snapshotとHarness-Run trailerはこのrunのまま）`,
      `- 旧tested SHA: ${summary.reverify.previousTestedSha}`, `- baseline: ${summary.baselineSha}`] : []),
    `- Verifier: ${last?.verification?.status ?? '-'}`, ...checks,
    `- Security: ${last?.security?.status ?? '-'}（Security Verifier: ${last?.securityVerification?.status ?? '-'}）`,
    `- Risk: LEVEL ${summary.risk?.level ?? '-'}（${(summary.risk?.reasons ?? []).join(', ') || '-'}）`,
    `- 必要なHuman Approval: ${summary.merge?.requiredApprovals ?? '-'}人（GitHub Review。PR作成者とbotは数えない）`,
    `- Evidence: \`${summary.runDir}/\`（Harnessを実行したPCにだけある。PRには添付しない）`, '',
    'tested SHAとPR HEADが一致し、必須CIがPASSし、必要人数のApproveがあり、有効なCHANGES_REQUESTEDがないときだけ、Harnessは`MERGE_ALLOWED`を出す。mergeは人間が行う。',
  ].join('\n');
}
