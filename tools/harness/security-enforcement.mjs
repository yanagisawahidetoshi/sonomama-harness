import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runIsolated } from './isolation.mjs';
import { hasSecret, hasTrackedCredential, isSecretPath } from './evidence-protection.mjs';
import { classifyLane } from './lanes.mjs';
import { securityPolicySchema } from './schemas.mjs';
const normalize = text => text.replace(/[^a-z0-9]/gi, '').toLowerCase();
// Markdown that only cites a policy file or rule ID (e.g. docs/security/authorization.md, SEC-ROLE-001) is not a security change.
const citationFree = (path, text) => /\.(md|mdx|markdown)$/i.test(path)
  ? text.replace(/\]\([^)]*\)/g, ']').replace(/(?:[\w.-]+\/)+[\w-]+\.[a-z0-9]+\b|\b[\w-]+\.(?:md|mdx|markdown)\b/gi, '').replace(/\bSEC-[A-Z]+-\d+\b/g, '')
  : text;
// The classifier and its fixture must spell out what contentPatterns detect; path rules and verifiers still apply to them.
const classifierSources = new Set(['tools/harness/security-enforcement.mjs', 'tools/harness/security-impact-classifier.test.mjs']);
const classifierSource = f => [f.path, f.previousPath].filter(Boolean).every(path => classifierSources.has(path));
// A rule's contentExceptions drop only the named strings, and only when the file stays under the exception's paths before and after.
const contentFor = (rule, f, text) => (rule.contentExceptions || [])
  .filter(e => [f.path, f.previousPath].filter(Boolean).every(path => e.pathPatterns.some(p => new RegExp(p).test(path))))
  .reduce((rest, e) => e.ignoredPatterns.reduce((t, p) => t.replace(new RegExp(p, 'gi'), ''), rest), text);
