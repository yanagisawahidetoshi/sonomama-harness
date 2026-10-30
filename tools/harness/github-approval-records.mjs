import { isBot, canMerge } from './github-pr.mjs';

// A human decision recorded on a GitHub Issue as a comment whose whole body (trimmed) is one line: `<prefix>: <key>` approves,
// `<prefix>-revoke: <key>` withdraws. A line inside an explanation, a quote, an HTML comment or a code block is not a decision (#150, 2026-10-30).
// The CLIs post the line alone, so this costs the human nothing. GitHub authenticates the author. Only people with write access count, as for a
// GitHub Review; bots never count, an unreadable permission never grants, an edited comment is void (an admin can edit someone else's
// comment) and each person's latest decision for the digest wins. A deleted comment is simply gone.
// Shared by the spec approval of #147 (harness-spec, spec-approval.mjs) and the PBI plan approval (harness-pbi-plan, pbi-plan.mjs).
export const approvalLine = (prefix, digest, decision = 'approve') => `${prefix}${decision === 'revoke' ? '-revoke' : ''}: ${digest}`;
const is = (comment, prefix, digest, decision) => String(comment.body ?? '').trim() === approvalLine(prefix, digest, decision);

export function commentApprovals({ comments, prefix, digest, permissions }) {
  const latest = new Map();
  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    const login = comment.user?.login;
    // Without both timestamps an edit cannot be told apart, so such a comment never counts.
    if (!login || isBot(comment.user) || !comment.created_at || !comment.updated_at || comment.updated_at !== comment.created_at) continue;
    if (is(comment, prefix, digest, 'revoke')) latest.set(login, false);
    else if (is(comment, prefix, digest)) latest.set(login, true);
  }
  const approvers = [...latest].filter(([login, approved]) => approved && canMerge(permissions[login])).map(([login]) => login).sort();
  return { approved: approvers.length > 0, approvers };
}

// Reads the comments and the permission of each person who left a decision line through the GitHub adapter (githubCli.permission).
export async function readCommentApprovals({ ref, prefix, digest, github }) {
  const comments = await github.listComments(ref);
  const permissions = {};
  const decided = c => is(c, prefix, digest) || is(c, prefix, digest, 'revoke');
  for (const login of new Set(comments.filter(c => c.user && !isBot(c.user) && decided(c)).map(c => c.user.login))) {
    try { permissions[login] = await github.permission(ref, login); } catch { permissions[login] = 'unknown'; }
  }
  return commentApprovals({ comments, prefix, digest, permissions });
}
