// #147: running the generated Trusted Acceptance (Rails request specs) and reading what it proved.
// The commands run through the compose isolation like the Rails verifiers; this module only builds them and reads the RSpec JSON report,
// so the judgement never executes generated code itself.
// G (before the implementation): every mapped example must either fail on an expectation (the missing behavior is detected) or already pass
// (the existing implementation meets the spec). Anything else (an error that is not an expectation, a load error, a missing or pending
// example, no report) is undeterminable and stops the run. I (after the implementation): every mapped example passes.
const notMet = new Set(['RSpec::Expectations::ExpectationNotMetError', 'RSpec::Expectations::MultipleExpectationsNotMetError']);
const run = (...task) => ['docker', 'compose', '-f', 'compose.yaml', 'run', '--rm', '-e', 'RAILS_ENV=test', '-e', 'DATABASE_URL=postgres://postgres@db:5432/sonomama_acceptance_test', 'api', ...task];

export function acceptanceCommands(sbiIssue) {
  return [
    ['docker', 'compose', '-f', 'compose.yaml', 'build', 'api'],
    run('bin/rails', 'db:prepare'),
    run('bundle', 'exec', 'rspec', `spec/acceptance/sbi_${sbiIssue}`, '--format', 'json'),
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
  const outcomes = mapped(registration).map(entry => {
    const result = resultOf(report, entry.description);
    if (!result) { reasons.push(`"${entry.description}" did not run`); return { ...entry, outcome: 'undeterminable' }; }
    if (result.status === 'passed') return { ...entry, outcome: 'already satisfied' };
    if (result.status === 'failed' && notMet.has(result.exceptionClass)) return { ...entry, outcome: 'detected' };
    reasons.push(`"${entry.description}" ${result.status}${result.exceptionClass ? ` with ${result.exceptionClass}` : ''}, which is not a failed expectation`);
    return { ...entry, outcome: 'undeterminable' };
  });
  const scenarios = registration.mapping.map(m => {
    const own = outcomes.filter(o => o.scenario === m.scenario);
    return { scenario: m.scenario, outcome: own.some(o => o.outcome === 'undeterminable') ? 'undeterminable' : own.some(o => o.outcome === 'detected') ? 'detected' : 'already satisfied' };
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
