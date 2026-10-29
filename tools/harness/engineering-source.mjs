import { githubCli } from './planner-github.mjs';
import { git } from './workspace.mjs';

const issueUrlPattern = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)$/;
const labelNames = issue => (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name).filter(Boolean);

// The PR only points at the Issue. The approval is on the Issue: the engineering and ready labels, which need triage access on GitHub,
// so neither the PR body, a commit message nor the Issue body can grant it.
export async function engineeringIssueLinks(root, base) {
  const { stdout } = await git(root, ['log', '--format=%(trailers:only,unfold)%x00', `${base}..HEAD`]);
  return [...new Set(stdout.split('\0').flatMap(block => [...block.matchAll(/^Engineering-Issue:\s*(\S+)\s*$/gm)].map(m => m[1])))];
}

export function judgeEngineeringIssue({ issue, url, repository }) {
  const match = issueUrlPattern.exec(url);
  if (!match) return [`engineering source: ${url} is not a GitHub Issue URL`];
  const reasons = [];
  if (!repository) reasons.push(`engineering source: ${url} cannot be matched to this repository (GITHUB_REPOSITORY is not set)`);
  else if (`${match[1]}/${match[2]}` !== repository) reasons.push(`engineering source: ${url} is not in ${repository}`);
  if (!issue) return reasons;
  const labels = labelNames(issue);
  // GET /issues/N also answers for a pull request, which would let a PR approve itself.
  if (issue.pull_request) reasons.push(`engineering source: ${url} is a pull request, not an Issue`);
  if (issue.state !== 'open') reasons.push(`engineering source: ${url} is not open (${issue.state ?? 'unknown'})`);
  if (!labels.includes('engineering')) reasons.push(`engineering source: ${url} has no engineering label`);
  if (!labels.includes('ready')) reasons.push(`engineering source: ${url} has no ready label`);
  if (labels.includes('needs-review')) reasons.push(`engineering source: ${url} has needs-review`);
  if (labels.includes('sbi')) reasons.push(`engineering source: ${url} has sbi label and must use a Harness Run snapshot`);
  return reasons;
}

// Fail closed: no link, several links, another repository, an unreadable Issue or an Issue without the approval each fail.
export async function verifyEngineeringSource({ root, base, required, repository = process.env.GITHUB_REPOSITORY, github = githubCli }) {
  const source = { kind: 'engineering', required, sources: [], reasons: [] };
  if (!required.length) return { ...source, status: 'PASS' };
  let links;
  try { links = await engineeringIssueLinks(root, base); }
  catch (error) { return { ...source, status: 'FAIL', reasons: [`engineering source: cannot read the PR commits (${error.message})`] }; }
  if (links.length !== 1) {
    const found = links.length ? `found ${links.length}: ${links.join(', ')}` : 'none found';
    return { ...source, status: 'FAIL', reasons: [`production source missing: ${required.join(', ')} requires a Harness Run snapshot .harness/state/sbi-<Issue number>.json of a ready SBI Issue, or exactly one Engineering-Issue trailer of a ready engineering Issue (${found})`] };
  }
  const [url] = links, match = issueUrlPattern.exec(url);
  const outside = judgeEngineeringIssue({ issue: null, url, repository });
  if (outside.length) return { ...source, status: 'FAIL', reasons: outside };
  let issue;
  try { issue = await github.fetchIssue({ owner: match[1], repo: match[2], number: Number(match[3]) }); }
  catch (error) { return { ...source, status: 'FAIL', reasons: [`engineering source: ${url} could not be read (${error.message})`] }; }
  source.reasons.push(...judgeEngineeringIssue({ issue, url, repository }));
  if (!source.reasons.length) source.sources.push({ url });
  return { ...source, status: source.reasons.length ? 'FAIL' : 'PASS' };
}
