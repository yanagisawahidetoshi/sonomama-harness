import { createHash } from 'node:crypto';
import { sections } from './sbi-issue.mjs';
// #147: a human confirms the specification of an SBI Issue (acceptance criteria, Gherkin, change scope, Risk / Security Impact)
// by posting `harness-spec: <spec digest>` on the Issue. This is the source of truth; the spec-approved label is only a projection.
// The digest covers what decides the tests, so editing any of it voids earlier approvals; ticking a checkbox does not.
const specSections = ['受け入れ要件', 'Gherkin', '想定変更範囲', 'Risk / Security Impact'];
const canMerge = permission => ['admin', 'write'].includes(permission);
const isBot = user => user?.type === 'Bot' || /\[bot\]$/.test(user?.login ?? '');

export function specDigest(body) {
  const parts = sections(body);
  if (!parts.has('Gherkin')) return null;
  const normalized = specSections.map(name => {
    const lines = (parts.get(name) ?? []).map(l => l.replace(/\s+$/, '').replace(/^(\s*- )\[[xX]\]/, '$1[ ]'));
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines.at(-1)) lines.pop();
    return `## ${name}\n${lines.join('\n')}`;
  }).join('\n\n');
  return createHash('sha256').update(normalized).digest('hex');
}

export const specApprovalLine = digest => `harness-spec: ${digest}`;
const approveLine = digest => new RegExp(`^harness-spec: ${digest}\\s*$`, 'm');
const revokeLine = digest => new RegExp(`^harness-spec-revoke: ${digest}\\s*$`, 'm');

// Latest wins per person. An edited comment does not count (an admin can edit someone else's comment), a deleted one is simply gone.
export function specApprovals({ comments, permissions, digest }) {
  const state = new Map();
  if (!digest) return { approved: false, approvers: [] };
  for (const comment of [...comments].sort((a, b) => a.id - b.id)) {
    const login = comment.user?.login, text = comment.body ?? '';
    if (!login || isBot(comment.user) || comment.updated_at !== comment.created_at) continue;
    if (revokeLine(digest).test(text)) state.set(login, false);
    else if (approveLine(digest).test(text)) state.set(login, true);
  }
  const approvers = [...state].filter(([login, approved]) => approved && canMerge(permissions[login])).map(([login]) => login).sort();
  return { approved: approvers.length > 0, approvers };
}

// Reads the approval records of an Issue from GitHub; a permission that cannot be read never approves.
export async function readSpecApproval({ ref, issue, github }) {
  const digest = specDigest(issue.body);
  const comments = await github.listComments(ref);
  const permissions = {};
  for (const login of new Set(comments.map(c => c.user?.login).filter(Boolean))) {
    try { permissions[login] = await github.permission(ref, login); } catch { permissions[login] = 'unknown'; }
  }
  return { digest, ...specApprovals({ comments, permissions, digest }) };
}
