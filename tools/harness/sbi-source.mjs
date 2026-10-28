import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { githubCli } from './planner-github.mjs';
import { sbiSchema, sbiSnapshotSchema } from './schemas.mjs';
import { git } from './workspace.mjs';
// A Production change is backed by a Harness Run that started from an approved SBI Issue. The Run commits what it took from the Issue
// as .harness/state/sbi-<Issue number>.json and links itself in the commit trailers; GitHub stays the source of the approval.
const digestOf = text => createHash('sha256').update(text ?? '').digest('hex');
const sbiPattern = /^\.harness\/state\/sbi-[^/]+\.json$/;
const snapshotPattern = /^\.harness\/state\/sbi-([1-9]\d*)\.json$/;
export const snapshotPath = snapshot => `.harness/state/sbi-${snapshot.source.number}.json`;

export function snapshotFromIssue({ ref, issue, runId, sbi }) {
  return sbiSnapshotSchema.parse({
    version: 1, source: { repo: `${ref.owner}/${ref.repo}`, number: ref.number, url: ref.url },
    runId, titleDigest: digestOf(issue.title), bodyDigest: digestOf(issue.body), sbi: { ...sbi, issueUrl: ref.url },
  });
}

// Hand-written SBI JSON keeps its old meaning for Impact Analysis; a snapshot that breaks its schema is reported, not thrown,
// so the impact and matrix jobs still run and the Completion Judge names the file.
export async function readSbiFiles(root, files) {
  const result = { sbis: [], snapshots: [], invalid: [], legacy: [] };
  for (const path of files.map(f => f.path).filter(path => sbiPattern.test(path))) {
    let text;
    try { text = await readFile(join(root, path), 'utf8'); } catch { continue; }
    const number = snapshotPattern.exec(path)?.[1];
    if (!number) { result.sbis.push(sbiSchema.parse(JSON.parse(text))); result.legacy.push(path); continue; }
    let parsed;
    try { parsed = sbiSnapshotSchema.safeParse(JSON.parse(text)); } catch (error) { result.invalid.push({ path, error: error.message }); continue; }
    if (!parsed.success) result.invalid.push({ path, error: parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join(', ') });
    else if (parsed.data.source.number !== Number(number)) result.invalid.push({ path, error: `source Issue is #${parsed.data.source.number}` });
    else { result.sbis.push(parsed.data.sbi); result.snapshots.push({ path, snapshot: parsed.data }); }
  }
  return result;
}

export async function runLinks(root, base) {
  const { stdout } = await git(root, ['log', '--format=%(trailers:only,unfold)%x00', `${base}..HEAD`]);
  const value = (block, key) => new RegExp(`^${key}: *(\\S+)$`, 'm').exec(block)?.[1];
  return stdout.split('\0').map(block => ({ runId: value(block, 'Harness-Run'), url: value(block, 'SBI-Issue') })).filter(link => link.runId && link.url);
}

// issue is null when it was not read because the snapshot points outside this repository.
export function judgeSbiSource({ snapshot, issue, repository, runs }) {
  const { url } = snapshot.source, reasons = [];
  if (!repository) reasons.push(`sbi source: ${url} cannot be matched to this repository (GITHUB_REPOSITORY is not set)`);
  else if (snapshot.source.repo !== repository) reasons.push(`sbi source: ${url} is not in ${repository}`);
  if (issue) {
    const labels = issue.labels.map(l => l.name);
    if (issue.state !== 'open') reasons.push(`sbi source: ${url} is not open (${issue.state ?? 'unknown'})`);
    if (!labels.includes('sbi')) reasons.push(`sbi source: ${url} has no sbi label`);
    if (!labels.includes('ready')) reasons.push(`sbi source: ${url} has no ready label`);
    if (labels.includes('needs-review')) reasons.push(`sbi source: ${url} has needs-review`);
  }
  if (!runs.some(r => r.runId === snapshot.runId && r.url === url)) reasons.push(`sbi source: ${url} is not linked to this PR; no commit carries Harness-Run: ${snapshot.runId} with SBI-Issue: ${url}`);
  return reasons;
}

// Fail closed: a missing or invalid snapshot, an unreadable Issue or a missing Run link each fail the Completion Judge.
export async function verifySbiSource({ root, base, files, required, repository = process.env.GITHUB_REPOSITORY, github = githubCli }) {
  const source = { required, sources: [], reasons: [] };
  if (!required.length) return { ...source, status: 'PASS' };
  const { snapshots, invalid, legacy } = await readSbiFiles(root, files);
  source.reasons.push(...invalid.map(i => `sbi source invalid: ${i.path}: ${i.error}`));
  if (!snapshots.length && !invalid.length) {
    const ignored = legacy.length ? `; ${legacy.join(', ')} has no source SBI Issue and does not count` : '';
    source.reasons.push(`sbi source missing: ${required.join(', ')} requires a Harness Run snapshot .harness/state/sbi-<Issue number>.json of a ready SBI Issue${ignored}`);
  }
  let runs = [];
  if (snapshots.length) {
    try { runs = await runLinks(root, base); } catch (error) { source.reasons.push(`sbi source: cannot read the PR commits (${error.message})`); }
  }
  for (const { snapshot } of snapshots) {
    const [owner, repo] = snapshot.source.repo.split('/');
    let issue = null;
    if (snapshot.source.repo === repository) {
      try { issue = await github.fetchIssue({ owner, repo, number: snapshot.source.number }); }
      catch (error) { source.reasons.push(`sbi source: ${snapshot.source.url} could not be read (${error.message})`); continue; }
    }
    source.reasons.push(...judgeSbiSource({ snapshot, issue, repository, runs }));
    if (issue) source.sources.push({ url: snapshot.source.url, runId: snapshot.runId, edited: digestOf(issue.title) !== snapshot.titleDigest || digestOf(issue.body) !== snapshot.bodyDigest });
  }
  return { ...source, status: source.reasons.length ? 'FAIL' : 'PASS' };
}

export function describeSbiSource(source) {
  if (!source.required.length) return ['SBI source: not required'];
  return [
    ...source.sources.map(s => `SBI source: ${s.url} run ${s.runId}${s.edited ? ' (Issue edited after the Run snapshot; the Run keeps its snapshot)' : ''}`),
    `SBI source check: ${source.status}${source.reasons.length ? ` (${source.reasons.join('; ')})` : ''}`,
  ];
}
