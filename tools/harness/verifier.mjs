import { join } from 'node:path';
import { exists, execute } from './io.mjs';
import { classifyLane } from './lanes.mjs';
import { runIsolated } from './isolation.mjs';
import { generatedVerifierId, readAcceptance } from './acceptance-registry.mjs';
import { verifyGeneratedRegistration } from './acceptance-generation.mjs';
import { judgeAcceptance, runGeneratedAcceptance } from './acceptance-run.mjs';
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
// only limits the run to the named verifiers; selected maps an Impact Analysis selection to whether it is mandatory.
export async function verify({ root, workspace, config, sbi, files = sbi.allowedFiles?.map(path=>({path})) ?? [], requiredVerifiers = [], full = false, lane = classifyLane(files,sbi), only = null, selected = new Map(), acceptanceRunner = runGeneratedAcceptance, generatedSpecDigest = null }) {
  const registry = new Map([...verifierRegistry(config)].filter(([id]) => !only || only.has(id)));
  // A run generates its Trusted Acceptance in the workspace (#147), so the root config does not know it yet; the workspace registration does.
  for (const id of new Set(sbi.acceptanceCriteria.map(a => a.verifier))) {
    const number = Number(/^generated-acceptance-sbi-(\d+)$/.exec(id)?.[1]);
    if (!number || registry.has(id) || (only && !only.has(id))) continue;
    const registration = await readAcceptance(workspace, number).catch(() => null);
    if (registration?.version === 2) registry.set(id, { id: generatedVerifierId(number), kind: 'command', trust: 'acceptance', generated: true, sbiIssue: number,
      acceptanceIds: [...new Set(registration.mapping.flatMap(m => m.acceptanceIds))].sort() });
  }
  const needed = new Set(sbi.acceptanceCriteria.map(a => a.verifier));
  const explicit = new Set(sbi.requiredVerifiers || []);
  const security = new Set(requiredVerifiers);
  const checks = [], acceptance = [];
  for (const id of new Set([...needed,...explicit,...security].filter(id => !only || only.has(id)))) if (!registry.has(id)) checks.push({id,required:true,status:'NOT_CONFIGURED',selectionReasons:['required'],reason:'required verifier is not configured'});
  for (const adapter of registry.values()) {
    const reasons = [];
    if (needed.has(adapter.id)) reasons.push('acceptance');
    if (explicit.has(adapter.id)) reasons.push('explicit-required');
    if (security.has(adapter.id)) reasons.push('security-required');
    if (adapter.allowMissing === false) reasons.push('configured-required');
    if (selected.get(adapter.id) === true) reasons.push('impact-required');
    const mandatory = reasons.length > 0;
    // The Trusted Acceptance of one SBI Issue asserts that Issue's change only; it runs when that SBI requires it, never by path or --full.
    const matchesLane = (!adapter.lanes || adapter.lanes.includes(lane.name)) && (adapter.sbiIssue === undefined || needed.has(adapter.id));
    const pathMatch = adapter.kind !== 'sample-bdd' && matchesLane && (!adapter.appliesTo || files.some(f=>adapter.appliesTo.some(p=>new RegExp(p).test(f.path))));
    if (pathMatch) reasons.push('changed-path');
    if (selected.get(adapter.id) === false) reasons.push('impact-selected');
    if (full && matchesLane && adapter.kind !== 'sample-bdd') reasons.push('full');
    const base = { id:adapter.id, required:mandatory || pathMatch, trust:adapter.trust, selectionReasons:reasons };
    if (!reasons.length) {
      checks.push({...base,required:false,status:'SKIP',reason:'not applicable to this change'}); continue;
    }
    // Generated Trusted Acceptance: re-verify the registration (spec, tests, spec support), then run the generated specs isolated (I).
    if (adapter.generated) {
      const registration = await readAcceptance(workspace, adapter.sbiIssue).catch(error => ({ error: error.message }));
      const reasons = registration?.version === 2
        ? await verifyGeneratedRegistration({ root: workspace, registration, ...(generatedSpecDigest ? { specDigest: generatedSpecDigest, sbiIssue: adapter.sbiIssue } : {}) })
        : [registration?.error ?? `generated registration of SBI #${adapter.sbiIssue} is missing`];
      if (reasons.length) { checks.push({ ...base, required: true, status: 'FAIL', reason: reasons.join('; ') }); continue; }
      const judged = judgeAcceptance({ registration, report: await acceptanceRunner({ workspace, sbiIssue: adapter.sbiIssue, config }) });
      acceptance.push(...judged.acceptance);
      checks.push({ ...base, required: true, status: judged.status, ...(judged.reasons.length ? { reason: judged.reasons.join('; ') } : {}), acceptance: judged.acceptance });
      continue;
    }
    if (adapter.kind === 'sample-bdd' || adapter.trust === 'acceptance') {
      const script = join(root, adapter.kind === 'sample-bdd' ? 'tools/harness/sample-bdd.mjs' : adapter.trustedScript || '.harness/verification/NOT_CONFIGURED');
      if (!await exists(script)) { checks.push({...base,required:true,status:'NOT_CONFIGURED',reason:'trusted acceptance script missing'}); continue; }
      // Shared helpers come from the protected root, never from the agent workspace. Dependencies come from the trusted
      // Harness installation; the run workspace's node_modules lives only in verifier containers.
      const process = await execute(globalThis.process.execPath, ['--experimental-permission', `--allow-fs-read=${workspace}`, `--allow-fs-read=${script}`, `--allow-fs-read=${join(root, '.harness/verification/lib')}`, `--allow-fs-read=${join(root, 'node_modules')}`, script, workspace], { cwd: workspace, timeoutMs: config.timeoutMs, env: {} });
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
    // A shared root file (lockfile, workspace config) alone does not require a not-yet-generated app.
    const ownsChange = mandatory || files.some(f => f.path.startsWith(`${adapter.directory}/`));
    if (missing && !ownsChange) checks.push({...base,required:false,status:'SKIP',cwd,reason:'missing app (placeholder)',planned:adapter.planned});
    else if (missing) checks.push({...base,status:'FAIL',cwd,reason:'required app is missing',planned:adapter.planned});
    else if (!adapter.commands.length) checks.push({...base,required:true,status:'NOT_CONFIGURED',cwd,reason:'app exists but verifier commands are not configured'});
    else {
      // A gated command (expo-doctor follows the latest Expo release) runs only for a matching change; requiring the verifier, full and areas do not lift the gate.
      // Only the selected commands reach the isolated runner.
      const gateOf = command => (adapter.gatedCommands ?? []).find(g => g.command.join('\0') === command.join('\0'));
      const commands=[], skippedCommands=[];
      for (const command of adapter.commands) {
        const gate = gateOf(command);
        if (gate && !files.some(f=>gate.appliesTo.some(p=>new RegExp(p).test(f.path)))) {
          skippedCommands.push({command:command.join(' '),reason:'no dependency or native config change matches its appliesTo'}); continue;
        }
        commands.push(command);
      }
      const {status,reason,processes}=await runIsolated({workspace,adapter,config,cwd,commands});
      checks.push({...base,required:true,status,...(reason&&{reason}),cwd,isolation:adapter.isolation||'container',processes,skippedCommands});
    }
  }
  return {status:checksPassed(checks)?'PASS':'FAIL',acceptance:[...new Set(acceptance)],lane:lane.name,checks};
}
