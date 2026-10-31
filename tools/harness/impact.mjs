import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeEnvTemplate } from './evidence-protection.mjs';
import { classifyChangeType, describeChangeType, needsContent } from './change-type.mjs';
import { readJson } from './io.mjs';
import { readSbiFiles, snapshotFilePattern, verifySbiSource } from './sbi-source.mjs';
import { judgeChangedFileCount } from './planner-judge.mjs';
import { dependencyBotExemption } from './dependency-bot.mjs';
import { githubCli } from './planner-github.mjs';
import { verifyMigrationExceptions } from './migration-exception-approval.mjs';
import { judgeMaestro, maestroLanes, readMaestroResults } from './maestro.mjs';
import { configSchema, dependencyBotPolicySchema, securityPolicySchema } from './schemas.mjs';
import { classifySecurity, combineSecurity, securityPassed, securityTargets, verifySecurity } from './security-enforcement.mjs';
import { checksPassed, verify } from './verifier.mjs';
import { readAcceptance, withAcceptance } from './acceptance-registry.mjs';
import { isGeneratedRegistrationPath } from './acceptance-generation.mjs';
import { judgeAcceptance, readAcceptanceResult, runGeneratedAcceptance, writeAcceptanceResult } from './acceptance-run.mjs';
import { specDigest } from './spec-approval.mjs';
import { changedFiles as diffFiles, git } from './workspace.mjs';
// SBI Impact Analysis for CI scheduling. harness.json stays the single definition of verifiers; this only decides which of them a change needs.
const sorted = values => [...new Set(values)].sort();
const applicationVerifiers = config => config.verifiers.filter(v => (v.trust || 'application') === 'application');
const generatedId = /^generated-acceptance-sbi-([1-9]\d*)$/;
// The verifier matrix leaves the generated acceptance reports here; the workflow uploads and downloads this directory.
export const acceptanceResultsDirectory = '.acceptance-ci/results';
const firstMatch = (patterns = [], files) => files.find(f => patterns.some(p => new RegExp(p).test(f.path)))?.path;

