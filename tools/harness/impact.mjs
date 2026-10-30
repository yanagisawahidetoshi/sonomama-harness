import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeEnvTemplate } from './evidence-protection.mjs';
import { verifyEngineeringSource } from './engineering-source.mjs';
import { readJson } from './io.mjs';
import { isProductionPath } from './lanes.mjs';
import { claimsSbiSource, readSbiFiles, snapshotFilePattern, verifySbiSource } from './sbi-source.mjs';
import { judgeChangedFileCount } from './planner-judge.mjs';
import { dependencyBotExemption } from './dependency-bot.mjs';
import { githubCli } from './planner-github.mjs';
import { verifyMigrationExceptions } from './migration-exception-approval.mjs';
import { judgeMaestro, maestroLanes, readMaestroResults } from './maestro.mjs';
import { configSchema, dependencyBotPolicySchema, securityPolicySchema } from './schemas.mjs';
import { classifySecurity, combineSecurity, securityPassed, verifySecurity } from './security-enforcement.mjs';
import { checksPassed, verify } from './verifier.mjs';
import { withAcceptance } from './acceptance-registry.mjs';
import { changedFiles as diffFiles, git } from './workspace.mjs';
// SBI Impact Analysis for CI scheduling. harness.json stays the single definition of verifiers; this only decides which of them a change needs.
const sorted = values => [...new Set(values)].sort();
const applicationVerifiers = config => config.verifiers.filter(v => (v.trust || 'application') === 'application');
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
  // Production work needs an approved source: an SBI Run for Product implementation, a ready Engineering Issue for engineering changes.
  // Prototypes, docs and Harness maintenance stay outside lanes.json productionPaths.
  const sbiRequiredReasons = files.filter(f => isProductionPath(f.path)).slice(0, 1).map(f => `production:${f.path}`);
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
    sbiRequired: sbiRequiredReasons.length > 0,
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
  if (impact.sbiRequired && source?.status !== 'PASS') reasons.push(...(source?.reasons.length ? source.reasons : ['sbi source: not evaluated']));
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

// The same diff the Harness run classifies (with added and deleted lines), taken from the merge base like base...HEAD.
export async function changedFiles(root, base) {
  const mergeBase = (await git(root, ['merge-base', base, 'HEAD'])).stdout.trim();
  return diffFiles(root, mergeBase, 'HEAD');
}

// Changed hand-written SBI JSON and the SBI inside Harness Run snapshots both drive Impact Analysis and Trusted Acceptance.
export async function changedSbis(root, files) {
  return (await readSbiFiles(root, files)).sbis;
}

export async function loadImpact({ root, base, all = false }) {
  const files = all ? [] : await changedFiles(root, base);
  const { sbis, snapshots } = await readSbiFiles(root, files);
  // Each Run snapshot brings the Trusted Acceptance of its own SBI Issue only (.harness/acceptance/sbi-<N>.json).
  const config = await withAcceptance(root, configSchema.parse(await readJson(join(root, '.harness/config/harness.json'))), snapshots.map(s => s.snapshot.source.number));
  return { config, files, sbis, snapshots, impact: analyzeImpact({ config, sbis, runSbis: snapshots.map(s => s.snapshot.sbi), files, all }) };
}

