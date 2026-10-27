import { fileURLToPath } from 'node:url';
import { check, runHarness, resumeRun, cleanupRun, openPullRequest } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { withEvidenceProtection, redactText } from './evidence-protection.mjs';
import { exportRun } from './review-export.mjs';
import { planIssue } from './planner.mjs';
import { planApiSchema } from './api-schema-planner.mjs';
import { recordApiSchemaDecision, apiSchemaApprovalStatus } from './api-schema-approval.mjs';
import { startApiMock } from './api-mock.mjs';
import { relativePath } from './schemas.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
await withEvidenceProtection(root, async () => {
try {
  const [command, ...args] = process.argv.slice(2);
  const allowed = { check: ['--sbi'], demo: ['--sbi', '--full'], run: ['--provider', '--sbi', '--full'], plan: ['--provider'], 'api-schema': ['--provider'], 'api-schema-approve': ['--decision'], 'api-schema-status': [], 'api-mock': ['--dynamic'], cleanup:['--run'], resume: ['--run'], pr: ['--run'], approve: ['--run', '--phase', '--decision'], export: ['--run','--out'] };
  if (!allowed[command]) throw new Error('Usage: check | demo [--full] | run [--full] | plan ISSUE_URL [--provider codex|claude] | api-schema ISSUE_URL [--provider codex|claude] | api-schema-approve ISSUE_URL [--decision approve|revoke|request-changes] | api-schema-status ISSUE_URL | api-mock ISSUE_URL [--dynamic] | cleanup --run ID | resume --run ID | pr --run ID | approve --run ID --phase gate|design|merge [--decision approve|revoke|request-changes]');
  const options = {};
  const positional = ['plan', 'api-schema', 'api-schema-approve', 'api-schema-status', 'api-mock'].includes(command) && args.length && !args[0].startsWith('--') ? args.shift() : null;
  for (let i = 0; i < args.length; i += 2) {
    if (['--full', '--dynamic'].includes(args[i]) && allowed[command].includes(args[i]) && !options[args[i]]) { options[args[i]]=true; i--; continue; }
    if (!allowed[command].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new Error(`Invalid arguments for ${command}`);
    options[args[i]] = args[i + 1];
  }
  if (options['--sbi']) relativePath.parse(options['--sbi']);
  if (command === 'check') {
    await check(root, options['--sbi']);
    console.log('Harness check: PASS (configuration / directories / SBI / registry / risk policy / security rules / policy references)');
  } else if (command === 'plan') {
    if (!positional) throw new Error('plan requires a GitHub Issue URL: plan https://github.com/<owner>/<repo>/issues/<number>');
    const plan = await planIssue({ root, issueUrl: positional, provider: options['--provider'] });
    console.log(`Evidence: ${plan.planDir}/summary.json`);
  } else if (command === 'api-schema') {
    if (!positional) throw new Error('api-schema requires a GitHub Issue URL: api-schema https://github.com/<owner>/<repo>/issues/<number>');
    const proposal = await planApiSchema({ root, issueUrl: positional, provider: options['--provider'] });
    console.log(`Evidence: ${proposal.runDir}/summary.json`);
  } else if (command === 'api-schema-approve' || command === 'api-schema-status') {
    if (!positional) throw new Error(`${command} requires a GitHub Issue URL`);
    let result;
    if (command === 'api-schema-approve') {
      const decision = { approve: 'APPROVE', revoke: 'REVOKE', 'request-changes': 'REQUEST_CHANGES' }[options['--decision'] || 'approve'];
      if (!decision) throw new Error('Unknown API schema decision');
      result = await recordApiSchemaDecision({ root, issueUrl: positional, decision });
    } else result = await apiSchemaApprovalStatus({ root, issueUrl: positional });
    console.log(`API Schema: ${result.status} (${result.approvals}/${result.required}) digest=${result.proposalDigest ?? '-'} commit=${result.commitSha ?? '-'}`);
    for (const reason of result.reasons) console.log(`- ${reason}`);
    process.exitCode = result.status === 'APPROVED' ? 0 : 2;
  } else if (command === 'api-mock') {
    if (!positional) throw new Error('api-mock requires a GitHub Issue URL: api-mock https://github.com/<owner>/<repo>/issues/<number>');
    const mock = await startApiMock({ root, issueUrl: positional, dynamic: options['--dynamic'] === true });
    console.log(`API Mock: ${mock.url} (${mock.schemaPath} digest=${mock.digest})`);
    process.exitCode = await new Promise(resolve => mock.child.on('exit', code => resolve(code ?? 0)).on('error', () => resolve(1)));
  } else if (command === 'pr') {
    if (!options['--run']) throw new Error('pr requires --run ID');
    const run = await openPullRequest({ root, runId: options['--run'] });
    console.log(`Pull request: ${run.pullRequest.url} (tested SHA ${run.headSha})`);
    console.log(`Evidence: ${run.runDir}/github-state.json`);
    process.exitCode = run.status === 'MERGE_ALLOWED' ? 0 : 2;
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