export function analyzeImpact({ config, sbis = [], runSbis = [], files = [], all = false }) {
  const verifiers = new Map();
  const select = (id, reason, mandatory) => {
    const entry = verifiers.get(id) ?? { id, mandatory: false, reasons: [] };
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    entry.mandatory ||= mandatory;
    verifiers.set(id, entry);
  };
  const apps = applicationVerifiers(config);
  const areasOf = id => apps.find(v => v.id === id)?.areas ?? [];
  const sbiAreas = new Set(sbis.flatMap(s => s.affectedAreas ?? []));
  for (const s of sbis) {
    for (const id of s.requiredVerifiers ?? []) select(id, `sbi:${s.id} requiredVerifiers`, true);
    for (const area of s.affectedAreas ?? []) for (const v of apps.filter(v => v.areas?.includes(area))) select(v.id, `sbi:${s.id} affectedAreas:${area}`, true);
    // Generated Trusted Acceptance runs PR code (#147), so its specs run in the verifier matrix and the Completion Judge only reads the report.
    for (const id of new Set(s.acceptanceCriteria.map(a => a.verifier).filter(id => generatedId.test(id)))) select(id, `sbi:${s.id} generated acceptance`, true);
  }
  const fromSbi = new Set(verifiers.keys());
  for (const v of apps) {
    const path = firstMatch(v.appliesTo, files);
    if (!path) continue;
    select(v.id, `diff:${path}`, false);
    if (sbis.length && !fromSbi.has(v.id)) select(v.id, 'diff-not-in-sbi', false);
  }
  if (all) for (const v of apps) select(v.id, 'all', false);
  // A gated command (expo-doctor) is named with the path that makes it run, so the log shows why it ran or why it did not.
  for (const v of apps) for (const gate of v.gatedCommands ?? []) {
    const path = firstMatch(gate.appliesTo, files);
    if (path) select(v.id, `gate:${gate.command.join(' ')}:${path}`, false);
  }
  // A shared runtime or package manager change can break any app, so it selects every application verifier and the Full Gate.
  const toolchainPath = firstMatch(config.impact?.toolchain, files);
  if (toolchainPath) for (const v of apps) select(v.id, `toolchain:${toolchainPath}`, false);
  // Areas come from the SBI and from what the diff touched, so a diff the SBI did not mention still brings its cross-layer contract.
  const areas = new Set([...sbiAreas, ...[...verifiers.keys()].flatMap(areasOf)]);
  for (const rule of config.impact?.crossLayer ?? []) {
    const hit = rule.any.filter(area => areas.has(area));
    if (rule.all.every(area => areas.has(area)) && hit.length) {
      for (const id of rule.add) select(id, `cross-layer:${[...rule.all, ...hit].join('+')}`, false);
    }
  }
  const fullGatePath = firstMatch(config.impact?.fullGate, files);
  const fullGateReasons = all ? ['all'] : [...fullGatePath ? [`diff:${fullGatePath}`] : [], ...toolchainPath ? [`toolchain:${toolchainPath}`] : []];
  // ADR-0006: a Production diff needs an SBI unless every Production file is proven engineering. Prototypes, docs and Harness maintenance
  // stay outside lanes.json productionPaths and get no change type.
  const { changeType, requiresSbi, engineering, ambiguous } = classifyChangeType(files);
  const sbiRequiredReasons = ambiguous.slice(0, 1).map(a => `production:${a.path}`);
  const selected = [...verifiers.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    sbis: sbis.map(s => s.id),
    affectedAreas: sorted(areas),
    requiredVerifiers: selected.map(v => v.id),
    verifiers: selected,
    acceptanceVerifiers: sorted(sbis.flatMap(s => s.acceptanceCriteria.map(a => a.verifier))),
    fullGate: fullGateReasons.length > 0,
    fullGateReasons,
    // Maestro runs only for mobile SBIs that ask for E2E (#68), never for every mobile PR. Only a Run snapshot (from an approved SBI Issue)
    // picks a lane; hand-written SBI JSON has no provenance and must not add a required job.
    maestro: maestroLanes(runSbis),
    changeType,
    requiresSbi,
    changeTypeFiles: { engineering, ambiguous },
    sbiRequired: requiresSbi,
    sbiRequiredReasons,
  };
}

// Required jobs must succeed; a job may be skipped only when the impact did not ask for it. Security that was not evaluated fails.
export function judgeCi({ impact, needs, acceptance, security, source, granularity, migrationExceptions, maestro }) {
  const reasons = [];
  const expect = (job, wanted) => {
    const result = needs[job]?.result ?? 'missing';
    if (wanted ? result !== 'success' : !['success', 'skipped'].includes(result)) reasons.push(`${job}: ${result}`);
  };
  expect('impact', true);
  // A changed SBI snapshot is verified even when the diff needs no SBI, so its FAIL counts too.
  if ((impact.sbiRequired && source?.status !== 'PASS') || source?.status === 'FAIL') reasons.push(...(source?.reasons.length ? source.reasons : ['sbi source: not evaluated']));
  reasons.push(...(granularity ?? []).filter(g => g.status === 'FAIL').map(g => g.reason));
  if (migrationExceptions?.status === 'FAIL') reasons.push(...migrationExceptions.reasons);
  expect('verifiers', impact.requiredVerifiers.length > 0);
  expect('harness-test', impact.fullGate);
  expect('harness-demo', impact.fullGate);
  // The maestro job and its result files; judgeMaestro adds nothing when no lane is required.
  const lanes = impact.maestro ?? [];
  reasons.push(...judgeMaestro({ lanes, needs, results: maestro?.results, headSha: maestro?.headSha ?? '' }));
  // Any other job the workflow ran (maestro without a lane, a job this Judge does not know yet) may succeed or be skipped, never fail (#163).
  const judged = new Set(['impact', 'verifiers', 'harness-test', 'harness-demo', ...lanes.length ? ['maestro'] : []]);
  for (const [job, value] of Object.entries(needs)) if (!judged.has(job) && !['success', 'skipped'].includes(value?.result)) reasons.push(`${job}: ${value?.result ?? 'missing'}`);
  if (acceptance.status !== 'PASS') reasons.push(...(acceptance.missing.length ? [`acceptance missing: ${acceptance.missing.join(', ')}`] : ['acceptance: FAIL']));
  if (!security) reasons.push('security: not evaluated');
  else if (!securityPassed(security)) {
    const failed = security.requiredVerifiers.map(id => [id, security.checks.find(c => c.id === id)?.status ?? 'missing']).filter(([, status]) => status !== 'PASS');
    reasons.push(...(failed.length ? failed.map(([id, status]) => `security: ${id} ${status}`) : ['security: FAIL']));
  }
  return { status: reasons.length ? 'FAIL' : 'PASS', reasons };
}