// The matrix job: one verifier, mandatory only when an SBI asked for it, so a cross-layer contract without a document stays a placeholder SKIP.
export async function runVerifier({ root, base, all = false, id }) {
  const { config, files, impact } = await loadImpact({ root, base, all });
  const entry = impact.verifiers.find(v => v.id === id);
  const mandatory = entry?.mandatory ?? false;
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
async function changedContent(root, files) {
  const content = [];
  for (const f of files.filter(f => f.status !== 'D')) {
    let text = '';
    try { text = await readFile(join(root, f.path), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    content.push({ path: f.path, text: f.added ?? '', envTemplate: isSafeEnvTemplate(f.path, text) });
  }
  return content;
}

// Completion Judge: trusted acceptance of every changed SBI and the Harness Security Policy run here. Production changes must be backed by either
// a ready SBI Run snapshot or, for engineering/maintenance work, a ready Engineering Issue linked from a commit trailer.
// expectedHeadSha is the head the workflow checked out; the CLI always passes it, so a missing value fails there.
export async function runCompletionJudge({ root, base, all = false, needs, repository = process.env.GITHUB_REPOSITORY, pullNumber, github = githubCli, githubPr, maestroResults, expectedHeadSha }) {
  const { config, files, sbis, snapshots, impact } = await loadImpact({ root, base, all });
  const missing = [], checks = [];
  for (const sbi of sbis) {
    const result = await verify({ root, workspace: root, config, sbi, files, only: new Set(sbi.acceptanceCriteria.map(a => a.verifier)) });
    checks.push(...result.checks);
    missing.push(...sbi.acceptanceCriteria.filter(a => !result.acceptance.includes(a.id)).map(a => a.id));
  }
  const acceptance = { status: !sbis.length || (checksPassed(checks) && !missing.length) ? 'PASS' : 'FAIL', missing };
  const policy = securityPolicySchema.parse(await readJson(join(root, '.harness/rules/security.json')));
  const assessment = combineSecurity(classifySecurity({ files }, policy), ...sbis.map(sbi => classifySecurity({ files, sbi }, policy)));
  // Application verifiers an SBI requires ran in the matrix job, which succeeds only when every one of them passed.
  const matrix = impact.requiredVerifiers.map(id => ({ id, status: needs.verifiers?.result === 'success' ? 'PASS' : 'FAIL', reason: `verifier matrix: ${needs.verifiers?.result ?? 'missing'}` }));
  const headSha = (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
  const security = await verifySecurity({ workspace: root, sbi: {}, assessment, policy, config, headSha, verification: { checks: [...checks, ...matrix] }, changed: await changedContent(root, files) });
  // A trusted bot's dependency PR lifts the source requirement only; everything above and judgeCi stay as they are.
  const exemption = impact.sbiRequired && pullNumber !== undefined
    ? await dependencyBotExemption({ policy: dependencyBotPolicySchema.parse(await readJson(join(root, '.harness/rules/dependency-bots.json'))), files, headSha, repository, pullNumber, github })
    : null;
  const required = exemption?.exempt ? [] : impact.sbiRequiredReasons;
  // Anything that claims an SBI (a changed, broken or deleted snapshot, or the Run trailers) is judged as an SBI, so an Engineering Issue
  // cannot stand in for a missing or broken Run.
  const verified = await claimsSbiSource(root, base, files)
    ? await verifySbiSource({ root, base, files, required, config, repository, github })
    : await verifyEngineeringSource({ root, base, required, repository, github });
  const source = { ...verified, ...(exemption ? { exemption } : {}) };
  // A destructive migration that migration-safety let through as an exception request still needs two reviews on headSha.
  const migrationExceptions = all ? { status: 'PASS', exceptions: [], reasons: [] }
    : await verifyMigrationExceptions({ root, base, files, headSha, repository, pullNumber, ...(githubPr ? { githubPr } : {}) });
  // The Run snapshot is in every Harness PR, so only the files the implementation changed count against the SBI Issue's estimate.
  const changedPaths = files.map(f => f.path).filter(path => !snapshotFilePattern.test(path));
  const granularity = snapshots.filter(s => s.snapshot.sbi.kind === 'implementation')
    .map(s => ({ sbi: s.snapshot.source.url, ...judgeChangedFileCount({ estimatedFiles: s.snapshot.sbi.estimatedFiles, changedPaths }) }));
  // The maestro job uploads one result file per lane; the workflow downloads them into maestroResults before the Judge runs.
  const maestro = { headSha, results: maestroResults && impact.maestro.length ? await readMaestroResults(maestroResults, impact.maestro) : {} };
  const judged = judgeCi({ impact, needs, acceptance, security, source, granularity, migrationExceptions, maestro });
  const tested = expectedHeadSha === undefined ? [] : judgeTestedCommit({ headSha, expectedHeadSha, needs });
  const reasons = [...tested, ...judged.reasons];
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
    `SBI required: ${impact.sbiRequired ? `yes (${impact.sbiRequiredReasons.join(', ')})` : 'no (no production path changed)'}`,
    `Affected areas: ${impact.affectedAreas.join(', ') || '(none)'}`,
    ...impact.verifiers.map(v => `Verifier ${v.id}${v.mandatory ? ' [mandatory]' : ''}: ${v.reasons.join(', ')}`),
    `Acceptance (Completion Judge): ${impact.acceptanceVerifiers.join(', ') || '(none)'}`,
    `Full Gate: ${impact.fullGate ? `yes (${impact.fullGateReasons.join(', ')})` : 'no'}`,
    `Maestro: ${impact.maestro?.length ? impact.maestro.join(', ') : 'not required'}`,
  ];
}
