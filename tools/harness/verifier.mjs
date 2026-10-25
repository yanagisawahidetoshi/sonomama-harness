import { join } from 'node:path';
import { exists, execute } from './io.mjs';
export function checksPassed(checks) {
  return Array.isArray(checks) && checks.length > 0 && checks.every(c => c.status === 'PASS'
    || (c.status === 'SKIP' && c.required === false && c.reason === 'missing app (placeholder)'));
}
export function verifierRegistry(config) {
  return new Map([
    ['sample-bdd', { id: 'sample-bdd', kind: 'sample-bdd', acceptanceIds: ['AC-1', 'AC-2', 'AC-3'] }],
    ...config.verifiers.map(v => [v.id, { ...v, kind: 'command' }]),
  ]);
}
export async function verify({ root, workspace, config, sbi }) {
  const registry = verifierRegistry(config);
  const needed = new Set(sbi.acceptanceCriteria.map(a => a.verifier));
  const checks = [], acceptance = [];
  const selected = [...registry.values()].filter(v => v.kind !== 'sample-bdd' || needed.has(v.id));
  for (const adapter of selected) {
    if (adapter.kind === 'sample-bdd') {
      const script = join(root, 'tools/harness/sample-bdd.mjs');
      const process = await execute(globalThis.process.execPath, ['--experimental-permission', `--allow-fs-read=${workspace}`, `--allow-fs-read=${script}`, script, workspace], { cwd: workspace, timeoutMs: config.timeoutMs });
      const check = { id: adapter.id, required: true, status: process.ok ? 'PASS' : 'FAIL', cwd: workspace, process };
      if (process.ok) {
        try {
          const evidence = JSON.parse(process.stdout).acceptance;
          if (!Array.isArray(evidence) || evidence.some(id => !adapter.acceptanceIds.includes(id))) throw new Error('invalid acceptance IDs');
          acceptance.push(...evidence);
        } catch { check.status = 'FAIL'; check.reason = 'invalid acceptance evidence'; }
      }
      checks.push(check);
      continue;
    }
    const cwd = join(workspace, adapter.directory);
    if (adapter.marker && !await exists(join(cwd, adapter.marker))) {
      checks.push({ id: adapter.id, required: needed.has(adapter.id) || !adapter.allowMissing, status: needed.has(adapter.id) || !adapter.allowMissing ? 'FAIL' : 'SKIP', cwd,
        reason: needed.has(adapter.id) || !adapter.allowMissing ? 'required app is missing' : 'missing app (placeholder)', planned: adapter.planned });
    } else if (!adapter.commands.length) {
      checks.push({ id: adapter.id, required: true, status: 'FAIL', cwd, reason: 'app exists but verifier commands are not configured' });
    } else {
      const processes = [];
      for (const [command, ...args] of adapter.commands) processes.push(await execute(command, args, { cwd, timeoutMs: config.timeoutMs }));
      const status = processes.every(p => p.ok) ? 'PASS' : 'FAIL';
      checks.push({ id: adapter.id, required: true, status, cwd, processes });
      if (status === 'PASS') acceptance.push(...adapter.acceptanceIds);
    }
  }
  return { status: checksPassed(checks) ? 'PASS' : 'FAIL', acceptance: [...new Set(acceptance)], checks };
}