// The Judge, the impact job and the maestro results must all be about the head the workflow checked out; anything unknown fails closed.
export function judgeTestedCommit({ headSha, expectedHeadSha, needs }) {
  const short = sha => String(sha ?? 'missing').slice(0, 12);
  if (!expectedHeadSha) return ['head sha: not provided'];
  const reasons = [];
  if (headSha !== expectedHeadSha) reasons.push(`head sha: checkout ${short(headSha)} is not the head ${short(expectedHeadSha)}`);
  const analyzed = needs.impact?.outputs?.head_sha;
  if (analyzed !== expectedHeadSha) reasons.push(`impact: analyzed ${short(analyzed)}, not ${short(expectedHeadSha)}`);
  return reasons;
}

// The diff is taken from the base ref; when the event names its base commit, the ref must be that commit or newer on the same history, so a
// wrong or stale base fails (#184). Main moving on between the event and the checkout is not a failure.
async function judgeBase({ root, base, expectedBaseSha }) {
  const resolved = (await git(root, ['rev-parse', '--verify', `${base}^{commit}`], true)).stdout.trim();
  if (resolved && (await git(root, ['merge-base', '--is-ancestor', expectedBaseSha, resolved], true)).ok) return [];
  return [`base sha: ${base} is ${resolved.slice(0, 12) || 'missing'}, which does not contain ${expectedBaseSha.slice(0, 12)}`];
}

// The same diff the Harness run classifies (with added and deleted lines), taken from the merge base like base...HEAD.
// Files a content rule of the change type judges also carry both sides; a side that does not exist stays undefined.
export async function changedFiles(root, base) {
  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).stdout.trim();
  const show = async (rev, path) => { try { return (await git(root, ['show', `${rev}:${path}`])).stdout; } catch { return undefined; } };
  const files = await diffFiles(root, mergeBase, 'HEAD');
  for (const f of files.filter(f => needsContent(f.path))) Object.assign(f, { before: await show(mergeBase, f.path), after: await show('HEAD', f.path) });
  return files;
}

// Changed hand-written SBI JSON and the SBI inside Harness Run snapshots both drive Impact Analysis and Trusted Acceptance.
export async function changedSbis(root, files) {
  return (await readSbiFiles(root, files)).sbis;
}

// The config and rules come from root; the diff and the SBI JSON from workspace. They are one tree except in the trusted Judge (ADR-0008),
// where root is main and workspace the PR head read as data.
export async function loadImpact({ root, workspace = root, base, all = false }) {
  const files = all ? [] : await changedFiles(workspace, base);
  const { sbis, snapshots } = await readSbiFiles(workspace, files);
  // Each Run snapshot brings the Trusted Acceptance of its own SBI Issue only (.harness/acceptance/sbi-<N>.json).
  const config = await withAcceptance(root, configSchema.parse(await readJson(join(root, '.harness/config/harness.json'))), snapshots.map(s => s.snapshot.source.number), workspace);
  return { config, files, sbis, snapshots, impact: analyzeImpact({ config, sbis, runSbis: snapshots.map(s => s.snapshot.sbi), files, all }) };
}

