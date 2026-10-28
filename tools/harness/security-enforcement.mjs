import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execute } from './io.mjs';
import { hasSecret, hasTrackedCredential, isSecretPath } from './evidence-protection.mjs';
import { classifyLane } from './lanes.mjs';
import { securityPolicySchema } from './schemas.mjs';
const normalize = text => text.replace(/[^a-z0-9]/gi, '').toLowerCase();
export function classifySecurity({ files = [], sbi = {} }, rawPolicy) {
  const policy = securityPolicySchema.parse(rawPolicy);
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
    if (rule.metadataPatterns.some(p => new RegExp(p,'i').test(metadata))) matches.push({ source: 'SBI/acceptance' });
    for (const f of files) {
      if ([f.path, f.previousPath].filter(Boolean).some(path => rule.pathPatterns.some(p => new RegExp(p,'i').test(path)))) matches.push({ source: 'path', path: f.path });
      if (rule.contentPatterns.some(p => new RegExp(p,'im').test(`${f.added || ''}\n${f.deleted || ''}`))) matches.push({ source: 'changed-content', path: f.path });
    }
    if (rule.categories.includes('SecurityConfig') && files.some(f => policy.forbiddenPatterns.some(p => new RegExp(p,'im').test(`${f.added || ''}\n${f.deleted || ''}`)))) matches.push({ source: 'forbidden-security-pattern' });
    if (rule.categories.includes('Secret') && files.some(f => f.excludedSecret === true || isSecretPath(f.path) || hasSecret(`${f.added || ''}\n${f.deleted || ''}`))) matches.push({ source: 'secret-file-or-content' });
    if (matches.length) {
      rule.categories.forEach(c => impacts.add(c)); matchedRules.push(rule.id);
      rule.requiredVerifiers.forEach(id => required.add(id));
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
// changed replaces reading sbi.allowedFiles: CI passes the added lines of each changed file (envTemplate marks a vetted .env template).
export async function verifySecurity({ workspace, sbi, assessment, policy, config, headSha, verification, changed }) {
  const registry = new Map(policy.verifiers.map(v => [v.id, v]));
  for (const adapter of config.securityVerifiers || []) {
    if (registry.has(adapter.id) && registry.get(adapter.id).kind !== 'command') throw new Error('Builtin security verifiers cannot be overridden');
    registry.set(adapter.id, { ...adapter, kind: 'command' });
  }
  const checks = [], violations = [];
  const content = [];
  for (const { path, text, envTemplate } of changed ?? sbi.allowedFiles.map(path => ({ path }))) {
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
      const processes = [];
      for (const [command,...args] of adapter.commands) processes.push(await execute(command,args,{cwd,timeoutMs:config.timeoutMs}));
      const unavailable=processes.some(p=>p.error?.includes('ENOENT'));
      checks.push({id,verifier:id,required:true,status:unavailable?'NOT_CONFIGURED':processes.every(p=>p.ok)?'PASS':'FAIL',cwd,processes});
    } else {
      const patterns = adapter.kind === 'secret' ? policy.secretPatterns : adapter.kind === 'pii-log' ? policy.piiLogPatterns : policy.forbiddenPatterns;
      const findings = [];
      for (const file of content) {
        if (adapter.kind === 'secret' && hasTrackedCredential(file.path, file.text)) findings.push({path:file.path,code:'credential_value'});
        for (let i=0;i<patterns.length;i++) if (new RegExp(patterns[i],'im').test(file.text)) findings.push({path:file.path,code:adapter.kind,patternIndex:i});
      }
      violations.push(...findings.map(f=>({...f,verifier:id})));
      checks.push({id,verifier:id,required:true,status:findings.length?'FAIL':'PASS',findings});
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
