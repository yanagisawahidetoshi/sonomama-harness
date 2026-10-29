import { githubCli } from './planner-github.mjs';
import { git } from './workspace.mjs';

const issueUrlPattern = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)$/;
const engineeringTypePattern = /(?:^|\n)## 種類[ \t]*\r?\n[ \t]*engineering[ \t]*(?:\r?\n|$)/i;

const labelNames = issue => (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name).filter(Boolean);

export async function engineeringIssueLinks(root, base) {
  const { stdout } = await git(root, ['log', '--format=%(trailers:only,unfold)%x00', `${base}..HEAD`]);
  const urls = [];
  for (const block of stdout.split('\0')) {
    for (const match of block.matchAll(/^Engineering-Issue:\s*(\S+)\s*$/gm)) urls.push(match[1]);
  }
  return [...new Set(urls)];
}

export function judgeEngineeringIssue({ issue, url, repository }) {
  const reasons = [];
  const match = issueUrlPattern.exec(url);
  if (!match) return [`engineering source: ${url} is not a GitHub Issue URL`];
  const sourceRepository = `${match[1]}/${match[2]}`;
  if (!repository) reasons.push(`engineering source: ${url} cannot be matched to this repository (GITHUB_REPOSITORY is not set)`);
  else if (sourceRepository !== repository) reasons.push(`engineering source: ${url} is not in ${repository}`);
  if (!issue) return reasons;

  const labels = labelNames(issue);
  if (issue.state !== 'open') reasons.push(`engineering source: ${url} is not open (${issue.state ?? 'unknown'})`);
  if (!labels.includes('ready')) reasons.push(`engineering source: ${url} has no ready label`);
  if (labels.includes('needs-review')) reasons.push(`engineering source: ${url} has needs-review`);
  if (labels.includes('sbi')) reasons.push(`engineering source: ${url} has sbi label and must use a Harness Run snapshot`);
  if (!engineeringTypePattern.test(issue.body ?? '')) reasons.push(`engineering source: ${url} has no "## 種類 / engineering" marker`);
  return reasons;
}

export async function verifyEngineeringSource({ root, base, required, repository = process.env.GITHUB_REPOSITORY, github = githubCli }) {
  const source = { kind: 'engineering', required, sources: [], reasons: [] };
  if (!required.length) return { ...source, status: 'PASS' };

  let links;
  try { links = await engineeringIssueLinks(root, base); }
  catch (error) { return { ...source, status: 'FAIL', reasons: [`engineering source: cannot read the PR commits (${error.message})`] }; }

  if (links.length !== 1) {
    const detail = links.length ? `found ${links.length}: ${links.join(', ')}` : 'none found';
    source.reasons.push(`production source missing: ${required.join(', ')} requires either a ready SBI snapshot or exactly one Engineering-Issue trailer (${detail})`);
    return { ...source, status: 'FAIL' };
  }

  const url = links[0];
  const match = issueUrlPattern.exec(url);
  if (!match) return { ...source, status: 'FAIL', reasons: [`engineering source: ${url} is not a GitHub Issue URL`] };
  const sourceRepository = `${match[1]}/${match[2]}`;
  if (!repository || sourceRepository !== repository) {
    source.reasons.push(...judgeEngineeringIssue({ issue: null, url, repository }));
    return { ...source, status: 'FAIL' };
  }

  let issue;
  try { issue = await github.fetchIssue({ owner: match[1], repo: match[2], number: Number(match[3]) }); }
  catch (error) {
    source.reasons.push(`engineering source: ${url} could not be read (${error.message})`);
    return { ...source, status: 'FAIL' };
  }

  source.reasons.push(...judgeEngineeringIssue({ issue, url, repository }));
  if (!source.reasons.length) source.sources.push({ url });
  return { ...source, status: source.reasons.length ? 'FAIL' : 'PASS' };
}
