import { z } from 'zod';
import { api } from './planner-github.mjs';
import { git } from './workspace.mjs';

// GitHub is the Source of Truth for the pull request, its reviews and CI. Only reviews on the Harness tested SHA count as approvals.
const decisive = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const isBot = user => user?.type === 'Bot' || /\[bot\]$/.test(user?.login ?? '');
export function reviewApprovals({ reviews, headSha, author }) {
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const login = review.user?.login;
    if (!login || isBot(review.user) || login === author || !decisive.has(review.state)) continue;
    latest.set(login, review);
  }
  const effective = [...latest.values()];
  // An approval of an older commit grants nothing; a request for changes stands until the reviewer re-reviews or it is dismissed.
  const approvedHumans = effective.filter(r => r.state === 'APPROVED' && r.commit_id === headSha).map(r => r.user.login).sort();
  const changesRequestedBy = effective.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.user.login).sort();
  return { approvedHumans, changesRequested: changesRequestedBy.length > 0, changesRequestedBy };
}

export function ciStatus({ checkRuns, required }) {
  if (!required.length) return { status: 'NOT_CONFIGURED', checks: [] };
  const checks = required.map(name => {
    const run = checkRuns.filter(r => r.name === name).sort((a, b) => b.id - a.id)[0];
    if (!run) return { name, status: 'MISSING' };
    if (run.status !== 'completed') return { name, status: 'PENDING' };
    return { name, status: run.conclusion === 'success' ? 'SUCCESS' : run.conclusion === 'cancelled' ? 'CANCELLED' : 'FAILURE', conclusion: run.conclusion };
  });
  const status = checks.every(c => c.status === 'SUCCESS') ? 'PASS' : checks.some(c => c.status === 'PENDING') && checks.every(c => ['SUCCESS', 'PENDING'].includes(c.status)) ? 'PENDING' : 'FAIL';
  return { status, checks };
}

const user = z.looseObject({ login: z.string(), type: z.string().optional() });
const pullSchema = z.looseObject({ number: z.number().int(), html_url: z.url(), state: z.string(), merged: z.boolean().optional(), merged_at: z.string().nullable().optional(),
  user, head: z.looseObject({ ref: z.string(), sha: z.string() }), base: z.looseObject({ ref: z.string() }) });
const reviewSchema = z.looseObject({ id: z.number(), user: user.nullable(), state: z.string(), commit_id: z.string().nullable() });
const checkRunSchema = z.looseObject({ id: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable() });
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
  async assertBaselinePublished(root, { remote, base, baselineSha }) {
    const fetched = await git(root, ['fetch', '--quiet', remote, `refs/heads/${base}`], true);
    const ancestor = fetched.ok && (await git(root, ['merge-base', '--is-ancestor', baselineSha, 'FETCH_HEAD'], true)).ok;
    if (!ancestor) throw new Error(`${remote}/${base} にrunのbaseline ${baselineSha.slice(0, 12)} が含まれていません。PRにHarnessが検証していないcommitが混ざるため作成しません`);
  },
  async remoteBranchSha(root, remote, branch) {
    const listed = await git(root, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
    return listed.stdout.trim().split(/\s+/)[0] || null;
  },
  async push(root, remote, sha, branch) { await git(root, ['push', '--quiet', remote, `${sha}:refs/heads/${branch}`]); },
  async findOpenPull({ owner, repo }, branch) {
    return z.array(pullSchema).parse(await api('GET', `repos/${owner}/${repo}/pulls?${new URLSearchParams({ head: `${owner}:${branch}`, state: 'open' })}`))[0] ?? null;
  },
  async createPull({ owner, repo }, body) { return pullSchema.parse(await api('POST', `repos/${owner}/${repo}/pulls`, body)); },
  async pull({ owner, repo }, number) { return pullSchema.parse(await api('GET', `repos/${owner}/${repo}/pulls/${number}`)); },
  reviews: ({ owner, repo }, number) => pages(`repos/${owner}/${repo}/pulls/${number}/reviews`, {}, value => z.array(reviewSchema).parse(value)),
  checkRuns: ({ owner, repo }, sha) => pages(`repos/${owner}/${repo}/commits/${sha}/check-runs`, {}, value => z.array(checkRunSchema).parse(value.check_runs)),
  // Rulesets are optional; without one (or without access) the configured check names still apply.
  async rulesetChecks({ owner, repo }, base) {
    let rules;
    try { rules = await pages(`repos/${owner}/${repo}/rules/branches/${encodeURIComponent(base)}`, {}, value => z.array(ruleSchema).parse(value)); }
    catch (error) { if (['403', '404'].includes(error.httpStatus)) return []; throw error; }
    return rules.filter(r => r.type === 'required_status_checks').flatMap(r => (r.parameters?.required_status_checks ?? []).map(c => c.context)).filter(Boolean);
  },
};

// The projection handed to the Merge Policy Judge. Raw API responses are never written to the run.
export async function githubState({ github = githubPrCli, repository, pullRequest, headSha, requiredChecks }) {
  const pull = await github.pull(repository, pullRequest.number);
  const required = [...new Set([...requiredChecks, ...await github.rulesetChecks(repository, pullRequest.base)])].sort();
  return {
    pullRequest: { number: pull.number, url: pull.html_url, headSha: pull.head.sha, state: pull.state, merged: pull.merged === true || Boolean(pull.merged_at),
      author: pull.user.login, testedShaMatches: pull.head.sha === headSha },
    ci: { requiredChecks: required, ...ciStatus({ checkRuns: await github.checkRuns(repository, pull.head.sha), required }) },
    reviews: reviewApprovals({ reviews: await github.reviews(repository, pull.number), headSha, author: pull.user.login }),
  };
}

export function pullRequestBody({ summary, sbi }) {
  const last = summary.iterations.at(-1);
  const checks = (last?.verification?.checks ?? []).map(c => `  - ${c.id}: ${c.status}`);
  return [
    `<!-- sonomama-harness run=${summary.id} sha=${summary.headSha} -->`,
    '## SBI', `- ${sbi.id}: ${sbi.title}`, `- Issue: ${sbi.issueUrl ?? '未設定'}`, '',
    '## 目的', sbi.description, '',
    '## 受け入れ要件', ...sbi.acceptanceCriteria.map(c => `- ${c.id}: ${c.description}`), '',
    '## Harness',
    `- Run ID: ${summary.id}`, `- tested SHA: ${summary.headSha}`,
    `- Verifier: ${last?.verification?.status ?? '-'}`, ...checks,
    `- Security: ${last?.security?.status ?? '-'}（Security Verifier: ${last?.securityVerification?.status ?? '-'}）`,
    `- Risk: LEVEL ${summary.risk?.level ?? '-'}（${(summary.risk?.reasons ?? []).join(', ') || '-'}）`,
    `- 必要なHuman Approval: ${summary.merge?.requiredApprovals ?? '-'}人（GitHub Review。PR作成者とbotは数えない）`,
    `- Evidence: \`${summary.runDir}/\`（Harnessを実行したPCにだけある。PRには添付しない）`, '',
    'tested SHAとPR HEADが一致し、必須CIがPASSし、必要人数のApproveがあり、有効なCHANGES_REQUESTEDがないときだけ、Harnessは`MERGE_ALLOWED`を出す。mergeは人間が行う。',
  ].join('\n');
}
