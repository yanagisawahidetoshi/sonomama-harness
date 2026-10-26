import { join } from 'node:path';
import { exists, execute } from './io.mjs';
import { classifyLane } from './lanes.mjs';
export function checksPassed(checks) {
  return Array.isArray(checks) && checks.length > 0 && checks.every(c => c.status === 'PASS'
    || (c.status === 'SKIP' && c.required === false && ['missing app (placeholder)', 'not applicable to this change'].includes(c.reason)));
}
export function verifierRegistry(config) {
  return new Map([
    ['sample-bdd', { id: 'sample-bdd', kind: 'sample-bdd', trust:'acceptance', acceptanceIds: ['AC-1', 'AC-2', 'AC-3'] }],
    ...config.verifiers.map(v => [v.id, { ...v, kind: 'command', trust:v.trust || 'application' }]),
  ]);
}
export async function verify({ root, workspace, config, sbi, files = sbi.allowedFiles.map(path=>({path})), requiredVerifiers = [], full = false, lane = classifyLane(files,sbi) }) {
  const registry = verifierRegistry(config);
  const needed = new Set(sbi.acceptanceCriteria.map(a => a.verifier));
  const explicit = new Set(sbi.requiredVerifiers || []);
  const security = new Set(requiredVerifiers);
  const checks = [], acceptance = [];
  for (const id of new Set([...needed,...explicit,...security])) if (!registry.has(id)) checks.push({id,required:true,status:'NOT_CONFIGURED',selectionReasons:['required'],reason:'required verifier is not configured'});
  for (const adapter of registry.values()) {
    const reasons = [];
    if (needed.has(adapter.id)) reasons.push('acceptance');
    if (explicit.has(adapter.id)) reasons.push('explicit-required');
    if (security.has(adapter.id)) reasons.push('security-required');
    if (adapter.allowMissing === false) reasons.push('configured-required');
    const mandatory = reasons.length > 0;
    const matchesLane = !adapter.lanes || adapter.lanes.includes(lane.name);
    const pathMatch = adapter.kind !== 'sample-bdd' && matchesLane && (!adapter.appliesTo || files.some(f=>adapter.appliesTo.some(p=>new RegExp(p).test(f.path))));
    if (pathMatch) reasons.push('changed-path');
    if (full && matchesLane && adapter.kind !== 'sample-bdd') reasons.push('full');
    const base = { id:adapter.id, required:mandatory || pathMatch, trust:adapter.trust, selectionReasons:reasons };
    if (!reasons.length) {
      checks.push({...base,required:false,status:'SKIP',reason:'not applicable to this change'}); continue;
    }
    if (adapter.kind === 'sample-bdd' || adapter.trust === 'acceptance') {
      const script = join(root, adapter.kind === 'sample-bdd' ? 'tools/harness/sample-bdd.mjs' : adapter.trustedScript || '.harness/verification/NOT_CONFIGURED');
      if (!await exists(script)) { checks.push({...base,required:true,status:'NOT_CONFIGURED',reason:'trusted acceptance script missing'}); continue; }
      const process = await execute(globalThis.process.execPath, ['--experimental-permission', `--allow-fs-read=${workspace}`, `--allow-fs-read=${script}`, script, workspace], { cwd: workspace, timeoutMs: config.timeoutMs });
      const check = { ...base, required:true, status:process.ok?'PASS':'FAIL', cwd:workspace, process };
      if (process.ok) {
        try {
          const evidence = JSON.parse(process.stdout).acceptance;
          if (!Array.isArray(evidence) || evidence.some(id => !adapter.acceptanceIds.includes(id))) throw new Error('invalid acceptance IDs');
          acceptance.push(...evidence);
        } catch { check.status='FAIL'; check.reason='invalid acceptance evidence'; }
      }
      checks.push(check); continue;
    }
    const cwd=join(workspace,adapter.directory);
    const missing=!await exists(cwd) || (adapter.marker && !await exists(join(cwd,adapter.marker)));
    if (missing) checks.push({...base,status:base.required?'FAIL':'SKIP',cwd,reason:base.required?'required app is missing':'missing app (placeholder)',planned:adapter.planned});
    else if (!adapter.commands.length) checks.push({...base,required:true,status:'NOT_CONFIGURED',cwd,reason:'app exists but verifier commands are not configured'});
    else {
      const processes=[];
      for (const [command,...args] of adapter.commands) processes.push(await execute(command,args,{cwd,timeoutMs:config.timeoutMs}));
      checks.push({...base,required:true,status:processes.every(p=>p.ok)?'PASS':'FAIL',cwd,processes});
    }
  }
  return {status:checksPassed(checks)?'PASS':'FAIL',acceptance:[...new Set(acceptance)],lane:lane.name,checks};
}
