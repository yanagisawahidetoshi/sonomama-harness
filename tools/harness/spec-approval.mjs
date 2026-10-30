import { createHash } from 'node:crypto';
import { sections } from './sbi-issue.mjs';
import { parseIssueUrl } from './planner.mjs';
import { commentApprovals } from './github-approval-records.mjs';
// #147: a human confirms the specification of an SBI Issue (acceptance criteria, Gherkin, change scope, Risk / Security Impact)
// by posting `harness-spec: <spec digest>` on the Issue. This is the source of truth; the spec-approved label is only a projection.
// The digest covers what decides the tests, so editing any of it voids earlier approvals; ticking a checkbox does not.
const specSections = ['受け入れ要件', 'Gherkin', '想定変更範囲', 'Risk / Security Impact'];

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
// Latest wins per person; the rules are shared with the PBI plan approval (github-approval-records.mjs).
export const specApprovals = ({ comments, permissions, digest }) => digest ? commentApprovals({ comments, prefix: 'harness-spec', digest, permissions }) : { approved: false, approvers: [] };

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

// harness:spec-approve: the human posts with their own gh login, so GitHub authenticates who approved. The label only mirrors it.
export async function postSpecApproval({ issueUrl, decision = 'approve', github }) {
  if (!['approve', 'revoke'].includes(decision)) throw new Error('spec-approve --decision must be approve or revoke');
  const ref = parseIssueUrl(issueUrl);
  const issue = await github.fetchIssue(ref);
  const digest = specDigest(issue.body);
  if (!digest) throw new Error(`${ref.url} に ## Gherkin が無いため spec digest を作れません。仕様を承認できません`);
  // Only a comment that is exactly the line counts (github-approval-records.mjs), so nothing else is posted with it.
  const comment = await github.addComment(ref, decision === 'approve' ? specApprovalLine(digest) : `harness-spec-revoke: ${digest}`);
  const names = (issue.labels ?? []).map(l => l.name);
  try {
    if (decision === 'approve') { await github.ensureLabels(ref, ['spec-approved']); if (!names.includes('spec-approved')) await github.addLabels(ref, ['spec-approved']); }
    else if (names.includes('spec-approved')) await github.removeLabel(ref, 'spec-approved');
  } catch (error) { throw new Error(`承認は ${comment.html_url} に記録しました。spec-approved ラベルの反映に失敗しました: ${error.message}`); }
  return { digest, comment: comment.html_url };
}