// An SBI that declares a rule requires all its verifiers; a matched file requires only the verifiers whose appliesTo covers that file.
const sbiSources = new Set(['requiredSecurityRules', 'securityImpact', 'SBI/acceptance']);
export function classifySecurity({ files = [], sbi = {}, legacySbi = false }, rawPolicy) {
  const policy = securityPolicySchema.parse(rawPolicy);
  const appliesTo = new Map(policy.verifiers.map(v => [v.id, v.appliesTo]));
  const applies = (id, matches) => !appliesTo.get(id) || matches.some(m => sbiSources.has(m.source) || [m.path, m.previousPath].some(path => path && appliesTo.get(id).some(p => new RegExp(p).test(path))));
  const impacts = new Set(), matchedRules = [], reasons = [];
  const required = new Set([...policy.alwaysRequiredVerifiers, ...(sbi.requiredVerifiers || [])]);
  let gate = Boolean(sbi.preImplementationGate), minimum = Math.max(2, sbi.minimumRiskLevel || 2), approvals = 0;
  const declared = [...(sbi.securityImpact || [])];
  for (const id of sbi.requiredSecurityRules || []) if (!policy.rules.some(r => r.id === id)) throw new Error('Unknown security rule ID');
  for (const impact of declared) if (!policy.rules.some(r => r.categories.some(c => normalize(c) === normalize(impact)))) throw new Error('Unknown security impact category');
  const metadata = JSON.stringify({ title: sbi.title, description: sbi.description, risks: sbi.risks, acceptanceCriteria: sbi.acceptanceCriteria });
  for (const rule of policy.rules) {
    const matches = [];
    if ((sbi.requiredSecurityRules || []).includes(rule.id)) matches.push({ source: 'requiredSecurityRules' });
    if (declared.some(d => rule.categories.some(c => normalize(c) === normalize(d)))) matches.push({ source: 'securityImpact' });
    if (!(legacySbi && rule.ignoreLegacySbiMetadata) && rule.metadataPatterns.some(p => new RegExp(p,'i').test(metadata))) matches.push({ source: 'SBI/acceptance' });
    for (const f of files) {
      const at = f.previousPath ? { path: f.path, previousPath: f.previousPath } : { path: f.path };
      if ([f.path, f.previousPath].filter(Boolean).some(path => rule.pathPatterns.some(p => new RegExp(p,'i').test(path)))) matches.push({ source: 'path', ...at });
      const inAddedScope = rule.addedContent && [f.path, f.previousPath].filter(Boolean).some(path => rule.addedContent.pathPatterns.some(p => new RegExp(p,'i').test(path)));
      if (inAddedScope && !classifierSource(f)) {
        const added = rule.addedContent.ignoredPatterns.reduce((text, p) => text.replace(new RegExp(p, 'gim'), ''), f.added || '');
        if (f.binary || rule.addedContent.patterns.some(p => new RegExp(p,'im').test(added)) || rule.addedContent.removedPatterns.some(p => new RegExp(p,'im').test(f.deleted || ''))) matches.push({ source: 'added-content', ...at });
      }
      if (!classifierSource(f) && rule.contentPatterns.some(p => new RegExp(p,'im').test(contentFor(rule, f, citationFree(f.path, `${f.added || ''}\n${f.deleted || ''}`))))) matches.push({ source: 'changed-content', ...at });
    }
    if (rule.categories.includes('SecurityConfig') && files.some(f => policy.forbiddenPatterns.some(p => new RegExp(p,'im').test(`${f.added || ''}\n${f.deleted || ''}`)))) matches.push({ source: 'forbidden-security-pattern' });
    if (rule.categories.includes('Secret') && files.some(f => f.excludedSecret === true || isSecretPath(f.path) || hasSecret(`${f.added || ''}\n${f.deleted || ''}`))) matches.push({ source: 'secret-file-or-content' });
    if (matches.length) {
      rule.categories.forEach(c => impacts.add(c)); matchedRules.push(rule.id);
      rule.requiredVerifiers.filter(id => applies(id, matches)).forEach(id => required.add(id));
      gate ||= rule.preImplementationGate; minimum = Math.max(minimum, rule.minimumRiskLevel); approvals = Math.max(approvals, rule.requiredHumanApprovals);
      reasons.push({ ruleId: rule.id, policyDocument: rule.policyDocument, matches });
    }
  }
  if (classifyLane(files,sbi).requiresSecurityGate) {
    gate=true; minimum=3; approvals=Math.max(approvals,2);
    if (!matchedRules.length) { matchedRules.push('SEC-CONFIG-001'); impacts.add('SecurityConfig'); required.add('forbidden-pattern-check'); reasons.push({ruleId:'SEC-CONFIG-001',source:'lane-security-escalation'}); }
  }
  return { impacts: [...impacts], matchedRules, securitySensitive: matchedRules.length > 0,
    requiresPreImplementationGate: gate, preImplementationGateRequired: gate,
    minimumRiskLevel: minimum, requiredHumanApprovals: approvals, requiredVerifiers: [...required], reasons, violations: [] };
}
export function securityPassed(evidence) {
  return evidence?.status === 'PASS' && Array.isArray(evidence.violations) && evidence.violations.length === 0
    && Array.isArray(evidence.requiredVerifiers) && evidence.requiredVerifiers.length > 0
    && evidence.requiredVerifiers.every(id => evidence.checks?.some(c => c.id === id && c.required === true && c.status === 'PASS'))
    && evidence.checks?.every(c => c.required !== true || c.status === 'PASS');
}
// changed lists what the content checks read: CI passes the added lines of each changed file (envTemplate marks a vetted .env template),
// a Harness run its committed diff read whole from the workspace. With requireTargets, scanning no file is a SKIP, never a PASS.
export async function verifySecurity({ workspace, assessment, policy, config, headSha, verification, changed, requireTargets = false }) {
  const registry = new Map(policy.verifiers.map(v => [v.id, v]));
  for (const adapter of config.securityVerifiers || []) {
    if (registry.has(adapter.id) && registry.get(adapter.id).kind !== 'command') throw new Error('Builtin security verifiers cannot be overridden');
    registry.set(adapter.id, { ...adapter, kind: 'command' });
  }
  const checks = [], violations = [];
  const content = [];
  const contentKinds = new Set(['secret', 'pii-log', 'forbidden']);
  if (!changed && assessment.requiredVerifiers.some(id => contentKinds.has(registry.get(id)?.kind))) throw new Error('Security content checks need the changed files to scan');
  for (const { path, text, envTemplate } of changed ?? []) {
    if (isSecretPath(path) && !envTemplate) { violations.push({ code: 'prohibited_secret_path', path }); continue; }
    if (text !== undefined) { content.push({ path, text }); continue; }
    try { content.push({ path, text: await readFile(join(workspace,path), 'utf8') }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const id of assessment.requiredVerifiers) {
    const adapter = registry.get(id);
    const general = verification?.checks?.find(c=>c.id===id);
    if (general) { checks.push({...general,required:true,verifier:id}); continue; }
    if (!adapter || (adapter.kind === 'command' && !adapter.commands?.length)) {
      checks.push({ id, verifier: id, required: true, status: 'NOT_CONFIGURED', reason: 'required security verifier is not configured' }); continue;
    }
    if (adapter.kind === 'command') {
      const cwd = join(workspace, adapter.directory || '.');
      const {status,reason,processes}=await runIsolated({workspace,adapter,config,cwd});
      checks.push({id,verifier:id,required:true,status,...(reason&&{reason}),cwd,isolation:adapter.isolation||'container',processes});
    } else {
      const patterns = adapter.kind === 'secret' ? policy.secretPatterns : adapter.kind === 'pii-log' ? policy.piiLogPatterns : policy.forbiddenPatterns;
      const findings = [];
      for (const file of content) {
        if (adapter.kind === 'secret' && hasTrackedCredential(file.path, file.text)) findings.push({path:file.path,code:'credential_value'});
        for (let i=0;i<patterns.length;i++) if (new RegExp(patterns[i],'im').test(file.text)) findings.push({path:file.path,code:adapter.kind,patternIndex:i});
      }
      violations.push(...findings.map(f=>({...f,verifier:id})));
      const scanned = content.map(f=>f.path);
      if (requireTargets && !scanned.length) { checks.push({id,verifier:id,required:true,status:'SKIP',reason:'no changed file to scan',scanned,findings}); continue; }
      checks.push({id,verifier:id,required:true,status:findings.length?'FAIL':'PASS',scanned,findings});
    }
  }
  for (const id of registry.keys()) if (!assessment.requiredVerifiers.includes(id)) checks.push({id,verifier:id,required:false,status:'SKIP',reason:'not applicable to this change'});
  const result = { headSha, requiredVerifiers:assessment.requiredVerifiers, checks, violations };
  return { ...result, status: violations.length || checks.some(c=>c.required&&c.status!=='PASS') ? 'FAIL':'PASS' };
}
export function combineSecurity(...assessments) {
  const union = key => [...new Set(assessments.flatMap(a => a[key] || []))];
  return { impacts:union('impacts'),matchedRules:union('matchedRules'),requiredVerifiers:union('requiredVerifiers'),
    securitySensitive:assessments.some(a=>a.securitySensitive),
    requiresPreImplementationGate:assessments.some(a=>a.requiresPreImplementationGate),
    preImplementationGateRequired:assessments.some(a=>a.requiresPreImplementationGate),
    minimumRiskLevel:Math.max(2,...assessments.map(a=>a.minimumRiskLevel||2)),
    requiredHumanApprovals:Math.max(0,...assessments.map(a=>a.requiredHumanApprovals||0)),
    reasons:assessments.flatMap(a=>a.reasons||[]),violations:union('violations') };
}
