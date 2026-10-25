import { join } from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import { exists, readJson } from './io.mjs';
import { classifySecurity } from './security-enforcement.mjs';
import { verifierRegistry } from './verifier.mjs';
import { assertWritablePath } from './workspace.mjs';
import { configSchema, rulesSchema, sbiSchema, riskPolicySchema, relativePath, securityPolicySchema, humanGatesSchema } from './schemas.mjs';
export async function check(root, sbiPath) {
  const directories = ['apps/api', 'apps/mobile', 'apps/admin', 'packages/api-schema', 'docs/architecture', 'docs/product', 'docs/adr', 'docs/workflows', 'docs/security', '.harness/config', '.harness/rules', '.harness/skills', '.harness/state', '.harness/runs', 'tools/harness'];
  for (const path of directories) {
    if (!await exists(join(root, path)) || !(await stat(join(root, path))).isDirectory()) throw new Error(`Missing directory: ${path}`);
  }
  for (const file of ['AGENTS.md', 'package.json', 'pnpm-workspace.yaml', '.harness/skills/implement.md']) {
    if (!await exists(join(root, file))) throw new Error(`Missing file: ${file}`);
  }
  const config = configSchema.parse(await readJson(join(root, '.harness/config/harness.json')));
  const rules = rulesSchema.parse(await readJson(join(root, '.harness/rules/policy.json')));
  for (const pattern of rules.protectedPathPatterns) new RegExp(pattern);
  const riskPolicy = riskPolicySchema.parse(await readJson(join(root, '.harness/rules/pr-risk.json')));
  for (const rule of [...riskPolicy.pathRules, ...riskPolicy.metadataRules, ...riskPolicy.safeRules]) new RegExp(rule.pattern);
  const securityPolicy = securityPolicySchema.parse(await readJson(join(root, '.harness/rules/security.json')));
  const humanGates = humanGatesSchema.parse(await readJson(join(root, '.harness/rules/human-gates.json')));
  const securityDocuments = {};
  for (const rule of securityPolicy.rules) {
    for (const pattern of [...rule.pathPatterns, ...rule.contentPatterns, ...rule.metadataPatterns]) new RegExp(pattern);
    const text = await readFile(join(root, rule.policyDocument), 'utf8');
    if (!text.includes(rule.id)) throw new Error('Security policy document is missing a referenced rule ID');
    securityDocuments[rule.policyDocument] = text;
    if (!humanGates.preImplementationRuleIds.includes(rule.id)) throw new Error('Security Human Gate rules are inconsistent');
  }
  for (const id of humanGates.preImplementationRuleIds) if (!securityPolicy.rules.some(r => r.id === id)) throw new Error('Unknown Human Gate security rule');
  for (const pattern of [...securityPolicy.secretPatterns, ...securityPolicy.forbiddenPatterns, ...securityPolicy.piiLogPatterns]) new RegExp(pattern);
  if (config.securityVerifiers.some(v => securityPolicy.verifiers.some(base => base.id === v.id && base.kind !== 'command'))) throw new Error('Builtin security verifiers cannot be overridden');
  if (new Set(config.securityVerifiers.map(v => v.id)).size !== config.securityVerifiers.length) throw new Error('Duplicate security verifier');
  if (sbiPath) relativePath.parse(sbiPath);
  const sbi = sbiSchema.parse(await readJson(join(root, sbiPath || config.sbi)));
  classifySecurity({ sbi }, securityPolicy);
  const registry = verifierRegistry(config);
  for (const a of sbi.acceptanceCriteria) {
    if (!registry.has(a.verifier) || !registry.get(a.verifier).acceptanceIds.includes(a.id)) throw new Error(`Unsupported acceptance verifier or unregistered AC: ${a.verifier}/${a.id}`);
  }
  if (sbi.acceptanceCriteria.some(a => a.verifier === 'sample-bdd') && !sbi.allowedFiles.includes('greeting.mjs')) throw new Error('sample-bdd requires greeting.mjs');
  for (const path of sbi.allowedFiles) assertWritablePath(path, { allowSensitiveDeclaration: true });
  const pkg = await readJson(join(root, 'package.json'));
  if (!pkg.private || !pkg.packageManager?.startsWith('pnpm@') || !pkg.scripts?.['harness:check'] || !pkg.scripts?.['harness:demo']) throw new Error('Invalid pnpm root package');
  return { ok: true, config, rules, sbi, riskPolicy, securityPolicy, humanGates, securityDocuments };
}
