import { fileURLToPath } from 'node:url';
import { check, runHarness, resumeRun, cleanupRun, openPullRequest, approveRun, runExitCode, reverifyPullRequest } from './index.mjs';
import { withEvidenceProtection, redactText } from './evidence-protection.mjs';
import { exportRun } from './review-export.mjs';
import { planIssue } from './planner.mjs';
import { planApiSchema } from './api-schema-planner.mjs';
import { recordApiSchemaDecision, apiSchemaApprovalStatus } from './api-schema-approval.mjs';
import { startApiMock, waitForApiMock } from './api-mock.mjs';
import { startApiDocs } from './api-docs.mjs';
import { relativePath } from './schemas.mjs';
import { describeImpact, describeJudge, loadImpact, runCompletionJudge, runVerifier } from './impact.mjs';
import { checkConclusion, runTrustedJudge } from './trusted-judge.mjs';
import { runPushGate } from './push-gate.mjs';
import { providerAiReviewer } from './agents/ai-review-adapter.mjs';
import { describeSbiSource } from './sbi-source.mjs';
import { collectPbiStatus, renderPbiStatus, acceptPbi } from './pbi-status.mjs';
import { writePbiPlan, approvePbiPlan } from './pbi-plan.mjs';
import { postSpecApproval } from './spec-approval.mjs';
import { githubCli } from './planner-github.mjs';
import { git } from './workspace.mjs';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
// The normal flow is planner:sbi → SBI approval → harness:run → review of the PR by Risk. The rest serves CI, recovery and Harness maintenance.
const usage = `Usage:
User-facing:
  pnpm planner:sbi PBI_URL [--provider codex]        PBIをSBI Issueへ分割する（既定はClaude）
  pnpm harness:spec-approve SBI_URL [--decision approve|revoke]
                                                     SBI Issueの仕様（受け入れ要件・Gherkin・範囲・Risk）を承認する（#147）
  pnpm harness:run SBI_URL [--provider codex] [--full]
                                                     承認済み（ready）のSBI Issueから、実装前Gateなしで実装・ローカル検証・AI Review・PR作成まで進める（既定はClaude）
                                                     承認済みSBIで決められない判断が出たときだけ ESCALATED / NEEDS_HUMAN_DECISION で止まる。
                                                     人がSBIを更新・再承認し、新しいrunで再開する
  pnpm harness:approve SBI_URL --phase merge [--decision approve|revoke|request-changes]
                                                     PRを作らないLocal modeのrunをmerge承認する（PRがあるときはGitHub Reviewで承認する）
  pnpm harness:pbi-plan-approve PBI_URL [--decision approve|revoke]
                                                     PBI本文の ## SBI構成（Plannerが書いたSBI集合）を確認して承認する。PBIごとに一度
  pnpm harness:pbi-status PBI_URL [--json]          PBIのSBI・Evidence・受け入れ・blockerを集めてDONE / NOT_DONEと理由を表示する
  pnpm harness:pbi-accept PBI_URL --evidence DIGEST [--decision approve|revoke|request-changes]
                                                     pbi-statusが表示したEvidence digestに対するPBI Human Acceptanceを署名付き台帳へ記録する
  pnpm harness:reverify PR_URL                       mainが進んだPRを、実装を保持したまま最新mainと統合して再検証し、同じPRを更新する
                                                     （PR HEADと最新mainが前回PASSしたrunのままなら何もせずAlready verifiedを表示）
API design (API契約を設計するときだけ):
  OpenAPI SchemaはPlannerが作るSchema SBI（packages/api-schemaだけを変える）として pnpm harness:run SBI_URL で作る
  pnpm api:mock ISSUE_URL [--dynamic] | pnpm api:docs [--port PORT]
Internal/Maintenance (CI・障害復旧・Harness保守用):
  pnpm harness:resume --run RUN_ID | pnpm harness:pr --run RUN_ID | pnpm harness:approve --run RUN_ID --phase merge
  pnpm harness:run --sbi PATH [--provider fake|codex|claude]（Harness自己テスト・fixture用のSBI JSON）
  pnpm harness:impact --base REF|--all | pnpm harness:verify --verifier ID --base REF|--all | pnpm harness:judge --base REF|--all
  pnpm harness:check | pnpm harness:test | pnpm harness:demo [--full] | pnpm harness:push-gate
  pnpm harness:pbi-plan PBI_URL（## SBI構成 が無い既存PBIに、GitHubのSBI Issueから書く）
  pnpm harness:export --run RUN_ID [--out PATH] | pnpm harness:cleanup --run RUN_ID | pnpm planner:api-schema-status ISSUE_URL
  node tools/harness/cli.mjs api-schema ISSUE_URL | node tools/harness/cli.mjs api-schema-approve ISSUE_URL（旧API Schema Planner。内部機能）`;
