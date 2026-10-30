import { isBot, canMerge } from './github-pr.mjs';

// A human decision recorded on a GitHub Issue as a comment line: `<prefix>: <digest>` approves, `<prefix>-revoke: <digest>` withdraws.
// The comment may explain the decision around that line. GitHub authenticates the author. Only people with write access count, as for a
// GitHub Review; bots never count, an unreadable permission never grants, an edited comment is void (an admin can edit someone else's
// comment) and each person's latest decision for the digest wins. A deleted comment is simply gone.
// Shared by the spec approval of #147 (harness-spec, spec-approval.mjs) and the PBI plan approval (harness-pbi-plan, pbi-plan.mjs).
export const approvalLine = (prefix, digest, decision = 'approve') => `${prefix}${decision === 'revoke' ? '-revoke' : ''}: ${digest}`;
const linePattern = (prefix, digest, decision) => new RegExp(`^${approvalLine(prefix, digest, decision)}\\s*$`, 'm');

export function commentApprovals({ comments, prefix, digest, permissions }) {
  const latest = new Map();
  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    const login = comment.user?.login, text = comment.body ?? '';
    if (!login || isBot(comment.user) || comment.updated_at !== comment.created_at) continue;
    if (linePattern(prefix, digest, 'revoke').test(text)) latest.set(login, false);
    else if (linePattern(prefix, digest).test(text)) latest.set(login, true);
  }
  const approvers = [...latest].filter(([login, approved]) => approved && canMerge(permissions[login])).map(([login]) => login).sort();
  return { approved: approvers.length > 0, approvers };
}

// Reads the comments and the permission of each person who left a decision line through the GitHub adapter (githubCli.permission).
export async function readCommentApprovals({ ref, prefix, digest, github }) {
  const comments = await github.listComments(ref);
  const permissions = {};
  const decided = c => linePattern(prefix, digest).test(c.body ?? '') || linePattern(prefix, digest, 'revoke').test(c.body ?? '');
  for (const login of new Set(comments.filter(c => c.user && !isBot(c.user) && decided(c)).map(c => c.user.login))) {
    try { permissions[login] = await github.permission(ref, login); } catch { permissions[login] = 'unknown'; }
  }
  return commentApprovals({ comments, prefix, digest, permissions });
}
