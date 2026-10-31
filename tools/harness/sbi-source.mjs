import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { githubCli } from './planner-github.mjs';
import { sbiFromIssue } from './sbi-issue.mjs';
import { readAcceptance } from './acceptance-registry.mjs';
import { readSpecApproval, specApprovalLine } from './spec-approval.mjs';
import { readReadyBinding } from './ready-approval.mjs';
import { sbiSchema, sbiSnapshotSchema } from './schemas.mjs';
import { git } from './workspace.mjs';
// A Production change is backed by a Harness Run that started from an approved SBI Issue. The Run commits what it took from the Issue
// as .harness/state/sbi-<Issue number>.json and links itself in the commit trailers; GitHub stays the source of the approval.
// CI rebuilds the SBI from the current Issue and requires the snapshot to equal it, so the guarantee is that the PR carries exactly
// the approved Issue at CI time. It is not a proof that the Harness wrote the snapshot.
const digestOf = text => createHash('sha256').update(text ?? '').digest('hex');
export const sbiFilePattern = /^\.harness\/state\/sbi-[^/]+\.json$/;
const sbiPattern = sbiFilePattern;
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

export async function runLinks(root, base, head = 'HEAD') {
  const { stdout } = await git(root, ['log', '--format=%(trailers:only,unfold)%x00', `${base}..${head}`]);
  const value = (block, key) => new RegExp(`^${key}: *(\\S+)$`, 'm').exec(block)?.[1];
  return stdout.split('\0').map(block => ({ runId: value(block, 'Harness-Run'), url: value(block, 'SBI-Issue') })).filter(link => link.runId && link.url);
}

// issue is null when it was not read because the snapshot points outside this repository.
// specApproval is given for generated Trusted Acceptance (#147): the tests are trusted because a writer approved the spec they were
// generated from, so the harness-spec approval of the current spec replaces ready, and ready alone is not enough.
export function judgeSbiSource({ snapshot, issue, repository, runs, specApproval }) {
  const { url } = snapshot.source, reasons = [];
  if (!repository) reasons.push(`sbi source: ${url} cannot be matched to this repository (GITHUB_REPOSITORY is not set)`);
  else if (snapshot.source.repo !== repository) reasons.push(`sbi source: ${url} is not in ${repository}`);
  if (issue) {
    const labels = issue.labels.map(l => l.name);
    if (issue.state !== 'open') reasons.push(`sbi source: ${url} is not open (${issue.state ?? 'unknown'})`);
    if (!labels.includes('sbi')) reasons.push(`sbi source: ${url} has no sbi label`);
    if (specApproval) {
      if (!specApproval.approved) reasons.push(`sbi source: ${url} has no spec approval of its current spec; the generated Trusted Acceptance needs \`${specApprovalLine(specApproval.digest ?? '<spec digest>')}\` from a writer`);
    } else if (!labels.includes('ready')) reasons.push(`sbi source: ${url} has no ready label`);
    if (labels.includes('needs-review')) reasons.push(`sbi source: ${url} has needs-review`);
  }
  if (!runs.some(r => r.runId === snapshot.runId && r.url === url)) reasons.push(`sbi source: ${url} is not linked to this PR; no commit carries Harness-Run: ${snapshot.runId} with SBI-Issue: ${url}`);
  return reasons;
}

// The snapshot must be what the Harness would build from the Issue as it is now: an edited Issue or a replaced snapshot both fail.
export function matchSbiSource({ snapshot, issue, config, generate = false }) {
  const { repo, number, url } = snapshot.source, [owner, name] = repo.split('/'), reasons = [];
  if (digestOf(issue.title) !== snapshot.titleDigest) reasons.push(`sbi source: ${url} titleDigest does not match the current Issue title`);
  if (digestOf(issue.body) !== snapshot.bodyDigest) reasons.push(`sbi source: ${url} bodyDigest does not match the current Issue body`);
  let rebuilt;
  try { rebuilt = sbiSchema.parse(sbiFromIssue({ ref: { owner, repo: name, number, url }, issue, config, generate })); }
  catch (error) { return [...reasons, `sbi source: ${url} cannot be rebuilt into an SBI (${error.message.replaceAll('\n', ' ')})`]; }
  const differs = [...new Set([...Object.keys(rebuilt), ...Object.keys(snapshot.sbi)])].filter(key => !isDeepStrictEqual(rebuilt[key], snapshot.sbi[key]));
  if (differs.length) reasons.push(`sbi source: ${url} snapshot SBI does not match the SBI rebuilt from the current Issue (${differs.sort().join(', ')})`);
  return reasons;
}

