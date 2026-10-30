import { isDeepStrictEqual } from 'node:util';
import defaults from '../../.harness/rules/change-types.json' with { type: 'json' };
import { isProductionPath } from './lanes.mjs';
import { changeTypeRulesSchema } from './schemas.mjs';
// ADR-0006: the change type of a Production diff comes from the changed files alone, never from a commit message, the PR or an LLM.
// A file is engineering only when a rule proves it does not enter the runtime; anything else keeps the diff ambiguous, which requires an SBI.
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const gemLine = /^\s*gem\s+(["'])([A-Za-z0-9_.-]+)\1((?:\s*,\s*(["'])[^"'\n]*\4)*)\s*$/;
const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };

// Only the versions of dependencies that were already there may change; scripts, overrides and any other key keep the file ambiguous.
function dependencyVersionsOnly(before, after) {
  const [old, now] = [parse(before), parse(after)];
  if (!old || !now || typeof old !== 'object' || typeof now !== 'object') return false;
  const rest = value => Object.fromEntries(Object.entries(value).filter(([key]) => !dependencySections.includes(key)));
  if (!isDeepStrictEqual(rest(old), rest(now))) return false;
  return dependencySections.every(key => isDeepStrictEqual(Object.keys(old[key] ?? {}).sort(), Object.keys(now[key] ?? {}).sort()));
}

// Every changed line is the same gem with only its version strings changed; a gem added, removed, regrouped or given options is not.
function gemVersionsOnly(before, after) {
  const [old, now] = [before.split('\n'), after.split('\n')];
  if (old.length !== now.length) return false;
  return old.every((line, i) => {
    if (line === now[i]) return true;
    const [a, b] = [gemLine.exec(line), gemLine.exec(now[i])];
    return Boolean(a && b && a[2] === b[2]);
  });
}

const contentChecks = { 'package-json-dependency-versions': dependencyVersionsOnly, 'gemfile-versions': gemVersionsOnly };

function classifyFile(file, rules) {
  if (file.mode === '120000') return { reason: 'symlink' };
  if (file.binary) return { reason: 'binary' };
  if (file.modeChanged) return { reason: 'mode changed' };
  const rule = rules.engineering.find(r => new RegExp(r.pattern).test(file.path) && !(r.exclude ?? []).some(p => new RegExp(p).test(file.path)));
  if (!rule) return { reason: 'no engineering rule matches' };
  if (!rule.content) return { rule: rule.id };
  // Content rules compare both sides of a modification; an added or deleted file, or contents that were not read, fail closed.
  const proven = file.status === 'M' && typeof file.before === 'string' && typeof file.after === 'string' && contentChecks[rule.content](file.before, file.after);
  return proven ? { rule: rule.id } : { reason: `${rule.id} not proven` };
}

export function classifyChangeType(files, rawRules = defaults) {
  const rules = changeTypeRulesSchema.parse(rawRules);
  const engineering = [], ambiguous = [];
  for (const file of files.filter(f => isProductionPath(f.path))) {
    const { rule, reason } = classifyFile(file, rules);
    if (rule) engineering.push({ path: file.path, rule });
    else ambiguous.push({ path: file.path, reason });
  }
  if (!engineering.length && !ambiguous.length) return { changeType: null, requiresSbi: false, engineering, ambiguous };
  // ambiguous means "not proven engineering", not "product": it is kept as is and only requires an SBI.
  return ambiguous.length ? { changeType: 'ambiguous', requiresSbi: true, engineering, ambiguous } : { changeType: 'engineering', requiresSbi: false, engineering, ambiguous };
}

// Content rules need both sides of the file; only those paths are read, so the classifier itself stays pure.
export const needsContent = (path, rawRules = defaults) => changeTypeRulesSchema.parse(rawRules).engineering.some(r => r.content && new RegExp(r.pattern).test(path));

export function describeChangeType(result) {
  if (!result.changeType) return ['Change type: none (no production path changed) / SBI not required'];
  return [
    result.changeType === 'engineering' ? 'Change type: engineering / SBI not required' : 'Change type: ambiguous / SBI required (fail-closed)',
    ...result.ambiguous.map(a => `Change type ambiguous: ${a.path} (${a.reason})`),
    ...result.engineering.map(e => `Change type rule ${e.rule}: ${e.path}`),
  ];
}
