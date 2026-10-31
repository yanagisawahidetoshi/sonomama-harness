import assert from 'node:assert/strict';
// The body of a `## heading` section up to the next heading of the same or a higher level, so words elsewhere in the README do not count.
export const markdownSection = (markdown, heading) => {
  const lines = markdown.split('\n'), start = lines.findIndex(line => line.trim() === `## ${heading}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
};
// ADR-0007 decided Amazon Cognito; the README states it there and keeps provider specific code behind an approval.
export const assertAuthSection = readme => {
  const auth = markdownSection(readme, '認証');
  assert.ok(auth !== undefined, 'README has no 認証 section');
  assert.ok(auth.includes('Amazon Cognito'), '認証 section must name Amazon Cognito');
  assert.match(auth, /\]\([^)]*docs\/adr\/0007-aws-and-cognito\.md\)/, '認証 section must link ADR-0007');
  assert.ok(!auth.includes('未決定'), '認証 section must not call the provider undecided');
  assert.match(auth, /Provider固有[^\n]*承認なしに導入しない/, '認証 section must forbid provider specific code without approval');
};
