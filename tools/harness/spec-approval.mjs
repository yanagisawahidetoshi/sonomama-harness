import { createHash } from 'node:crypto';
import { sections } from './sbi-issue.mjs';
import { parseIssueUrl, markerPattern } from './planner.mjs';
// #147, ADR-0009: a human confirms the specification of an SBI Issue by moving it from needs-review to spec-approved on GitHub (MVP: the label
// is the approval and who added it is not checked). The run takes the spec digest of the Issue as it is then, and the generated Trusted
// Acceptance stays bound to that digest (acceptance-generation.mjs). The digest covers what decides the tests and, since #194, everything the
// run gives the Agent or uses for Risk, Security, its scope and its start (the title, the Planner marker, 目的, 種類, 依存SBI, 想定変更ファイル数,
// 検証方法), so editing any of it voids the generated Trusted Acceptance; ticking a checkbox does not. ADR-0005 lists the same items (specDigestItems).
const specSections = ['目的', '種類', '受け入れ要件', 'Gherkin', '依存SBI', '想定変更範囲', '想定変更ファイル数', '検証方法', 'Risk / Security Impact'];
export const specDigestItems = ['title', 'Planner marker', ...specSections];

export function specDigest({ title, body }) {
  const parts = sections(body);
  if (!parts.has('Gherkin') || typeof title !== 'string') return null;
  const normalized = [`# ${title.trim()}`, markerPattern.exec(String(body ?? ''))?.[0] ?? '', ...specSections.map(name => {
    const lines = (parts.get(name) ?? []).map(l => l.replace(/\s+$/, '').replace(/^(\s*- )\[[xX]\]/, '$1[ ]'));
    while (lines.length && !lines[0]) lines.shift();
    while (lines.length && !lines.at(-1)) lines.pop();
    return `## ${name}\n${lines.join('\n')}`;
  })].join('\n\n');
  return createHash('sha256').update(normalized).digest('hex');
}

export const specApprovalLabel = 'spec-approved';
export const specApproval = issue => {
  const digest = specDigest(issue);
  return { approved: Boolean(digest) && (issue.labels ?? []).some(l => l.name === specApprovalLabel), digest };
};

// harness:spec-approve: the same label change a human makes on GitHub, for a human who prefers the terminal.
export async function postSpecApproval({ issueUrl, decision = 'approve', github }) {
  if (!['approve', 'revoke'].includes(decision)) throw new Error('spec-approve --decision must be approve or revoke');
  const ref = parseIssueUrl(issueUrl);
  const issue = await github.fetchIssue(ref);
  const digest = specDigest(issue);
  if (!digest) throw new Error(`${ref.url} に ## Gherkin が無いため spec digest を作れません。仕様を承認できません`);
  const names = (issue.labels ?? []).map(l => l.name);
  if (decision === 'approve') {
    await github.ensureLabels(ref, [specApprovalLabel]);
    if (!names.includes(specApprovalLabel)) await github.addLabels(ref, [specApprovalLabel]);
    if (names.includes('needs-review')) await github.removeLabel(ref, 'needs-review');
  } else if (names.includes(specApprovalLabel)) await github.removeLabel(ref, specApprovalLabel);
  return { digest };
}
