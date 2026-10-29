import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './workspace.mjs';
import { canMerge, githubPrCli, isBot } from './github-pr.mjs';
import { exceptionDigest, exceptionPath, exceptionPattern, parseException } from './migration-exception.mjs';
// The human half of a destructive migration exception: two people with write access post the text migration-exception.mjs renders
// as a COMMENTED review on the tested commit. GitHub authenticates them. An APPROVED review is the merge approval (ADR-0001), so it never
// counts here, and one review never serves both purposes.
const requiredApprovals = 2;
const approveLine = digest => new RegExp(`^harness-migration-exception: ${digest}\\s*$`, 'm');
const revokeLine = digest => new RegExp(`^harness-migration-exception-revoke: ${digest}\\s*$`, 'm');

// Latest wins per person: a later revoke line withdraws the approval. Only COMMENTED reviews carry this purpose, so a dismissed or merge review never counts.
export function exceptionApprovals({ reviews, headSha, author, permissions, digest }) {
  const state = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const login = review.user?.login, body = review.body ?? '';
    if (!login || isBot(review.user) || login === author || review.state !== 'COMMENTED') continue;
    if (revokeLine(digest).test(body)) state.set(login, false);
    else if (review.commit_id === headSha && approveLine(digest).test(body)) state.set(login, true);
  }
  const approvers = [...state].filter(([login, approved]) => approved && canMerge(permissions[login])).map(([login]) => login).sort();
  return { approved: approvers.length >= requiredApprovals, approvers, required: requiredApprovals };
}

async function readRequest(root, path) {
  const { request, errors } = parseException(path, await readFile(join(root, path), 'utf8').catch(() => ''));
  if (!request) return { errors };
  const source = await readFile(join(root, request.migration), 'utf8').catch(() => null);
  if (source === null) return { errors: [`${path}: migration ${request.migration} がありません`] };
  return { request, digest: exceptionDigest({ migration: request.migration, source, request }), errors: [] };
}

// CI Completion Judge: every exception request this PR adds or touches (or whose migration it touches) needs two approvals on headSha.
export async function verifyMigrationExceptions({ root, base, files, headSha, repository, pullNumber, githubPr = githubPrCli }) {
  const paths = files ? files.map(f => f.path) : (await git(root, ['diff', '--name-only', `${base}...HEAD`])).stdout.split('\n').filter(Boolean);
  const requests = new Set(paths.filter(p => exceptionPattern.test(p)));
  for (const path of paths.filter(p => /^apps\/api\/db\/migrate\/\d+_[a-z0-9_]+\.rb$/.test(p))) {
    if ((await git(root, ['ls-files', '--error-unmatch', exceptionPath(path)], true)).ok) requests.add(exceptionPath(path));
  }
  const result = { status: 'PASS', exceptions: [], reasons: [] };
  if (!requests.size) return result;
  const fail = reason => ({ ...result, status: 'FAIL', reasons: [...result.reasons, `migration exception: ${reason}`] });
  if (!/^[1-9]\d*$/.test(String(pullNumber ?? ''))) return fail('no pull request number to read the approvals');
  if (!repository) return fail('GITHUB_REPOSITORY is not set');
  const [owner, repo] = repository.split('/'), ref = { owner, repo };
  let pull, reviews;
  const permissions = {};
  try {
    pull = await githubPr.pull(ref, Number(pullNumber));
    reviews = await githubPr.reviews(ref, Number(pullNumber));
    // An unreadable permission never grants an approval.
    for (const login of new Set(reviews.map(r => r.user?.login).filter(Boolean))) {
      try { permissions[login] = await githubPr.permission(ref, login); } catch { permissions[login] = 'unknown'; }
    }
  } catch (error) { return fail(`approvals could not be read (${error.message})`); }
  if (pull.head?.sha !== headSha) return fail(`judged ${headSha} but the pull request head is ${pull.head?.sha ?? 'unknown'}`);
  for (const path of [...requests].sort()) {
    const { request, digest, errors } = await readRequest(root, path);
    if (!request) { result.reasons.push(...errors.map(e => `migration exception: ${e}`)); continue; }
    const approval = exceptionApprovals({ reviews, headSha, author: pull.user?.login, permissions, digest });
    result.exceptions.push({ migration: request.migration, request: path, digest, approvers: approval.approvers });
    if (!approval.approved) result.reasons.push(`migration exception: ${request.migration} has ${approval.approvers.length}/${approval.required} approvals for ${digest.slice(0, 12)} on ${headSha.slice(0, 12)}`);
  }
  return { ...result, status: result.reasons.length ? 'FAIL' : 'PASS' };
}
