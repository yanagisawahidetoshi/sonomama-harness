// #147: static quality checks on the Trusted Acceptance a generation agent returned for an approved spec (Rails request specs first).
// A mapping only counts when the example it names exists, really runs and checks an expected result. These are heuristics: the final
// judgement of a generated test stays with the PR Review, and the detection of a controlled violation is a separate, executed check.
export const acceptanceDirectory = sbiIssue => `apps/api/spec/acceptance/sbi_${sbiIssue}/`;
// The description is a Ruby string literal; a backslash escapes the quote that would otherwise end it.
const exampleStart = /^(\s*)(it|specify|example|scenario|xit|xspecify|xexample|fit|fspecify|fexample)\s*\(?\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')(.*?)\s+do\s*(\|[^|]*\|)?\s*$/;
const unescape = (double, single) => double !== undefined ? double.replace(/\\(["\\])/g, '$1') : single.replace(/\\(['\\])/g, '$1');
const notRun = /^(x|f)/;
// Stubs that replace what the scenario is supposed to check (an authorization policy, a controller, any instance, a query chain).
const stubs = [
  ['allow_any_instance_of', /\ballow_any_instance_of\b/], ['expect_any_instance_of', /\bexpect_any_instance_of\b/],
  ['receive_message_chain', /\breceive_message_chain\b/], ['stubbed Policy / Controller / Authorizer', /\ballow\(\s*[A-Z]\w*(Policy|Controller|Authorizer)\b/],
];
const code = line => line.replace(/#.*$/, '');

function examples(content) {
  const lines = content.split('\n'), found = [];
  lines.forEach((line, index) => {
    const start = exampleStart.exec(line);
    if (!start) return;
    const indent = start[1], end = lines.findIndex((l, i) => i > index && new RegExp(`^${indent}end\\s*$`).test(l));
    found.push({ keyword: start[2], description: unescape(start[3], start[4]), metadata: start[5], line: index + 1, body: lines.slice(index + 1, end < 0 ? lines.length : end).map(code) });
  });
  return found;
}

function inspectExample(example) {
  const problems = [];
  if (notRun.test(example.keyword)) problems.push(`${example.keyword} does not run normally`);
  if (/(:focus\b|\bfocus:|:skip\b|\bskip:|:pending\b|\bpending:)/.test(example.metadata)) problems.push(`metadata ${example.metadata.trim()} skips or focuses it`);
  if (example.body.some(l => /^\s*(pending|skip)\b/.test(l))) problems.push('pending or skip inside the example');
  const expectations = example.body.filter(l => /\bexpect\s*[({]/.test(l) || /\bis_expected\b/.test(l));
  if (!expectations.length) problems.push('no expect, so it checks no expected result');
  else if (expectations.every(l => /\bexpect\(\s*(true|false|nil|\d+|"[^"]*"|'[^']*')\s*\)/.test(l))) problems.push('only a constant expectation, which always gives the same result');
  return problems;
}

export function inspectGeneratedAcceptance({ spec, generated }) {
  const findings = [], add = (path, message) => findings.push({ path, message });
  const directory = acceptanceDirectory(spec.sbiIssue), files = new Map();
  for (const file of generated.files ?? []) {
    const unsafe = typeof file.path !== 'string' || file.path.split('/').some(s => s === '..' || s === '.' || s === '');
    if (unsafe || !file.path.startsWith(directory) || !file.path.endsWith('_spec.rb')) { add(String(file.path), `generated tests must be *_spec.rb files under ${directory}`); continue; }
    files.set(file.path, examples(file.content));
    file.content.split('\n').forEach((line, index) => {
      for (const [name, pattern] of stubs) if (pattern.test(code(line))) add(`${file.path}:${index + 1}`, `${name} replaces what the scenario checks`);
    });
  }
  const knownAc = new Set(spec.acceptanceCriteria.map(a => a.id)), knownScenario = new Set(spec.scenarios);
  for (const entry of generated.mapping ?? []) {
    if (!knownScenario.has(entry.scenario)) add('(mapping)', `Scenario ${entry.scenario} is not in the approved spec`);
    for (const id of entry.acceptanceIds ?? []) if (!knownAc.has(id)) add('(mapping)', `${id} is not an acceptance criterion of the approved spec`);
    if (!entry.examples?.length) add('(mapping)', `Scenario ${entry.scenario} maps to no example`);
    for (const ref of entry.examples ?? []) {
      const example = files.get(ref.path)?.find(e => e.description === ref.description);
      if (!example) { add(ref.path, `example "${ref.description}" is not in the generated files`); continue; }
      for (const problem of inspectExample(example)) add(`${ref.path}:${example.line}`, `"${ref.description}": ${problem}`);
    }
  }
  const mapped = (generated.mapping ?? []).filter(m => m.examples?.length);
  for (const id of knownAc) if (!mapped.some(m => m.acceptanceIds?.includes(id))) add('(mapping)', `${id} has no example`);
  for (const scenario of knownScenario) if (!mapped.some(m => m.scenario === scenario)) add('(mapping)', `Scenario ${scenario} has no example`);
  return { status: findings.length ? 'FAIL' : 'PASS', findings };
}