// The matrix job: one verifier, mandatory only when an SBI asked for it, so a cross-layer contract without a document stays a placeholder SKIP.
export async function runVerifier({ root, base, all = false, id, acceptanceResults = join(root, acceptanceResultsDirectory), acceptanceRunner = runGeneratedAcceptance }) {
  const { config, files, impact } = await loadImpact({ root, base, all });
  const entry = impact.verifiers.find(v => v.id === id);
  const mandatory = entry?.mandatory ?? false;
  // The leg passes when the specs pass; the Completion Judge decides acceptance from the report against the current SBI Issue.
  const generated = generatedId.exec(id);
  if (generated) {
    const sbiIssue = Number(generated[1]), headSha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const registration = await readAcceptance(root, sbiIssue).catch(() => null);
    if (registration?.version !== 2) return { impact, result: { checks: [{ id, required: true, selectionReasons: [mandatory ? 'impact-required' : 'requested', 'generated-acceptance'], status: 'FAIL', reason: `generated registration of SBI #${sbiIssue} is missing` }] }, passed: false };
    const report = await acceptanceRunner({ workspace: root, sbiIssue, config });
    await writeAcceptanceResult({ dir: acceptanceResults, sbiIssue, headSha, report });
    const judged = judgeAcceptance({ registration, report });
    const checks = [{ id, required: true, trust: 'acceptance', selectionReasons: [mandatory ? 'impact-required' : 'requested', 'generated-acceptance'], status: judged.status, ...(judged.reasons.length ? { reason: judged.reasons.join('; ') } : {}) }];
    return { impact, result: { checks }, passed: judged.status === 'PASS' };
  }
  // A Security Verifier connected in harness.json runs the same way as in the Harness run; without commands it stays NOT_CONFIGURED and fails.
  if (config.securityVerifiers.some(v => v.id === id)) {
    const policy = securityPolicySchema.parse(await readJson(join(root, '.harness/rules/security.json')));
    const headSha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const security = await verifySecurity({ workspace: root, sbi: { allowedFiles: [] }, assessment: { requiredVerifiers: [id] }, policy, config, headSha });
    const checks = security.checks.filter(c => c.id === id).map(c => ({ ...c, selectionReasons: [mandatory ? 'impact-required' : 'requested', 'security'] }));
    return { impact, result: { checks }, passed: checksPassed(checks) };
  }
  const sbi = { title: 'CI matrix', description: id, risks: [], securityImpact: [], acceptanceCriteria: [], requiredVerifiers: [] };
  const result = await verify({ root, workspace: root, config, sbi, files, only: new Set([id]), selected: new Map([[id, mandatory]]) });
  return { impact, result, passed: checksPassed(result.checks) };
}

// Security scans the added lines of the changed files; a vetted .env template is not a secret path, as in prepareWorkspace.
// A changed file that is not deleted but cannot be read is missing, which fails instead of being dropped (#184).
async function changedContent(root, files) {
  const content = [];
  for (const t of securityTargets(files)) {
    if (t.target === 'deleted') { content.push(t); continue; }
    let text = '', missing = false;
    try { text = await readFile(join(root, t.path), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; missing = true; }
    content.push({ ...t, text: t.added ?? '', envTemplate: isSafeEnvTemplate(t.path, text), ...(missing && { missing }) });
  }
  return content;
}

// A push to main (--all) has no diff, so every file tracked at HEAD is read whole from Git (#184); untracked and ignored files are not.
// A submodule or a file with a NUL byte has no text to read and is uninspectable.
async function trackedContent(root) {
  const tree = (await git(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])).stdout.split('\0').filter(Boolean);
  const files = [];
  for (const entry of tree) {
    const [meta, path] = [entry.slice(0, entry.indexOf('\t')), entry.slice(entry.indexOf('\t') + 1)];
    const [, type, object] = meta.split(' ');
    const text = type === 'blob' ? (await git(root, ['cat-file', 'blob', object])).stdout : '';
    files.push({ path, status: 'A', added: text, deleted: '', binary: type !== 'blob' || text.includes('\0') });
  }
  return securityTargets(files).map(t => ({ ...t, text: t.added, envTemplate: isSafeEnvTemplate(t.path, t.added) }));
}

