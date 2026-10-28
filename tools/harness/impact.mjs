import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson } from './io.mjs';
import { configSchema, sbiSchema } from './schemas.mjs';
import { checksPassed, verify } from './verifier.mjs';
import { git } from './workspace.mjs';
// SBI Impact Analysis for CI scheduling. harness.json stays the single definition of verifiers; this only decides which of them a change needs.
const sorted = values => [...new Set(values)].sort();
const applicationVerifiers = config => config.verifiers.filter(v => (v.trust || 'application') === 'application');
const firstMatch = (patterns = [], files) => files.find(f => patterns.some(p => new RegExp(p).test(f.path)))?.path;

export function analyzeImpact({ config, sbis = [], files = [], all = false }) {
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
  // Areas come from the SBI and from what the diff touched, so a diff the SBI did not mention still brings its cross-layer contract.
  const areas = new Set([...sbiAreas, ...[...verifiers.keys()].flatMap(areasOf)]);
  for (const rule of config.impact?.crossLayer ?? []) {
    const hit = rule.any.filter(area => areas.has(area));
    if (rule.all.every(area => areas.has(area)) && hit.length) {
      for (const id of rule.add) select(id, `cross-layer:${[...rule.all, ...hit].join('+')}`, false);
    }
  }
  const fullGatePath = firstMatch(config.impact?.fullGate, files);
  const fullGateReasons = all ? ['all'] : fullGatePath ? [`diff:${fullGatePath}`] : [];
  const selected = [...verifiers.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    sbis: sbis.map(s => s.id),
    affectedAreas: sorted(areas),
    requiredVerifiers: selected.map(v => v.id),
    verifiers: selected,
    acceptanceVerifiers: sorted(sbis.flatMap(s => s.acceptanceCriteria.map(a => a.verifier))),
    fullGate: fullGateReasons.length > 0,
    fullGateReasons,
  };
}

// Required jobs must succeed; a job may be skipped only when the impact did not ask for it.
export function judgeCi({ impact, needs, acceptance }) {
  const reasons = [];
  const expect = (job, wanted) => {
    const result = needs[job]?.result ?? 'missing';
    if (wanted ? result !== 'success' : !['success', 'skipped'].includes(result)) reasons.push(`${job}: ${result}`);
  };
  expect('impact', true);
  expect('verifiers', impact.requiredVerifiers.length > 0);
  expect('harness-test', impact.fullGate);
  expect('harness-demo', impact.fullGate);
  if (acceptance.status !== 'PASS') reasons.push(...(acceptance.missing.length ? [`acceptance missing: ${acceptance.missing.join(', ')}`] : ['acceptance: FAIL']));
  return { status: reasons.length ? 'FAIL' : 'PASS', reasons };
}

export async function changedFiles(root, base) {
  const { stdout } = await git(root, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]);
  return stdout.split('\n').filter(Boolean).map(path => ({ path }));
}

export async function changedSbis(root, files) {
  const paths = files.map(f => f.path).filter(path => /^\.harness\/state\/sbi-[^/]+\.json$/.test(path));
  const sbis = [];
  for (const path of paths) {
    let text;
    try { text = await readFile(join(root, path), 'utf8'); } catch { continue; }
    sbis.push(sbiSchema.parse(JSON.parse(text)));
  }
  return sbis;
}

export async function loadImpact({ root, base, all = false }) {
  const config = configSchema.parse(await readJson(join(root, '.harness/config/harness.json')));
  const files = all ? [] : await changedFiles(root, base);
  const sbis = await changedSbis(root, files);
  return { config, files, sbis, impact: analyzeImpact({ config, sbis, files, all }) };
}

// The matrix job: one verifier, mandatory only when an SBI asked for it, so a cross-layer contract without a document stays a placeholder SKIP.
export async function runVerifier({ root, base, all = false, id }) {
  const { config, files, impact } = await loadImpact({ root, base, all });
  const mandatory = impact.verifiers.find(v => v.id === id)?.mandatory ?? false;
  const sbi = { title: 'CI matrix', description: id, risks: [], securityImpact: [], acceptanceCriteria: [], requiredVerifiers: [] };
  const result = await verify({ root, workspace: root, config, sbi, files, only: new Set([id]), selected: new Map([[id, mandatory]]) });
  return { impact, result, passed: checksPassed(result.checks) };
}

// Completion Judge: trusted acceptance of every changed SBI runs here, then the job results are checked against what the impact required.
export async function runCompletionJudge({ root, base, all = false, needs }) {
  const { config, files, sbis, impact } = await loadImpact({ root, base, all });
  const missing = [], checks = [];
  for (const sbi of sbis) {
    const result = await verify({ root, workspace: root, config, sbi, files, only: new Set(sbi.acceptanceCriteria.map(a => a.verifier)) });
    checks.push(...result.checks);
    missing.push(...sbi.acceptanceCriteria.filter(a => !result.acceptance.includes(a.id)).map(a => a.id));
  }
  const acceptance = { status: !sbis.length || (checksPassed(checks) && !missing.length) ? 'PASS' : 'FAIL', missing };
  return { impact, acceptance, checks, ...judgeCi({ impact, needs, acceptance }) };
}

export function describeImpact(impact) {
  return [
    `SBI: ${impact.sbis.join(', ') || '(none; diff only)'}`,
    `Affected areas: ${impact.affectedAreas.join(', ') || '(none)'}`,
    ...impact.verifiers.map(v => `Verifier ${v.id}${v.mandatory ? ' [mandatory]' : ''}: ${v.reasons.join(', ')}`),
    `Acceptance (Completion Judge): ${impact.acceptanceVerifiers.join(', ') || '(none)'}`,
    `Full Gate: ${impact.fullGate ? `yes (${impact.fullGateReasons.join(', ')})` : 'no'}`,
  ];
}
