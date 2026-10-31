// #147: running the generated Trusted Acceptance (Rails request specs) and reading what it proved.
// The commands run through the compose isolation like the Rails verifiers; this module only builds them and reads the RSpec JSON report,
// so the judgement never executes generated code itself.
// G (before the implementation): every mapped example must either fail on an expectation (the missing behavior is detected) or already pass
// (the existing implementation meets the spec). Anything else (an error that is not an expectation, a load error, a missing or pending
// example, no report) is undeterminable and stops the run. I (after the implementation): every mapped example passes.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runIsolated } from './isolation.mjs';
import { acceptanceResultSchema } from './schemas.mjs';
export const expectationNotMet = new Set(['RSpec::Expectations::ExpectationNotMetError', 'RSpec::Expectations::MultipleExpectationsNotMetError']);
const run = (...task) => ['docker', 'compose', '-f', 'compose.yaml', 'run', '--rm', '-e', 'RAILS_ENV=test', '-e', 'DATABASE_URL=postgres://postgres@db:5432/sonomama_acceptance_test', 'api', ...task];

// examples narrows the run to the examples of one Scenario (a controlled violation); -e matches by description.
export function acceptanceCommands(sbiIssue, { examples = [] } = {}) {
  return [
    ['docker', 'compose', '-f', 'compose.yaml', 'build', 'api'],
    run('bin/rails', 'db:prepare'),
    run('bundle', 'exec', 'rspec', `spec/acceptance/sbi_${sbiIssue}`, ...examples.flatMap(e => ['-e', e]), '--format', 'json'),
    ['docker', 'compose', '-f', 'compose.yaml', 'down'],
  ];
}

// The report is the last JSON object on stdout; Compose and Rails may print before it.
export function parseRspecJson(output) {
  const text = String(output ?? '');
  for (let start = text.lastIndexOf('{"version"'); start >= 0; start = text.lastIndexOf('{"version"', start - 1)) {
    try {
      const report = JSON.parse(text.slice(start).trim().split('\n')[0]);
      if (!Array.isArray(report.examples)) continue;
      return { examples: report.examples.map(e => ({ description: e.description, status: e.status, exceptionClass: e.exception?.class ?? null, message: e.exception?.message ?? null })),
        errorsOutsideOfExamples: report.summary?.errors_outside_of_examples_count ?? 0 };
    } catch { /* not the report */ }
  }
  return { error: 'no RSpec JSON report in the output', examples: [], errorsOutsideOfExamples: 0 };
}

const mapped = registration => registration.mapping.flatMap(m => m.examples.map(e => ({ scenario: m.scenario, acceptanceIds: m.acceptanceIds, description: e.description })));
const resultOf = (report, description) => report.examples.find(e => e.description === description);

export function judgeDetection({ registration, report }) {
  const reasons = [];
  if (report.error) reasons.push(report.error);
  if (report.errorsOutsideOfExamples) reasons.push(`${report.errorsOutsideOfExamples} errors occurred outside of examples (the specs could not be loaded)`);
  const undeterminable = (entry, reason) => { reasons.push(reason); return { ...entry, outcome: 'undeterminable', reason }; };
  const outcomes = mapped(registration).map(entry => {
    const result = resultOf(report, entry.description);
    if (!result) return undeterminable(entry, `"${entry.description}" did not run`);
    if (result.status === 'passed') return { ...entry, outcome: 'already satisfied' };
    // The failed expectation is kept, so the evidence shows which expected outcome of which Scenario was missing.
    if (result.status === 'failed' && expectationNotMet.has(result.exceptionClass)) return { ...entry, outcome: 'detected', failure: { description: entry.description, message: result.message ?? null } };
    return undeterminable(entry, `"${entry.description}" ${result.status}${result.exceptionClass ? ` with ${result.exceptionClass}` : ''}, which is not a failed expectation`);
  });
  const scenarios = registration.mapping.map(m => {
    const own = outcomes.filter(o => o.scenario === m.scenario);
    const outcome = report.error || report.errorsOutsideOfExamples || own.some(o => o.outcome === 'undeterminable') ? 'undeterminable' : own.some(o => o.outcome === 'detected') ? 'detected' : 'already satisfied';
    const reason = own.filter(o => o.reason).map(o => o.reason).join('; ') || (outcome === 'undeterminable' ? reasons.join('; ') : null);
    return { scenario: m.scenario, acceptanceIds: m.acceptanceIds, outcome, failures: own.filter(o => o.failure).map(o => o.failure), ...(reason ? { reason } : {}) };
  });
  return { status: reasons.length ? 'UNDETERMINABLE' : 'PASS', scenarios, reasons };
}

export function judgeAcceptance({ registration, report }) {
  const reasons = [];
  if (report.error) reasons.push(report.error);
  const met = new Set(), failed = new Set();
  for (const entry of mapped(registration)) {
    const result = resultOf(report, entry.description);
    const ok = !report.error && !report.errorsOutsideOfExamples && result?.status === 'passed';
    for (const id of entry.acceptanceIds) (ok ? met : failed).add(id);
    if (!ok) reasons.push(`"${entry.description}" (${entry.acceptanceIds.join(', ')}) ${result ? result.status : 'did not run'}`);
  }
  // An acceptance criterion is met only when every example mapped to it passed.
  const acceptance = [...met].filter(id => !failed.has(id)).sort();
  return { status: reasons.length ? 'FAIL' : 'PASS', acceptance, reasons };
}

// The default runner: the generated specs of one SBI through the compose isolation, read back as the RSpec report.
// They are PR code (and, for a controlled violation, an AI-proposed change), so they run without an outside network (ADR-0005).
export async function runGeneratedAcceptance({ workspace, sbiIssue, config, examples }) {
  const adapter = { id: `generated-acceptance-sbi-${sbiIssue}`, isolation: 'compose', network: false, commands: acceptanceCommands(sbiIssue, { examples }) };
  const result = await runIsolated({ workspace, adapter, config, cwd: workspace });
  const report = parseRspecJson(result.processes?.[2]?.stdout);
  return result.reason && report.error ? { ...report, error: `${report.error} (${result.reason})` } : report;
}

// CI: the verifier matrix runs the generated specs and leaves the report for the Completion Judge, bound to the commit it ran on.
const resultPath = (dir, sbiIssue) => join(dir, `sbi-${sbiIssue}.json`);
export async function writeAcceptanceResult({ dir, sbiIssue, headSha, report }) {
  await mkdir(dir, { recursive: true });
  await writeFile(resultPath(dir, sbiIssue), `${JSON.stringify(acceptanceResultSchema.parse({ sbiIssue, headSha, report }), null, 2)}\n`);
}
// A missing, malformed or foreign report reads as a report with an error, so judgeAcceptance fails every mapped example.
export async function readAcceptanceResult({ dir, sbiIssue, headSha }) {
  const failed = error => ({ error, examples: [], errorsOutsideOfExamples: 0 });
  let parsed;
  try { parsed = acceptanceResultSchema.safeParse(JSON.parse(await readFile(resultPath(dir, sbiIssue), 'utf8'))); }
  catch (error) { return failed(error.code === 'ENOENT' ? 'no report from the verifier matrix' : `the report cannot be read (${error.message})`); }
  if (!parsed.success) return failed(`the report is malformed (${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join(', ')})`);
  if (parsed.data.sbiIssue !== sbiIssue) return failed(`the report is for SBI Issue #${parsed.data.sbiIssue}`);
  if (parsed.data.headSha !== headSha) return failed(`the report is for ${parsed.data.headSha.slice(0, 12)}, not ${headSha.slice(0, 12)}`);
  return parsed.data.report;
}