// Completion Judge: trusted acceptance of every changed SBI and the Harness Security Policy run here. An ambiguous Production diff must be backed
// by a ready SBI Run snapshot; an engineering diff needs none (ADR-0006).
// expectedHeadSha is the head the workflow checked out; the CLI always passes it, so a missing value fails there.
// expectedBaseSha is the base commit of the pull request event; it is checked when the workflow passes it (HARNESS_BASE_SHA).
export async function runCompletionJudge({ root, workspace = root, base, all = false, needs, repository = process.env.GITHUB_REPOSITORY, pullNumber, github = githubCli, githubPr, maestroResults, expectedHeadSha, expectedBaseSha, acceptanceResults = join(root, acceptanceResultsDirectory) }) {
  const { config, files, sbis, snapshots, impact } = await loadImpact({ root, workspace, base, all });
  const headSha = (await git(workspace, ['rev-parse', 'HEAD'])).stdout.trim();
  // The Issue is read once for the generated acceptance and the SBI source check, so both judge the same Issue.
  const issues = new Map();
  const issueGithub = { ...github, fetchIssue: ref => {
    const key = `${ref.owner}/${ref.repo}#${ref.number}`;
    if (!issues.has(key)) issues.set(key, github.fetchIssue(ref));
    return issues.get(key);
  } };
  const missing = [], checks = [];
  for (const sbi of sbis) {
    // Generated Trusted Acceptance (#147) is checked against the current SBI Issue and judged from the report the verifier matrix left.
    const snapshot = snapshots.find(s => s.snapshot.sbi === sbi)?.snapshot;
    let generatedSpecDigest = null, generatedSpecError = null;
    if (snapshot && sbi.acceptanceCriteria.some(a => generatedId.test(a.verifier))) {
      const [owner, repo] = snapshot.source.repo.split('/');
      try { generatedSpecDigest = specDigest(await issueGithub.fetchIssue({ owner, repo, number: snapshot.source.number })); }
      catch (error) { generatedSpecError = `SBI Issue ${snapshot.source.url} could not be read, so the spec digest cannot be checked (${error.message})`; }
    }
    const result = await verify({ root, workspace, config, sbi, files, only: new Set(sbi.acceptanceCriteria.map(a => a.verifier)), generatedSpecDigest, generatedSpecError,
      acceptanceRunner: ({ sbiIssue }) => readAcceptanceResult({ dir: acceptanceResults, sbiIssue, headSha }) });
    checks.push(...result.checks);
    missing.push(...sbi.acceptanceCriteria.filter(a => !result.acceptance.includes(a.id)).map(a => a.id));
  }
  const acceptance = { status: !sbis.length || (checksPassed(checks) && !missing.length) ? 'PASS' : 'FAIL', missing };
  const policy = securityPolicySchema.parse(await readJson(join(root, '.harness/rules/security.json')));
  // A changed legacy SBI is a document being edited, not the SBI this PR implements; its declarations still count (#217).
  const assessment = combineSecurity(classifySecurity({ files }, policy), ...sbis.map(sbi => classifySecurity({ files, sbi, legacySbi: !snapshots.some(s => s.snapshot.sbi === sbi) }, policy)));
  // Application verifiers an SBI requires ran in the matrix job, which succeeds only when every one of them passed.
  const matrix = impact.requiredVerifiers.map(id => ({ id, status: needs.verifiers?.result === 'success' ? 'PASS' : 'FAIL', reason: `verifier matrix: ${needs.verifiers?.result ?? 'missing'}` }));
  const changed = all ? await trackedContent(workspace) : await changedContent(workspace, files);
  const security = await verifySecurity({ workspace, sbi: {}, assessment, policy, config, headSha, verification: { checks: [...checks, ...matrix] }, changed, entries: all ? changed.length : files.length });
  // A trusted bot's dependency PR lifts the source requirement only; everything above and judgeCi stay as they are.
  const exemption = impact.sbiRequired && pullNumber !== undefined
    ? await dependencyBotExemption({ policy: dependencyBotPolicySchema.parse(await readJson(join(root, '.harness/rules/dependency-bots.json'))), files, headSha, repository, pullNumber, github })
    : null;
  // The SBI source is a separate axis from the change type: a changed, broken or deleted snapshot is always verified,
  // while the Run trailers alone are no source and never change the change type. A legacy hand-written SBI is not a snapshot (#217).
  const snapshotChanged = files.some(f => snapshotFilePattern.test(f.path));
  const required = exemption?.exempt ? [] : impact.sbiRequiredReasons.length ? impact.sbiRequiredReasons : snapshotChanged ? ['sbi-snapshot'] : [];
  const verified = await verifySbiSource({ root: workspace, base, files, required, config, repository, github: issueGithub });
  const source = { ...verified, ...(exemption ? { exemption } : {}) };
  // A destructive migration that migration-safety let through as an exception request still needs two reviews on headSha.
  const migrationExceptions = all ? { status: 'PASS', exceptions: [], reasons: [] }
    : await verifyMigrationExceptions({ root: workspace, base, files, headSha, repository, pullNumber, ...(githubPr ? { githubPr } : {}) });
  // The Run snapshot and the generated Trusted Acceptance are in the Harness PR, so only the files the implementation changed count against the SBI Issue's estimate.
  const changedPaths = files.map(f => f.path).filter(path => !snapshotFilePattern.test(path) && !snapshots.some(s => isGeneratedRegistrationPath(path, s.snapshot.sbi)));
  const granularity = snapshots.filter(s => s.snapshot.sbi.kind === 'implementation')
    .map(s => ({ sbi: s.snapshot.source.url, ...judgeChangedFileCount({ estimatedFiles: s.snapshot.sbi.estimatedFiles, changedPaths }) }));
  // The maestro job uploads one result file per lane; the workflow downloads them into maestroResults before the Judge runs.
  const maestro = { headSha, results: maestroResults && impact.maestro.length ? await readMaestroResults(maestroResults, impact.maestro) : {} };
  const judged = judgeCi({ impact, needs, acceptance, security, source, granularity, migrationExceptions, maestro });
  const tested = expectedHeadSha === undefined ? [] : judgeTestedCommit({ headSha, expectedHeadSha, needs });
  const based = all || !expectedBaseSha ? [] : await judgeBase({ root: workspace, base, expectedBaseSha });
  const reasons = [...tested, ...based, ...judged.reasons];
  return { impact, acceptance, checks, security, source, granularity, migrationExceptions, maestro, status: reasons.length ? 'FAIL' : 'PASS', reasons };
}