// What stops the run for a human: a decision the approved SBI cannot settle, or AI Review that has not passed.
const printDecision = run => {
  if (run.escalation?.decision === 'NEEDS_HUMAN_DECISION') console.log(`NEEDS_HUMAN_DECISION (${run.escalation.code}): SBIを更新・再承認し、新しいrunで再開してください`);
  const review = run.iterations?.at(-1)?.semanticReview;
  if (run.merge?.reasons?.includes('ai_review_not_passed')) console.log(`AI Review: ${review?.status ?? 'NOT_RUN'}${review?.adapter === 'fake' ? ' (fake adapter)' : ''}; MERGE_ALLOWEDとautoMergeEligibleにはAI ReviewのPASSが必要です`);
};
const printPullRequest = run => { if (run.pullRequest) console.log(`Pull request: ${run.pullRequest.url} (tested SHA ${run.headSha})`); };
// The generated acceptance reports the verifier matrix leaves for the Completion Judge (#147); unset uses the default directory.
const acceptanceResults = () => process.env.HARNESS_ACCEPTANCE_RESULTS ? { acceptanceResults: resolve(root, process.env.HARNESS_ACCEPTANCE_RESULTS) } : {};
async function printVerifier({ root: workspace = root, base, all, id }) {
  const { impact, result, passed } = await runVerifier({ root: workspace, base, all, id, ...acceptanceResults() });
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
  const allowed = { check: ['--sbi'], demo: ['--sbi', '--full'], run: ['--provider', '--sbi', '--full'], plan: ['--provider'], 'spec-approve': ['--decision'], 'api-schema': ['--provider'], 'api-schema-approve': ['--decision'], 'api-schema-status': [], 'api-mock': ['--dynamic'], 'api-docs': ['--port'], cleanup:['--run'], impact: ['--base', '--all'], verify: ['--base', '--all', '--verifier'], judge: ['--base', '--all', '--trusted'], 'push-gate': [], resume: ['--run'], pr: ['--run'], reverify: [], approve: ['--run', '--phase', '--decision'], export: ['--run','--out'], 'pbi-status': ['--json'], 'pbi-accept': ['--evidence', '--decision'], 'pbi-plan': [], 'pbi-plan-approve': ['--decision'] };
  if (!allowed[command]) throw new Error(usage);
  const options = {};
  const positional = ['plan', 'spec-approve', 'api-schema', 'api-schema-approve', 'api-schema-status', 'api-mock', 'run', 'approve', 'reverify', 'pbi-status', 'pbi-accept', 'pbi-plan', 'pbi-plan-approve'].includes(command) && args.length && !args[0].startsWith('--') ? args.shift() : null;
  for (let i = 0; i < args.length; i += 2) {
    if (['--full', '--dynamic', '--all', '--json', '--trusted'].includes(args[i]) && allowed[command].includes(args[i]) && !options[args[i]]) { options[args[i]]=true; i--; continue; }
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
  } else if (command === 'spec-approve') {
    if (!positional) throw new Error('spec-approve requires an SBI Issue URL: spec-approve https://github.com/<owner>/<repo>/issues/<number>');
    const approval = await postSpecApproval({ issueUrl: positional, decision: options['--decision'] ?? 'approve', github: githubCli });
    console.log(`Spec ${options['--decision'] === 'revoke' ? 'approval revoked' : 'approved'}: spec digest ${approval.digest} (spec-approved label)`);
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
  } else if (command === 'pbi-plan' || command === 'pbi-plan-approve') {
    if (!positional) throw new Error(`${command} requires a PBI URL: ${command} https://github.com/<owner>/<repo>/issues/<number>`);
    if (command === 'pbi-plan') {
      const written = await writePbiPlan({ pbiUrl: positional });
      console.log(`## SBI構成: ${written.plan.sbis.map(s => `${s.id} #${s.number} ${s.kind}`).join(', ')}`);
      console.log(`PBI plan digest: ${written.digest}（確認後: PBIに plan-approved ラベルを付ける）`);
    } else {
      const decision = options['--decision'] || 'approve';
      const approved = await approvePbiPlan({ pbiUrl: positional, decision });
      console.log(`PBI plan ${approved.digest}: ${approved.approved ? 'APPROVED (plan-approved label)' : 'NOT_APPROVED'}`);
    }
  } else if (command === 'pbi-status' || command === 'pbi-accept') {
    if (!positional) throw new Error(`${command} requires a PBI URL: ${command} https://github.com/<owner>/<repo>/issues/<number>`);
    let result;
    if (command === 'pbi-accept') {
      if (!options['--evidence']) throw new Error('pbi-accept requires --evidence DIGEST (the Evidence digest shown by harness:pbi-status)');
      const decision = { approve: 'APPROVE', revoke: 'REVOKE', 'request-changes': 'REQUEST_CHANGES' }[options['--decision'] || 'approve'];
      if (!decision) throw new Error('Unknown PBI acceptance decision');
      const accepted = await acceptPbi({ root, pbiUrl: positional, evidenceDigest: options['--evidence'], decision });
      console.log(`Recorded ${decision} for ${accepted.record.evidenceDigest}`);
      result = accepted.status;
    } else result = await collectPbiStatus({ root, pbiUrl: positional });
    if (options['--json']) console.log(redactText(JSON.stringify(result, null, 2)));
    else for (const line of renderPbiStatus(result)) console.log(redactText(line));
    process.exitCode = result.status === 'DONE' ? 0 : 2;
  } else if (command === 'api-mock') {
    if (!positional) throw new Error('api-mock requires a GitHub Issue URL: api-mock https://github.com/<owner>/<repo>/issues/<number>');
    const mock = await startApiMock({ root, issueUrl: positional, dynamic: options['--dynamic'] === true });
    await waitForApiMock(mock);
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
      await output([`required_verifiers=${JSON.stringify(impact.requiredVerifiers)}`, `full_gate=${impact.fullGate}`, `maestro=${JSON.stringify(impact.maestro)}`, `head_sha=${(await git(root, ['rev-parse', 'HEAD'])).stdout.trim()}`]);
    } else if (command === 'verify') {
      if (!options['--verifier']) throw new Error('verify requires --verifier ID');
      process.exitCode = await printVerifier({ base, all, id: options['--verifier'] }) ? 0 : 1;
    } else if (options['--trusted']) {
      // ADR-0008: this checkout is main; HARNESS_WORKSPACE is the PR head checked out beside it as data, and the pull_request run is the evidence.
      const workspace = process.env.HARNESS_WORKSPACE ? resolve(process.env.HARNESS_WORKSPACE) : '';
      if (!workspace || workspace === resolve(root)) throw new Error('judge --trusted requires HARNESS_WORKSPACE, a PR tree apart from the Harness root');
      if (!base) throw new Error('judge --trusted requires --base REF');
      const judged = await runTrustedJudge({ root, workspace, base, repository: process.env.GITHUB_REPOSITORY, pullNumber: process.env.HARNESS_PULL_REQUEST || undefined,
        headSha: process.env.HARNESS_HEAD_SHA ?? '', baseSha: process.env.HARNESS_BASE_SHA || undefined, log: line => console.log(redactText(line)) });
      if (judged.run) console.log(`Evidence: run ${judged.run.id} attempt ${judged.run.run_attempt} of ${judged.run.path}`);
      if (judged.checks) {
        for (const line of describeImpact(judged.impact)) console.log(redactText(line));
        for (const line of describeSbiSource(judged.source)) console.log(redactText(line));
        for (const c of [...judged.checks, ...judged.security.checks.filter(c => c.required)]) console.log(redactText(`${c.id}: ${c.status}${c.reason ? ` (${c.reason})` : ''}`));
        for (const [job, value] of Object.entries(judged.needs)) console.log(`job ${job}: ${value.result}`);
      }
      const summary = `Completion Judge: ${judged.status}${judged.reasons.length ? ` (${judged.reasons.join('; ')})` : ''}`;
      console.log(redactText(summary));
      await output([`conclusion=${checkConclusion(judged.status)}`, `summary=${redactText(summary).replace(/\s+/g, ' ').slice(0, 60000)}`]);
      // A human review is a result, not a failure of the judge job; publish turns it into a neutral check run.
      process.exitCode = judged.status === 'FAIL' ? 1 : 0;
    } else {
      const needs = JSON.parse(process.env.HARNESS_NEEDS || '{}');
      // Set only on pull_request events; a trusted dependency bot PR is read from GitHub by this number.
      const judged = await runCompletionJudge({ root, base, all, needs, pullNumber: process.env.HARNESS_PULL_REQUEST || undefined, maestroResults: process.env.HARNESS_MAESTRO_RESULTS || undefined, expectedHeadSha: process.env.HARNESS_HEAD_SHA ?? '',
        expectedBaseSha: process.env.HARNESS_BASE_SHA || undefined, ...acceptanceResults() });
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
    const run = await reverifyPullRequest({ root, pullUrl: positional, semanticReviewer: providerAiReviewer() });
    if (run.alreadyVerified) {
      console.log(`Already verified: ${run.pullRequest.url} HEAD ${run.headSha} on ${run.pullRequest.base} ${run.baselineSha} is bound to run ${run.id}. Nothing was run, committed, pushed or updated.`);
      console.log(`Evidence: ${run.runDir}/summary.json`);
      return;
    }
    if (run.reverify?.publish === 'PR_UPDATED') printPullRequest(run); else console.log(`Pull request: ${run.pullRequest.url} (not updated; run ${run.id}: ${run.status})`);
    if (run.reverify?.conflicts?.length) console.log(`Conflicts: ${run.reverify.conflicts.join(', ')}`);
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
    if (options['--phase'] === 'gate') throw new Error('The implementation gate no longer exists (#175): the SBI approval decides the implementation. Use --phase merge for a merge approval');
    if (Boolean(options['--run']) === Boolean(positional) || options['--phase'] !== 'merge') throw new Error('approve requires SBI_URL or --run ID, and --phase merge');
    const decisions = { approve: 'APPROVE', revoke: 'REVOKE', 'request-changes': 'REQUEST_CHANGES' };
    const decision = decisions[options['--decision'] || 'approve'];
    if (!decision) throw new Error('Unknown approval decision');
    const run = await approveRun({ root, runId: options['--run'], issueUrl: positional, purpose: 'merge', decision, semanticReviewer: providerAiReviewer() });
    console.log(`Recorded ${decision}; run ${run.id}: ${run.status}`);
    printPullRequest(run);
    console.log(`Evidence: ${run.runDir}/summary.json`);
    process.exitCode = runExitCode(run);
  } else {
    if (command === 'resume' && !options['--run']) throw new Error('resume requires --run ID');
    const run = command === 'resume' ? await resumeRun({ root, runId: options['--run'], semanticReviewer: providerAiReviewer() })
      : await runHarness({ root, provider: command === 'demo' ? 'fake' : options['--provider'], sbiPath: options['--sbi'], issueUrl: positional, full:options['--full'] === true, publish: command === 'run', semanticReviewer: providerAiReviewer() });
    printPullRequest(run);
    printDecision(run);
    console.log(`Evidence: ${run.runDir}/summary.json`);
    process.exitCode = runExitCode(run);
  }
} catch (error) { console.error(redactText(error.message)); process.exitCode = 1; }
}).catch(() => { console.error('Evidence protection initialization failed'); process.exitCode = 1; });
