import { fileURLToPath } from 'node:url';
import { check, runHarness, resumeRun, cleanupRun, openPullRequest, approveRun, runExitCode, reverifyPullRequest } from './index.mjs';
import { withEvidenceProtection, redactText } from './evidence-protection.mjs';
import { exportRun } from './review-export.mjs';
import { planIssue } from './planner.mjs';
import { planApiSchema } from './api-schema-planner.mjs';
import { recordApiSchemaDecision, apiSchemaApprovalStatus } from './api-schema-approval.mjs';
import { startApiMock } from './api-mock.mjs';
import { startApiDocs } from './api-docs.mjs';
import { relativePath } from './schemas.mjs';
import { describeImpact, describeJudge, loadImpact, runCompletionJudge, runVerifier } from './impact.mjs';
import { runPushGate } from './push-gate.mjs';
import { describeSbiSource } from './sbi-source.mjs';
import { appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
// The normal flow is planner:sbi → harness:run → (only at a Human Gate) harness:approve. The rest serves CI, recovery and Harness maintenance.
const usage = `Usage:
User-facing:
  pnpm planner:sbi PBI_URL [--provider codex]        PBIをSBI Issueへ分割する（既定はClaude）
  pnpm harness:run SBI_URL [--provider codex] [--full]
                                                     readyのSBI Issueから実装・ローカル検証・PR作成まで進める（既定はClaude）
  pnpm harness:approve SBI_URL --phase gate|design [--decision approve|revoke|request-changes]
                                                     Human Gateを承認し、そのままrunを再開してPRを作成する
  pnpm harness:reverify PR_URL                       mainが進んだPRを、実装を保持したまま最新mainと統合して再検証し、同じPRを更新する
API design (API契約を設計するときだけ):
  OpenAPI SchemaはPlannerが作るSchema SBI（packages/api-schemaだけを変える）として pnpm harness:run SBI_URL で作る
  pnpm api:mock ISSUE_URL [--dynamic] | pnpm api:docs [--port PORT]
Internal/Maintenance (CI・障害復旧・Harness保守用):
  pnpm harness:resume --run RUN_ID | pnpm harness:pr --run RUN_ID | pnpm harness:approve --run RUN_ID --phase gate|design|merge
  pnpm harness:run --sbi PATH [--provider fake|codex|claude]（Harness自己テスト・fixture用のSBI JSON）
  pnpm harness:impact --base REF|--all | pnpm harness:verify --verifier ID --base REF|--all | pnpm harness:judge --base REF|--all
  pnpm harness:check | pnpm harness:test | pnpm harness:demo [--full] | pnpm harness:push-gate
  pnpm harness:export --run RUN_ID [--out PATH] | pnpm harness:cleanup --run RUN_ID | pnpm planner:api-schema-status ISSUE_URL
  node tools/harness/cli.mjs api-schema ISSUE_URL | node tools/harness/cli.mjs api-schema-approve ISSUE_URL（旧API Schema Planner。内部機能）`;
const printPullRequest = run => { if (run.pullRequest) console.log(`Pull request: ${run.pullRequest.url} (tested SHA ${run.headSha})`); };
async function printVerifier({ root: workspace = root, base, all, id }) {
  const { impact, result, passed } = await runVerifier({ root: workspace, base, all, id });
  const selection = impact.verifiers.find(v => v.id === id);
  console.log(redactText(`Selected by: ${selection ? selection.reasons.join(', ') : '(not selected by impact)'}`));
  for (const c of result.checks) {
    for (const p of c.processes || (c.process ? [c.process] : [])) if (!p.ok) console.error(redactText((p.stderr || p.stdout || p.error || '').slice(-4000)));
    console.log(redactText(`${c.id}: ${c.status}${c.reason ? ` (${c.reason})` : ''} [${c.selectionReasons.join(', ')}]`));
  }
  return passed;
}
await withEvidenceProtection(root, async () => {
try {
  const [command, ...args] = process.argv.slice(2);
  const allowed = { check: ['--sbi'], demo: ['--sbi', '--full'], run: ['--provider', '--sbi', '--full'], plan: ['--provider'], 'api-schema': ['--provider'], 'api-schema-approve': ['--decision'], 'api-schema-status': [], 'api-mock': ['--dynamic'], 'api-docs': ['--port'], cleanup:['--run'], impact: ['--base', '--all'], verify: ['--base', '--all', '--verifier'], judge: ['--base', '--all'], 'push-gate': [], resume: ['--run'], pr: ['--run'], reverify: [], approve: ['--run', '--phase', '--decision'], export: ['--run','--out'] };
  if (!allowed[command]) throw new Error(usage);
  const options = {};
  const positional = ['plan', 'api-schema', 'api-schema-approve', 'api-schema-status', 'api-mock', 'run', 'approve', 'reverify'].includes(command) && args.length && !args[0].startsWith('--') ? args.shift() : null;
  for (let i = 0; i < args.length; i += 2) {
    if (['--full', '--dynamic', '--all'].includes(args[i]) && allowed[command].includes(args[i]) && !options[args[i]]) { options[args[i]]=true; i--; continue; }
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
  } else if (command === 'api-docs') {
    if (options['--port'] && !/^\d+$/.test(options['--port'])) throw new Error('api-docs --port requires a port number');
    const port = options['--port'] ? Number(options['--port']) : undefined;
    if (port !== undefined && (port < 1 || port > 65535)) throw new Error('api-docs --port requires a port number');
    const docs = await startApiDocs({ root, port });
    console.log(`API Docs: ${docs.url} (${docs.schemaPath}; Try it outは無効。Ctrl+Cで停止)`);
    await new Promise(resolve => {
      docs.server.on('close', resolve);
      process.once('SIGINT', () => { docs.server.close(); docs.server.closeAllConnections(); });
    });
  } else if (['impact', 'verify', 'judge'].includes(command)) {
    const all = options['--all'] === true, base = options['--base'];
    if (all === Boolean(base)) throw new Error(`${command} requires exactly one of --base REF or --all`);
    // Verifier commands such as api-contract compare against the same base the impact was computed from.
    process.env.HARNESS_BASE_REF = base || 'HEAD';
    const output = async lines => { if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, lines.map(l => `${l}\n`).join('')); };
    if (command === 'impact') {
      const { impact } = await loadImpact({ root, base, all });
      for (const line of describeImpact(impact)) console.log(redactText(line));
      await output([`required_verifiers=${JSON.stringify(impact.requiredVerifiers)}`, `full_gate=${impact.fullGate}`]);
    } else if (command === 'verify') {
      if (!options['--verifier']) throw new Error('verify requires --verifier ID');
      process.exitCode = await printVerifier({ base, all, id: options['--verifier'] }) ? 0 : 1;
    } else {
      const needs = JSON.parse(process.env.HARNESS_NEEDS || '{}');
      // Set only on pull_request events; a trusted dependency bot PR is read from GitHub by this number.
      const judged = await runCompletionJudge({ root, base, all, needs, pullNumber: process.env.HARNESS_PULL_REQUEST || undefined });
      for (const line of describeImpact(judged.impact)) console.log(redactText(line));
      for (const line of describeSbiSource(judged.source)) console.log(redactText(line));
      for (const c of [...judged.checks, ...judged.security.checks.filter(c => c.required)]) console.log(redactText(`${c.id}: ${c.status}${c.reason ? ` (${c.reason})` : ''}`));
      for (const [job, value] of Object.entries(needs)) console.log(`job ${job}: ${value.result}`);
      for (const line of describeJudge({ needs, ...judged })) console.log(redactText(line));
      console.log(`Completion Judge: ${judged.status}${judged.reasons.length ? ` (${judged.reasons.join('; ')})` : ''}`);
      process.exitCode = judged.status === 'PASS' ? 0 : 1;
    }
  } else if (command === 'push-gate') {
    // git hands the pushed refs to .githooks/pre-push on stdin; the hook passes them through HARNESS_PUSH_REFS.
    // The refs describe this push only; hook tests inside harness:test must not inherit them.
    const { HARNESS_PUSH_REFS: refs = '', ...env } = process.env;
    const pnpm = (args, cwd) => spawnSync('pnpm', args, { cwd, stdio: 'inherit', env }).status === 0;
    // Each check runs in the detached worktree of the pushed commit, which starts without node_modules.
    const result = await runPushGate({ root, refs, log: line => console.log(redactText(line)),
      install: workspace => pnpm(['install', '--frozen-lockfile', '--prefer-offline'], workspace),
      runFull: workspace => pnpm(['harness:test'], workspace),
      verifyOne: async (id, base, workspace) => { process.env.HARNESS_BASE_REF = base; return printVerifier({ root: workspace, base, all: false, id }); } });
    process.exitCode = result.passed ? 0 : 1;
  } else if (command === 'pr') {
    if (!options['--run']) throw new Error('pr requires --run ID');
    const run = await openPullRequest({ root, runId: options['--run'] });
    console.log(`Pull request: ${run.pullRequest.url} (tested SHA ${run.headSha})`);
    console.log(`Evidence: ${run.runDir}/github-state.json`);
    process.exitCode = runExitCode(run);
  } else if (command === 'reverify') {
    if (!positional) throw new Error('reverify requires a pull request URL: reverify https://github.com/<owner>/<repo>/pull/<number>');
    const run = await reverifyPullRequest({ root, pullUrl: positional });
    if (run.reverify?.publish === 'PR_UPDATED') printPullRequest(run); else console.log(`Pull request: ${run.pullRequest.url} (not updated; run ${run.id}: ${run.status})`);
    if (run.reverify?.conflicts?.length) console.log(`Conflicts: ${run.reverify.conflicts.join(', ')}`);
    if (run.gate?.state === 'WAITING_FOR_HUMAN_GATE' || run.designApproval?.state === 'WAITING_FOR_DESIGN_APPROVAL') console.log(`Human Gate: pnpm harness:approve ${run.sbiIssue.url} --phase ${run.designApproval?.state === 'WAITING_FOR_DESIGN_APPROVAL' ? 'design' : 'gate'}`);
    console.log(`Evidence: ${run.runDir}/summary.json`);
    process.exitCode = runExitCode(run);
  } else if (command === 'cleanup') {
    if (!options['--run']) throw new Error('cleanup requires --run ID');
    await cleanupRun({root,runId:options['--run']});
    console.log('Worktree removed; evidence and run commit ref retained.');
  } else if (command === 'export') {
    if (!options['--run']) throw new Error('export requires --run ID');
    const output = await exportRun({root,runId:options['--run'],out:options['--out']});
    console.log(`Review ZIP: ${output.path} (${output.included} files; ${output.excluded} excluded)`);
  } else if (command === 'approve') {
    if (Boolean(options['--run']) === Boolean(positional) || !['gate', 'design', 'merge'].includes(options['--phase'])) throw new Error('approve requires SBI_URL or --run ID, and --phase gate|design|merge');
    const decisions = { approve: 'APPROVE', revoke: 'REVOKE', 'request-changes': 'REQUEST_CHANGES' };
    const decision = decisions[options['--decision'] || 'approve'];
    if (!decision) throw new Error('Unknown approval decision');
    const run = await approveRun({ root, runId: options['--run'], issueUrl: positional, purpose: options['--phase'] === 'design' ? 'design-approval' : options['--phase'] === 'gate' ? 'implementation-gate' : 'merge', decision });
    console.log(`Recorded ${decision}; run ${run.id}: ${run.status}`);
    printPullRequest(run);
    console.log(`Evidence: ${run.runDir}/summary.json`);
    process.exitCode = runExitCode(run);
  } else {
    if (command === 'resume' && !options['--run']) throw new Error('resume requires --run ID');
    const run = command === 'resume' ? await resumeRun({ root, runId: options['--run'] })
      : await runHarness({ root, provider: command === 'demo' ? 'fake' : options['--provider'], sbiPath: options['--sbi'], issueUrl: positional, full:options['--full'] === true, publish: command === 'run' });
    printPullRequest(run);
    if (run.gate?.state === 'WAITING_FOR_HUMAN_GATE' || run.designApproval?.state === 'WAITING_FOR_DESIGN_APPROVAL') console.log(`Human Gate: pnpm harness:approve ${run.sbiIssue?.url ?? `--run ${run.id}`} --phase ${run.designApproval?.state === 'WAITING_FOR_DESIGN_APPROVAL' ? 'design' : 'gate'}`);
    console.log(`Evidence: ${run.runDir}/summary.json`);
    process.exitCode = runExitCode(run);
  }
} catch (error) { console.error(redactText(error.message)); process.exitCode = 1; }
}).catch(() => { console.error('Evidence protection initialization failed'); process.exitCode = 1; });
