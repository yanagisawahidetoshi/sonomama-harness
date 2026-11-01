import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { contractPath } from './api-contract-path.mjs';

const methods = ['get', 'put', 'post', 'patch', 'delete', 'options', 'head', 'trace'];
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Merge keys are resolved, so an operation that takes its requirements from an anchor is compared with them.
function read(text) {
  const document = parseYaml(text, { merge: true });
  if (!object(document)) throw new Error('not an OpenAPI document');
  return document;
}
function operations(document) {
  const found = new Map();
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    if (!object(item) || '$ref' in item) throw new Error(`path item ${route} cannot be read here`);
    for (const method of methods.filter(m => m in item)) {
      if (!object(item[method])) throw new Error(`operation ${method} ${route} cannot be read here`);
      found.set(`${method.toUpperCase()} ${route}`, item[method]);
    }
  }
  return found;
}
// The operations a contract change makes public without touching existing or shared requirements (#243): new operations whose
// security is [] while the top-level security, the security schemes and every existing operation stay as they were.
// null when the change does anything else to them, or when it cannot be told apart (unparsable, before unknown, renamed, other paths).
export function newPublicOperations(file) {
  if (!contractPath.test(file.path) || file.previousPath || typeof file.after !== 'string') return null;
  if (typeof file.before !== 'string' && file.status !== 'A') return null;
  try {
    const before = typeof file.before === 'string' ? read(file.before) : {}, after = read(file.after);
    if (!isDeepStrictEqual(before.security, after.security) || !isDeepStrictEqual(before.components?.securitySchemes, after.components?.securitySchemes)) return null;
    const old = operations(before), now = operations(after), added = [];
    for (const [key, operation] of old) if (!now.has(key) || !isDeepStrictEqual(operation.security, now.get(key).security)) return null;
    for (const [key, operation] of now) {
      if (old.has(key) || !('security' in operation)) continue;
      if (!Array.isArray(operation.security) || operation.security.length) return null;
      added.push(key);
    }
    return added;
  } catch { return null; }
}
const named = /\b(GET|PUT|POST|PATCH|DELETE|OPTIONS|HEAD|TRACE)\s+(\/[^\s`'"、。,)）]*)/g;
const emptySecurity = /\bsecurity\s*:\s*\[\s*\]/;
// The approved SBI declares an operation public in one statement (title, description, risk or acceptance criterion) that names only that
// operation and says it needs no authentication (the rule's ignoredMetadataPatterns) or requires security: [].
export function declaredPublic(operation, sbi, negations) {
  const statements = [sbi.title, sbi.description, ...(sbi.risks ?? []), ...(sbi.acceptanceCriteria ?? []).map(a => a.description)].filter(s => typeof s === 'string');
  return statements.some(statement => {
    const operations = new Set([...statement.matchAll(named)].map(m => `${m[1]} ${m[2]}`));
    return operations.size === 1 && operations.has(operation) && (emptySecurity.test(statement) || negations.some(p => new RegExp(p, 'i').test(statement)));
  });
}