// Fail closed: a missing or invalid snapshot, an unreadable Issue, a snapshot that differs from the current Issue or a missing Run link
// each fail the Completion Judge. config is harness.json, whose Trusted Acceptance registrations fill the acceptance verifiers.
export async function verifySbiSource({ root, base, files, required, config, repository = process.env.GITHUB_REPOSITORY, github = githubCli }) {
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
    // A version 2 registration in the PR means the Run generated its Trusted Acceptance from an approved spec.
    let generated = false, specApproval;
    try { generated = (await readAcceptance(root, snapshot.source.number))?.version === 2; }
    catch (error) { source.reasons.push(`sbi source: ${error.message}`); }
    if (generated && issue) {
      try { specApproval = await readSpecApproval({ ref: { owner, repo, number: snapshot.source.number, url: snapshot.source.url }, issue, github }); }
      catch (error) { specApproval = { approved: false, digest: null }; source.reasons.push(`sbi source: the spec approval of ${snapshot.source.url} could not be read (${error.message})`); }
    }
    source.reasons.push(...judgeSbiSource({ snapshot, issue, repository, runs, specApproval }));
    // #194: the snapshot only shows the Issue did not change after the Run; ready must still cover what the Run took from it.
    if (issue && !generated) source.reasons.push(...(await readReadyBinding({ ref: { owner, repo, number: snapshot.source.number, url: snapshot.source.url }, issue, github })).map(r => `sbi source: ${r}`));
    if (issue) {
      source.reasons.push(...matchSbiSource({ snapshot, issue, config, generate: generated }));
      source.sources.push({ url: snapshot.source.url, runId: snapshot.runId, number: snapshot.source.number });
    }
  }
  return { ...source, status: source.reasons.length ? 'FAIL' : 'PASS' };
}

// The Run snapshot is stored under .harness/ by contract, and its JSON keys (requiredSecurityRules) read like security configuration.
// Only the Run's own snapshot, exactly as the Harness wrote it and verified against the ready SBI Issue, is read by its values instead:
// its location stops matching harness_policy and its key names stop matching patterns. Everything it says about the SBI still counts.
export const snapshotFilePattern = /^\.harness\/state\/sbi-\d+\.json$/;
const leaves = value => Array.isArray(value) ? value.flatMap(leaves) : value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [String(value)];
export function riskView(files, { snapshot, verified }) {
  if (!verified || !snapshot) return files;
  const path = snapshotPath(snapshot), expected = JSON.stringify(snapshot);
  const same = text => { try { return JSON.stringify(JSON.parse(text)) === expected; } catch { return false; } };
  return files.map(f => f.path === path && snapshotFilePattern.test(f.path) && f.status === 'A' && !f.deleted && same(f.added)
    ? { ...f, added: leaves(snapshot).join('\n'), verifiedSbiSnapshot: true } : f);
}
// Verified means: the committed file is the snapshot the Harness wrote, and the CI SBI source check passes for it against GitHub now
// with the Issue unedited since the Run started. Any other outcome, including a GitHub read failure, is unverified (fail closed).
// config is the harness.json the Run started with; its Trusted Acceptance registrations rebuild the SBI as at the start of the Run.
export async function snapshotVerified({ workspace, base, files, snapshot, config, github = githubCli }) {
  try {
    const text = await readFile(join(workspace, snapshotPath(snapshot)), 'utf8');
    if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(snapshot)) return { verified: false, reasons: ['snapshot differs from the one the Harness wrote'] };
    const source = await verifySbiSource({ root: workspace, base, files, required: ['sbi-snapshot'], config, repository: snapshot.source.repo, github });
    return { verified: source.status === 'PASS' && source.sources.length === 1, reasons: source.reasons };
  } catch (error) { return { verified: false, reasons: [error.message] }; }
}

export function describeSbiSource(source) {
  const exemption = source.exemption?.exempt ? [`SBI source: exempted for the dependency update by ${source.exemption.bot}`]
    : source.exemption ? [`SBI source exemption: not applied (${source.exemption.reasons.join('; ')})`] : [];
  if (!source.required.length) return exemption.length ? exemption : ['SBI source: not required'];
  if (exemption.length) return [...exemption, ...describeSbiSource({ ...source, exemption: undefined })];
  return [
    ...source.sources.map(s => `SBI source: ${s.url} run ${s.runId}`),
    `SBI source check: ${source.status}${source.reasons.length ? ` (${source.reasons.join('; ')})` : ''}`,
    // Shown only once the snapshot passed the check against GitHub, never from a trailer alone.
    ...source.status === 'PASS' ? source.sources.map(s => `Source: SBI #${s.number}`) : [],
  ];
}