export function describeJudge({ needs, acceptance, checks, security, granularity = [], migrationExceptions }) {
  const list = items => items.length ? ` (${items.map(c => `${c.id}: ${c.status}`).join(', ')})` : ' (none)';
  return [
    `Application: ${Object.entries(needs).filter(([job]) => job !== 'impact').map(([job, value]) => `${job}=${value.result}`).join(' ') || '(no job results)'}`,
    `Acceptance: ${acceptance.status}${list(checks.filter(c => c.trust === 'acceptance'))}`,
    `Security: ${security.status}${list(security.checks.filter(c => c.required))}`,
    ...granularity.map(g => `Changed files: ${g.status} (${g.sbi}: ${g.changedFiles} changed, ${g.estimatedFiles ?? 'no'} expected)`),
    ...(migrationExceptions?.exceptions.length || migrationExceptions?.status === 'FAIL' ? [`Migration exception: ${migrationExceptions.status}${migrationExceptions.exceptions.map(e => ` (${e.migration}: ${e.approvers.join(', ') || 'no approval'})`).join('')}`] : []),
  ];
}

export function describeImpact(impact) {
  return [
    `SBI: ${impact.sbis.join(', ') || '(none; diff only)'}`,
    ...describeChangeType({ changeType: impact.changeType, ...impact.changeTypeFiles }),
    `Affected areas: ${impact.affectedAreas.join(', ') || '(none)'}`,
    ...impact.verifiers.map(v => `Verifier ${v.id}${v.mandatory ? ' [mandatory]' : ''}: ${v.reasons.join(', ')}`),
    `Acceptance (Completion Judge): ${impact.acceptanceVerifiers.join(', ') || '(none)'}`,
    `Full Gate: ${impact.fullGate ? `yes (${impact.fullGateReasons.join(', ')})` : 'no'}`,
    `Maestro: ${impact.maestro?.length ? impact.maestro.join(', ') : 'not required'}`,
  ];
}
