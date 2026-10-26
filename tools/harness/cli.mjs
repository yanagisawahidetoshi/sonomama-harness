import { fileURLToPath } from 'node:url';
import { check, runHarness, resumeRun, cleanupRun } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { withEvidenceProtection, redactText } from './evidence-protection.mjs';
import { exportRun } from './review-export.mjs';
import { relativePath } from './schemas.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
await withEvidenceProtection(root, async () => {
try {
  const [command, ...args] = process.argv.slice(2);
  const allowed = { check: ['--sbi'], demo: ['--sbi', '--full'], run: ['--provider', '--sbi', '--full'], cleanup:['--run'], resume: ['--run'], approve: ['--run', '--phase', '--decision'], export: ['--run','--out'] };
  if (!allowed[command]) throw new Error('Usage: check | demo [--full] | run [--full] | cleanup --run ID | resume --run ID | approve --run ID --phase gate|design|merge [--decision approve|revoke|request-changes]');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--full' && allowed[command].includes('--full') && !options['--full']) { options['--full']=true; i--; continue; }
    if (!allowed[command].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error(`Invalid arguments for ${command}`);
    options[args[i]] = args[i + 1];
  }
  if (options['--sbi']) relativePath.parse(options['--sbi']);
  if (command === 'check') {
    await check(root, options['--sbi']);
    console.log('Harness check: PASS (configuration / directories / SBI / registry / risk policy / security rules / policy references)');
  } else if (command === 'cleanup') {
    if (!options['--run']) throw new Error('cleanup requires --run ID');
    await cleanupRun({root,runId:options['--run']});
    console.log('Worktree removed; evidence and run commit ref retained.');
  } else if (command === 'export') {
    if (!options['--run']) throw new Error('export requires --run ID');
    const output = await exportRun({root,runId:options['--run'],out:options['--out']});
    console.log(`Review ZIP: ${output.path} (${output.included} files; ${output.excluded} excluded)`);
  } else if (command === 'approve') {
    if (!options['--run'] || !['gate', 'design', 'merge'].includes(options['--phase'])) throw new Error('approve requires --run ID --phase gate|design|merge');
    const decisions = { approve: 'APPROVE', revoke: 'REVOKE', 'request-changes': 'REQUEST_CHANGES' };
    const decision = decisions[options['--decision'] || 'approve'];
    if (!decision) throw new Error('Unknown approval decision');
    const approval = await recordDecision({ root, runId: options['--run'], purpose: options['--phase'] === 'design' ? 'design-approval' : options['--phase'] === 'gate' ? 'implementation-gate' : 'merge', decision });
    console.log(`${approval.purpose}: ${approval.decision} by ${approval.reviewer}, SHA=${approval.commitSha}`);
    console.log('記録しました。harness:resume --run IDで判定を更新してください。');
  } else {
    if (command === 'resume' && !options['--run']) throw new Error('resume requires --run ID');
    const run = command === 'resume' ? await resumeRun({ root, runId: options['--run'] })
      : await runHarness({ root, provider: command === 'demo' ? 'fake' : options['--provider'], sbiPath: options['--sbi'], full:options['--full'] === true });
    console.log(`Evidence: ${run.runDir}/summary.json`);
    process.exitCode = run.status === 'MERGE_ALLOWED' || (command === 'demo' && run.executionStatus === 'DONE' && run.status === 'WAITING_FOR_HUMAN_REVIEW') ? 0 : 2;
  }
} catch (error) { console.error(redactText(error.message)); process.exitCode = 1; }
}).catch(() => { console.error('Evidence protection initialization failed'); process.exitCode = 1; });
