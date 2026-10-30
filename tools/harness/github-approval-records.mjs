import { isBot, canMerge } from './github-pr.mjs';

// A human decision recorded on a GitHub Issue as a comment that is exactly one line: `<prefix>: <digest>` approves, `<prefix>-revoke: <digest>` withdraws.
// GitHub authenticates the author. Only people with write access count, as for a GitHub Review; bots never count, an unreadable permission never
// grants, an edited comment is void, and each person's latest decision for the digest wins. A deleted comment simply disappears.
// Shared by the PBI plan approval (harness-pbi-plan) and the spec approval of #147 (harness-spec).
export const approvalLine = (prefix, digest, decision = 'approve') => `${prefix}${decision === 'revoke' ? '-revoke' : ''}: ${digest}`;

export function commentApprovals({ comments, prefix, digest, permissions }) {
  const latest = new Map();
  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    const login = comment.user?.login, text = String(comment.body ?? '').trim();
    if (!login || isBot(comment.user) || comment.updated_at !== comment.created_at) continue;
    if (text === approvalLine(prefix, digest)) latest.set(login, true);
    else if (text === approvalLine(prefix, digest, 'revoke')) latest.set(login, false);
  }
  const approvers = [...latest].filter(([login, approved]) => approved && canMerge(permissions[login])).map(([login]) => login).sort();
  return { approved: approvers.length > 0, approvers };
}

export async function readCommentApprovals({ ref, prefix, digest, github, githubPr }) {
  const comments = await github.listComments(ref);
  const permissions = {};
  const lines = [approvalLine(prefix, digest), approvalLine(prefix, digest, 'revoke')];
  for (const login of new Set(comments.filter(c => c.user && !isBot(c.user) && lines.includes(String(c.body ?? '').trim())).map(c => c.user.login))) {
    try { permissions[login] = await githubPr.permission(ref, login); } catch { permissions[login] = 'unknown'; }
  }
  return commentApprovals({ comments, prefix, digest, permissions });
}
