import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
const storage = new AsyncLocalStorage();
const mask = '[REDACTED]';
const defaults = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g, /AKIA[0-9A-Z]{16}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];
const assignment = /(?<![A-Za-z0-9_])((?:["']?)(?:password|passwd|api[_-]?key|access[_-]?key|upload[_-]?token|token|secret|credential|authorization)(?:["']?)\s*(?::|=(?!=))\s*)(?:["']?)([^\s"',;\}\]]+)/gi;
export function isSecretPath(path) {
  const normalized = path.replaceAll('\\', '/');
  // Required policy document is prose, not a credential store. Its content is still inspected.
  if (/(^|\/)docs\/security\/secrets\.md$/i.test(normalized)) return false;
  return normalized.split('/').some(name => /^\.env(?:\.|$)|\.(pem|key|p12|pfx)$|^(credentials|secrets)|^\.upload-access-key$/i.test(name));
}
// Only narrowly named dotenv templates are eligible. Live env paths remain protected everywhere else.
export function isSafeEnvTemplate(path, content) {
  const parts = path.replaceAll('\\','/').split('/');
  const name = parts.pop();
  if (!/^\.env(?:\.[A-Za-z0-9_-]+)*\.(example|sample|template)$/i.test(name || '') || isSecretPath(parts.join('/'))) return false;
  if (Buffer.byteLength(content) > 65536 || content.includes('\u0000')) return false;
  // Scan the original content before removing placeholders; a comment or placeholder cannot conceal a token.
  if ([...defaults, ...(storage.getStore()?.patterns || [])].some(pattern => new RegExp(pattern).test(content)) || /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(content)) return false;
  let invalid = false;
  const inspected = content.split(/\r?\n/).map(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return line;
    const value = match[2].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    const placeholder = value === '' || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
      || /^<your[-_][A-Za-z0-9_-]+>$/.test(value)
      || /^(your_(api_key|access_key|token|password|secret)(_here)?|replace[-_]me|changeme|example|placeholder)$/i.test(value);
    if (placeholder) return match[2].match(/\s+(#.*)$/)?.[1] || '';
    if (/(^|_)(password|passwd|token|secret|credentials?|api_key|access_key|private_key)(_|$)/i.test(match[1])) invalid = true;
    return line;
  }).join('\n');
  return !invalid && !hasSecret(inspected);
}
export function redactText(input) {
  let text = String(input);
  const context = storage.getStore();
  for (const literal of context?.literals || []) text = text.split(literal).join(mask);
  for (const pattern of defaults) text = text.replace(pattern, mask);
  for (const pattern of context?.patterns || []) text = text.replace(new RegExp(pattern,'gm'), mask);
  text = text.replace(assignment, (_full, prefix, value) => ['true','false','null','undefined','[REDACTED]'].includes(value) ? prefix + value : prefix + mask);
  for (const extension of context?.extensions || []) text = extension(text);
  return text;
}
export function hasSecret(text) { return redactText(text) !== String(text); }
export function redact(value) {
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed=JSON.parse(value), safe=redact(parsed);
        if (JSON.stringify(parsed)!==JSON.stringify(safe)) return JSON.stringify(safe);
      } catch { /* ordinary text */ }
    }
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const hiddenFile = typeof value.path === 'string' && isSecretPath(value.path);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      (hiddenFile && ['content','added','deleted'].includes(key)) || (/^(password|passwd|api_?key|access_?key|token|secret|credential|authorization)$/i.test(key) && typeof entry === 'string') ? mask : redact(entry)]));
  }
  return value;
}
export function assertSafeInput(value) {
  if (JSON.stringify(value) !== JSON.stringify(redact(value))) throw new Error('Sensitive value detected in Harness input; remove it before running');
}
export function rememberSecret(text) {
  const context = storage.getStore();
  if (!context) return;
  const candidates = [text.trim(), ...text.split(/\r?\n/).map(line => {
    const match = line.match(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/);
    return match ? match[1].replace(/^["']|["']$/g, '') : line.trim();
  })];
  for (const value of candidates) if (value.length >= 6 && value.length < 65536 && !context.literals.includes(value)) context.literals.push(value);
  context.literals.sort((a,b) => b.length - a.length);
}
export async function withEvidenceProtection(root, fn, { extensions = [] } = {}) {
  if (storage.getStore()?.root === root) return fn();
  return storage.run({ root, literals: [], patterns: [], extensions }, async () => {
    try {
      const policy=JSON.parse(await readFile(join(root,'.harness/rules/security.json'),'utf8'));
      for(const pattern of policy.secretPatterns || []) { new RegExp(pattern); storage.getStore().patterns.push(pattern); }
    } catch(error) { if(error.code!=='ENOENT') throw new Error('Security redaction policy is invalid'); }
    // Read values only into this private redaction context. Never return them or log them.
    for (const [key, value] of Object.entries(process.env)) {
      if (/(secret|token|password|credential|private_key|access_key|api_key)/i.test(key) && value) rememberSecret(value);
    }
    let inspected = 0;
    async function scan(directory) {
      for (const name of await readdir(directory)) {
        if (['node_modules','.git','.harness','sources','.codex','.agents'].includes(name)) continue;
        if (++inspected > 30000) throw new Error('Secret discovery limit exceeded; narrow the Harness source root');
        const path = join(directory, name), info = await lstat(path);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) await scan(path);
        else if (info.isFile() && isSecretPath(relative(root, path)) && info.size < 65536) {
          const content = await readFile(path, 'utf8');
          if (!content.includes('\u0000') && !isSafeEnvTemplate(path,content)) rememberSecret(content);
        }
      }
    }
    await scan(root);
    return fn();
  });
}
// Export also discovers prohibited files inside older evidence that predates these rules.
export async function discoverEvidenceSecrets(directory) {
  for (const name of await readdir(directory)) {
    if (['.git','node_modules','.operation-lock'].includes(name)) continue;
    const path=join(directory,name),info=await lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await discoverEvidenceSecrets(path);
    else if (info.isFile() && isSecretPath(path) && info.size<65536) {
      const text=await readFile(path,'utf8');
      if (!text.includes('\u0000') && !isSafeEnvTemplate(path,text)) rememberSecret(text);
    }
  }
}
