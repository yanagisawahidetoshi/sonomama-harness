import { mkdir, writeFile, realpath, readFile, readdir, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from './check.mjs';
import { json, readJson, exists, evidenceText } from './io.mjs';
import { responseSchema, runIdSchema } from './schemas.mjs';
import { runAgent, makePrompt, providerCommand } from './agents/index.mjs';
import { verify, checksPassed } from './verifier.mjs';
import { review } from './reviewer.mjs';
import { judge } from './completion-judge.mjs';
import { humanGate, classifyEscalation, mergeFailure } from './escalation.mjs';
import { assessRisk } from './risk-classifier.mjs';
import { mergeDecision, validHumanApprovals } from './merge-policy.mjs';
import { authenticatedRecords, recordDecision, waitsForIssue } from './human-approvals.mjs';
import { classifySecurity, verifySecurity, combineSecurity, securityPassed } from './security-enforcement.mjs';
import { withEvidenceProtection, redact, redactText, hasSecret, assertSafeInput, isSecretPath } from './evidence-protection.mjs';
import { githubPrCli, githubState, pullRequestBody } from './github-pr.mjs';
import { digest, prepareWorkspace, commitWorkspace, changedFiles, workspaceIntegrity, toolFingerprint, assertWritablePath, workspaceFingerprint, sourceIntegrity, assertWorktreeOwner, git } from './workspace.mjs';
import { saveRun, loadRun, readRunState, runPaths, withRunLock } from './run-store.mjs';
import { classifyLane } from './lanes.mjs';
import { assertState } from './state-machine.mjs';
import { loadSbiIssue, inScope } from './sbi-issue.mjs';
import { snapshotFromIssue, snapshotPath, riskView, snapshotVerified } from './sbi-source.mjs';
import { parseIssueUrl } from './planner.mjs';
import { githubCli } from './planner-github.mjs';
export { check, judge, providerCommand };

function controller(root, summary, quiet) {
  const directory = runPaths(root, summary.id).directory;
  const record = async (status, detail, phase) => {
    summary.status = status;
    summary.events.push({ status, phase, detail, at: new Date().toISOString() });
    if (!quiet) console.log(redactText(`[${summary.id}] ${status}${detail ? `: ${detail}` : ''}`));
    await saveRun(root, summary);
  };
  const transition = async (status, detail = '', phase = 'execution') => {
    assertState(phase === 'implementation-gate' ? 'gate' : phase === 'design-approval' ? 'design' : phase, status);
    if (phase === 'execution') summary.executionStatus = status;
    if (phase === 'merge') summary.merge = { ...summary.merge, state: status, decision: status, autoMergeEligible: status === 'MERGE_ALLOWED' && summary.merge.autoMergeEligible === true };
    await record(status, detail, phase);
  };
  // After Execution DONE an escalation stops only the merge lifecycle; executionStatus stays DONE.
  const escalate = async (reason, code = classifyEscalation(reason)) => {
    const done = summary.executionStatus === 'DONE';
    summary.reason = reason;
    summary.escalation = { code, detail: reason };
    summary.merge = { ...summary.merge, state: 'BLOCKED', decision: 'BLOCKED', autoMergeEligible: false, ...(done ? { failure: { code, retryable: false, detail: reason } } : {}) };
    await json(join(directory, 'escalation.json'), { reason, code, action: '人間が原因を確認して新しいrunを開始してください。mergeは実行しません。' });
    if (done) await record('ESCALATED', reason, 'merge'); else await transition('ESCALATED', reason);
    return summary;
  };
  const defer = async (reason, code) => {
    summary.reason = reason;
    summary.merge = { state: 'RETRYABLE', decision: 'RETRYABLE', autoMergeEligible: false, reasons: ['merge_assessment_failed'], failure: { code, retryable: true, detail: reason } };
    await json(join(directory, 'merge-decision.json'), summary.merge);
    await transition('RETRYABLE', `${code}; 原因を解消してharness:resume --run ${summary.id}で再判定してください`, 'merge');
    return summary;
  };
  return { transition, escalate, defer };
}
function metadata(sbi) {
  return { id: sbi.id, title: sbi.title, description: sbi.description, risks: sbi.risks, acceptanceCriteria: sbi.acceptanceCriteria, securityImpact: sbi.securityImpact, requiredSecurityRules: sbi.requiredSecurityRules, requiredVerifiers: sbi.requiredVerifiers, minimumRiskLevel: sbi.minimumRiskLevel };
}
async function resolveGate(root, summary) {
  if (!summary.gate.required && !summary.designApproval?.required) return true;
  const records = await authenticatedRecords(root, summary.id);
  if (summary.designApproval?.required) {
    const design = validHumanApprovals(records, { purpose:'design-approval', headSha:summary.baselineSha, contextDigest:summary.designApproval.contextDigest });
    summary.designApproval.state = design.rejected ? 'REJECTED' : design.approvals.length ? 'APPROVED' : 'WAITING_FOR_DESIGN_APPROVAL';
    summary.lane.designApproved = summary.designApproval.state === 'APPROVED';
  }
  if (summary.gate.required) {
    const { approvals, rejected } = validHumanApprovals(records, { purpose: 'implementation-gate', headSha: summary.gate.headSha, contextDigest: summary.gate.contextDigest });
    summary.gate.state = rejected ? 'REJECTED' : approvals.length ? 'APPROVED' : 'WAITING_FOR_HUMAN_GATE';
    summary.gate.reviewers = approvals.map(a => a.reviewer);
    summary.gate.approvalState = summary.gate.state === 'WAITING_FOR_HUMAN_GATE' ? 'WAITING_FOR_HUMAN_APPROVAL' : summary.gate.state;
  }
  const { directory } = runPaths(root,summary.id);
  await json(join(directory,'design-approval.json'),summary.designApproval);
  await json(join(directory,'human-gate.json'),summary.gate);
  return (!summary.designApproval?.required || summary.designApproval.state === 'APPROVED')
    && (!summary.gate.required || summary.gate.state === 'APPROVED');
}
// PR mode reads GitHub on every assessment. A read failure blocks; it never reuses an earlier GitHub state or escalates the run.
async function readGitHub(root, summary, inputs, github) {
  if (!summary.pullRequest) return null;
  const [owner, repo] = summary.pullRequest.repository.split('/');
  try {
    return await githubState({ github, root, remote: inputs.config.github.remote, repository: { owner, repo }, pullRequest: summary.pullRequest, headSha: summary.headSha, requiredChecks: inputs.config.github.requiredChecks });
  } catch (error) { return { unavailable: redactText(error.message) }; }
}
// Files as Risk and Security see them. The Run snapshot of an SBI Issue counts by its values only while it is verified now.
async function riskFiles(root, summary, inputs, files) {
  const snapshot = inputs.sbiSnapshot;
  if (!snapshot) return files;
  const check = await snapshotVerified({ workspace: runPaths(root, summary.id).workspace, base: summary.baselineSha, files, snapshot, config: inputs.config });
  summary.snapshotVerification = { ...check, headSha: summary.headSha, at: new Date().toISOString() };
  await json(join(runPaths(root, summary.id).directory, 'sbi-source.json'), summary.snapshotVerification);
  return riskView(files, { snapshot, verified: check.verified });
}
async function assessMerge(root, summary, inputs, quiet, github = githubPrCli) {
  const { directory, workspace } = runPaths(root, summary.id);
  const { transition } = controller(root, summary, quiet);
  await sourceIntegrity(root, summary.baselineSha);
  await assertWorktreeOwner(root, workspace, summary.baselineSha);
  await workspaceIntegrity(workspace, summary.headSha);
  if (await workspaceFingerprint(workspace) !== summary.workspaceDigest) throw new Error('workspace snapshot changed');
  await transition('RISK_ASSESSING', '変更差分とRulesを評価', 'merge');
  const files = await changedFiles(workspace, summary.baselineSha, summary.headSha);
  await json(join(directory, 'changes.json'), { baselineSha: summary.baselineSha, headSha: summary.headSha, files });
  const last = summary.iterations.at(-1);
  const assessed = await riskFiles(root, summary, inputs, files);
  // Each assessment starts from the execution's assessment, so a snapshot verified earlier but not now cannot keep a lower level.
  summary.securityAssessment = combineSecurity(summary.executionSecurityAssessment ?? summary.securityAssessment, classifySecurity({ files: assessed, sbi: inputs.sbi }, inputs.securityPolicy));
  await json(join(directory, 'security-assessment.json'), { ...summary.securityAssessment, headSha: summary.headSha });
  summary.risk = assessRisk({ files: assessed, metadata: metadata(inputs.sbi), humanGate: summary.gate.required, aiRisk: last.semanticReview?.riskLevel ?? null, securityAssessment: summary.securityAssessment, lane:summary.lane }, inputs.riskPolicy);
  await json(join(directory, 'risk-assessment.json'), { ...summary.risk, phase: 'post-execution', headSha: summary.headSha, inputsDigest: summary.inputsDigest });
  const securityVerification = last.securityVerification;
  if (summary.securityAssessment.requiredVerifiers.some(id => !securityVerification.requiredVerifiers.includes(id))) throw new Error('Required security checks changed; re-verification required');
  const checks = [
    { id: 'verification', required: true, status: checksPassed(last.verification.checks) && last.verification.status === 'PASS' ? 'PASS' : 'FAIL' },
    { id: 'policy-review', required: true, status: last.review.status },
    last.security,
    { id: 'completion', required: true, status: last.completion ? 'PASS' : 'FAIL' },
    ...(inputs.config.semanticReview.enabled ? [{ id: 'semantic-review', required: true, status: last.semanticReview.status }] : []),
  ];
  const contextDigest = digest({ headSha: summary.headSha, workspaceDigest: summary.workspaceDigest, inputsDigest: summary.inputsDigest, risk: summary.risk, checks, iterations: summary.iterations });
  const records = await authenticatedRecords(root, summary.id);
  const gateApproved = await resolveGate(root, summary);
  const githubPr = await readGitHub(root, summary, inputs, github);
  if (githubPr) await json(join(directory, 'github-state.json'), redact({ ...githubPr, readAt: new Date().toISOString(), source: 'GitHub API projection; GitHub is the source of truth' }));
  summary.merge = mergeDecision({ risk: summary.risk, checks, approvals: records, headSha: summary.headSha, contextDigest,
    humanGate: summary.gate.required, gateApproved, securityVerification, semanticEnabled: inputs.config.semanticReview.enabled, lane:summary.lane, github: githubPr,
    baseline: summary.pullRequest ? { ref: summary.pullRequest.base, sha: summary.baselineSha } : null });
  await json(join(directory, 'approvals.json'), { headSha: summary.headSha, approvals: records, source: 'authenticated local ledger; this file is not an authority' });
  await json(join(directory, 'merge-decision.json'), { ...summary.merge, checks });
  summary.reason = summary.merge.reasons.join(', ');
  await transition(summary.merge.decision, `LEVEL ${summary.risk.level}; human approvals ${summary.merge.validApprovals}/${summary.merge.requiredApprovals} (${summary.merge.approvalSource}); autoMergeEligible=${summary.merge.autoMergeEligible}`, 'merge');
  return summary;
}
// Execution success and merge assessment are separate phases. A failure here never rewrites executionStatus.
function mergeFailed(root, summary, quiet, error) {
  const { escalate, defer } = controller(root, summary, quiet);
  const failure = mergeFailure(error);
  return failure.retryable ? defer(error.message, failure.code) : escalate(error.message, failure.code);
}
async function settleMerge(root, summary, inputs, quiet, github) {
  try { return await assessMerge(root, summary, inputs, quiet, github); }
  catch (error) { return mergeFailed(root, summary, quiet, error); }
}
async function executeLoop({ root, summary, inputs, quiet, agent = runAgent, reviewer = review, semanticReviewer }) {
  const { config, rules, sbi, riskPolicy, securityPolicy } = inputs;
  const { directory, workspace } = runPaths(root, summary.id);
  const { transition, escalate } = controller(root, summary, quiet);
  if (!await resolveGate(root, summary)) {
    summary.reason = summary.gate.reason || 'Human Gate: Design Approval for prototype promotion';
    await json(join(directory, 'design-approval.json'), summary.designApproval);
    await json(join(directory, 'human-gate.json'), summary.gate);
    const designWaiting = summary.designApproval?.required && summary.designApproval.state !== 'APPROVED';
    await transition(designWaiting ? summary.designApproval.state : summary.gate.state, summary.reason, designWaiting ? 'design-approval' : 'implementation-gate');
    return summary;
  }
  await json(join(directory, 'design-approval.json'), summary.designApproval);
  await json(join(directory, 'human-gate.json'), summary.gate);
  let feedback = null;
  for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
    const iterDir = join(directory, `iteration-${iteration}`);
    await mkdir(iterDir);
    const result = { iteration, agent: null, verification: null, security: null, securityVerification: null, gateApproved: false, review: null, semanticReview: { enabled: config.semanticReview.enabled, status: 'NOT_RUN' }, completion: false };
    summary.iterations.push(result);
    await evidenceText(join(iterDir, 'agent.log'), 'Agent started\n');
    await evidenceText(join(iterDir, 'verify.log'), 'NOT_RUN\n');
    const record = async () => { await json(join(iterDir, 'result.json'), result); await saveRun(root, summary); };
    await record();
    try {
      await workspaceIntegrity(workspace, summary.headSha);
      await transition('IMPLEMENTING', `iteration ${iteration}`);
      const prompt = await makePrompt({ root, sbi, workspace, feedback, rules });
      await evidenceText(join(iterDir, 'prompt.txt'), prompt);
      const response = responseSchema.parse(await agent({ provider: summary.provider, iteration, prompt, directory: iterDir, workspace, timeoutMs: config.timeoutMs }));
      await workspaceIntegrity(workspace, summary.headSha); // Reject a CLI that edited files directly.
      await evidenceText(join(iterDir, 'agent.log'), JSON.stringify(redact(response), null, 2) + '\n');
      if (response.escalation) { result.agent = { status: 'ESCALATED', reason: response.escalation }; await record(); return escalate(response.escalation, 'AGENT_ESCALATION'); }
      if (response.files.some(file => hasSecret(file.content))) {
        result.security = { id: 'security', required: true, status: 'FAIL', reasons: ['credential value rejected before writing'] };
        result.securityVerification = { status: 'FAIL', requiredVerifiers: ['secret-scan'], checks: [{id:'secret-scan',verifier:'secret-scan',required:true,status:'FAIL'}], violations: ['credential_proposal'] };
        await json(join(directory, 'security-verification.json'), result.securityVerification);
        await record(); return escalate('Secret/Credential detected in agent response; rejected before workspace, commit, or raw Evidence write', 'SECRET_PROPOSAL');
      }
      for (const file of response.files) {
        assertWritablePath(file.path);
        if (!inScope(sbi, file.path)) throw new Error(`scope/path violation: ${file.path}`);
        if (Buffer.byteLength(file.content) > rules.maxFileBytes) throw new Error(`scope file size exceeded: ${file.path}`);
        let parent = workspace;
        for (const segment of file.path.split('/')) {
          parent = join(parent, segment);
          if (await exists(parent) && (await lstat(parent)).isSymbolicLink()) throw new Error(`scope symlink: ${file.path}`);
        }
      }
      if (new Set(response.files.map(f => f.path)).size !== response.files.length) throw new Error('scope duplicate path');
      const proposedFiles = response.files.map(f => ({ path: f.path, status: 'M', added: f.content, deleted: '', binary: false }));
      const proposedSecurity = classifySecurity({files:proposedFiles,sbi},securityPolicy);
      const newRules = proposedSecurity.matchedRules.filter(id => !summary.securityAssessment.matchedRules.includes(id));
      if (newRules.length) {
        await json(join(iterDir,'proposed-security.json'),proposedSecurity);
        await record(); return escalate('New security scope detected before applying code; update SBI and obtain a new Human Gate', 'NEW_SECURITY_SCOPE');
      }
      const proposed = assessRisk({ files: proposedFiles, metadata: metadata(sbi), humanGate: summary.gate.required, securityAssessment: proposedSecurity, lane:classifyLane(proposedFiles,sbi,inputs.lanePolicy) }, riskPolicy);
      if (proposed.level === 3 && !summary.gate.required) {
        await json(join(iterDir, 'proposed-risk.json'), proposed);
        await record(); return escalate('New high risk detected before applying code; declare the risk in SBI and obtain an implementation gate in a new run', 'NEW_HIGH_RISK');
      }
      for (const file of response.files) { const path = join(workspace, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.content); }
      // A run from an SBI Issue commits its snapshot and links itself in the trailers, as the CI SBI source check requires.
      const snapshot = inputs.sbiSnapshot;
      if (snapshot) { const path = join(workspace, snapshotPath(snapshot)); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`); }
      const trailers = snapshot ? `\n\nHarness-Run: ${summary.id}\nSBI-Issue: ${snapshot.source.url}` : '';
      summary.headSha = await commitWorkspace(workspace, `SBI ${sbi.id}, iteration ${iteration}${trailers}`, sbi.allowedFiles);
      summary.workspaceDigest = await workspaceFingerprint(workspace);
      result.headSha = summary.headSha;
      result.agent = { status: 'PASS', files: response.files.map(f => f.path) };
      await transition('VERIFYING', `iteration ${iteration}`);
      const files = await changedFiles(workspace,summary.baselineSha,summary.headSha);
      const actualLane = classifyLane(files,sbi,inputs.lanePolicy);
      if (summary.lane.name === 'prototype' && actualLane.name !== 'prototype') throw new Error('Prototype scope escalated; declare production/security scope in a new SBI');
      const generalIds = new Set(config.verifiers.map(v=>v.id));
      const securityIds = new Set([...securityPolicy.verifiers,...config.securityVerifiers].map(v=>v.id));
      result.verification = redact(await verify({ root, workspace, config,
        sbi:{...sbi,requiredVerifiers:sbi.requiredVerifiers.filter(id=>!securityIds.has(id) || generalIds.has(id))}, files,
        lane:summary.lane, full:summary.fullVerification,
        requiredVerifiers:summary.securityAssessment.requiredVerifiers.filter(id=>generalIds.has(id)) }));
      await json(join(iterDir,'verifier-selection.json'),result.verification.checks.map(({id,selectionReasons,required,status})=>({id,selectionReasons,required,status})));
      summary.securityAssessment = combineSecurity(summary.securityAssessment, classifySecurity({files:await riskFiles(root,summary,inputs,files),sbi},securityPolicy));
      summary.executionSecurityAssessment = summary.securityAssessment;
      result.securityVerification = redact(await verifySecurity({ workspace, sbi, assessment: summary.securityAssessment, policy: securityPolicy, config, headSha:summary.headSha, verification:result.verification }));
      result.security = { id:'security',required:true,status:securityPassed(result.securityVerification)?'PASS':'FAIL' };
      result.gateApproved = await resolveGate(root,summary);
      await json(join(directory,'security-assessment.json'),{...summary.securityAssessment,headSha:summary.headSha});
      await json(join(directory,'security-verification.json'),result.securityVerification);
      await json(join(iterDir,'security-verification.json'),result.securityVerification);
      await json(join(iterDir, 'security.json'), result.security);
      await evidenceText(join(iterDir, 'verify.log'), JSON.stringify(result.verification, null, 2) + '\n');
      if (result.securityVerification.checks.some(c=>c.required&&c.status==='NOT_CONFIGURED')) {
        await record(); return escalate('Required Security Verifier is NOT_CONFIGURED; configure it before starting a new run', 'SECURITY_VERIFIER_NOT_CONFIGURED');
      }
      if (!quiet) for (const c of result.verification.checks) console.log(`  ${c.id}: ${c.status}${c.reason ? ` (${c.reason})` : ''}`);
      if (result.verification.status === 'PASS' && result.security.status === 'PASS') {
        await transition('REVIEWING', `iteration ${iteration}`);
        result.review = redact(await reviewer({ root, workspace, sbi, rules, verification: result.verification, files }));
        await json(join(iterDir, 'review.json'), result.review);
        if (config.semanticReview.enabled) {
          result.semanticReview = semanticReviewer ? { ...await semanticReviewer({ root, workspace, sbi, verification: result.verification }), enabled: true } : { enabled: true, status: 'FAIL', reasons: ['semantic reviewer is enabled but no trusted adapter is configured'] };
        } else result.semanticReview = { enabled: false, status: 'SKIP', reason: 'disabled by configuration' };
        result.semanticReview = redact(result.semanticReview);
        await json(join(iterDir, 'semantic-review.json'), result.semanticReview);
        await transition('JUDGING', `iteration ${iteration}`);
        result.completion = judge(result, sbi);
      }
      // Verifiers must not mutate the approved source tree or switch HEAD.
      await workspaceIntegrity(workspace, summary.headSha);
      if (await workspaceFingerprint(workspace) !== summary.workspaceDigest) throw new Error('Verifier mutated the source snapshot');
      await record();
      if (result.completion) {
        summary.executionFinishedAt = new Date().toISOString();
        summary.consecutiveFailures = 0;
        await transition('DONE', 'Execution: Verifier → Policy Reviewer → Completion Judge passed');
        return await settleMerge(root, summary, inputs, quiet);
      }
      feedback = { verification: result.verification, security: result.security, securityVerification: result.securityVerification, review: result.review, semanticReview: result.semanticReview };
    } catch (error) {
      result.error = redactText(error.message);
      await evidenceText(join(iterDir, 'agent.log'), `\nERROR: ${error.stack}\n`, true);
      await record(); return escalate(`Agent/runtime error: ${error.message}`, classifyEscalation(error.message));
    }
    summary.consecutiveFailures++;
    await record(); await transition('FAILED', `iteration ${iteration}; consecutive=${summary.consecutiveFailures}`);
    if (summary.consecutiveFailures >= config.maxConsecutiveFailures) {
      // Retrying cannot repair a missing verifier, so count it separately from ordinary repeated failures.
      const notConfigured = result.verification?.checks?.some(c => c.required && c.status === 'NOT_CONFIGURED');
      return escalate(`${summary.consecutiveFailures} consecutive failures; 人間による原因確認が必要です。`, notConfigured ? 'VERIFIER_NOT_CONFIGURED' : 'CONSECUTIVE_FAILURE');
    }
  }
  return escalate(`iteration limit (${config.maxIterations}) reached`, 'ITERATION_LIMIT');
}
async function runProtected({ root, provider, sbiPath, issueUrl, quiet = false, agent = runAgent, reviewer = review, semanticReviewer, full = false, publish = false, issues = githubCli }) {
  root = await realpath(root);
  if (issueUrl && sbiPath) throw new Error('Give either an SBI Issue URL or --sbi, not both');
  // The Issue is read and validated before any run directory or worktree exists.
  const sbiIssue = issueUrl ? parseIssueUrl(issueUrl).number : null;
  const source = issueUrl ? await loadSbiIssue({ issueUrl, config: (await check(root, undefined, undefined, { sbiIssue })).config, github: issues }) : null;
  const { config, rules, sbi, riskPolicy, securityPolicy, humanGates, securityDocuments, lanePolicy } = await check(root, sbiPath, source?.sbi, { sbiIssue });
  assertSafeInput({config,rules,sbi,riskPolicy,securityPolicy,humanGates,securityDocuments,lanePolicy});
  provider ??= config.provider;
  if (!['fake', 'codex', 'claude'].includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const { directory, workspace } = runPaths(root, id);
  await mkdir(directory, { recursive: true });
  const baselineSha = await prepareWorkspace(root, workspace, sbi);
  const sbiSnapshot = source ? snapshotFromIssue({ ref: source.ref, issue: source.issue, runId: id, sbi }) : undefined;
  if (sbiSnapshot) await json(join(directory, 'sbi-snapshot.json'), sbiSnapshot);
  const inputs = { config, rules, sbi, riskPolicy, securityPolicy, humanGates, securityDocuments, lanePolicy, sbiSnapshot, toolFingerprint: await toolFingerprint(root), skill: await readFile(join(root, '.harness/skills/implement.md'), 'utf8') };
  const summary = { id, runDir: `.harness/runs/${id}`, sbi: sbi.id, sbiPath: source ? null : sbiPath || config.sbi, provider,
    ...(source ? { sbiIssue: sbiSnapshot.source } : {}),
    // harness:run opens the PR itself once execution is DONE, but only for an SBI it was given. The fake provider (harness:demo)
    // and the configured sample SBI never publish.
    publish: publish === true && provider !== 'fake' && Boolean(sbiPath || source), fullVerification:full, status: 'PENDING', executionStatus: 'PENDING', reason: null, consecutiveFailures: 0, iterations: [], events: [],
    baselineSha, headSha: baselineSha, workspaceDigest: await workspaceFingerprint(workspace), inputsDigest: digest(inputs), gate: { required: false, state: 'NOT_REQUIRED' },
    merge: { state: 'NOT_ASSESSED', autoMergeEligible: false }, startedAt: new Date().toISOString() };
  await json(join(directory, 'inputs.json'), inputs);
  const { transition, escalate } = controller(root, summary, quiet);
  await transition('PENDING', sbi.title);
  if (sbi.ambiguous || sbi.requiresDesignDecision) return escalate(humanGate(sbi, rules), sbi.ambiguous ? 'SPEC_AMBIGUOUS' : 'DESIGN_DECISION_REQUIRED');
  const excludedSources = await readJson(join(directory,'workspace-exclusions.json'));
  const preflightFiles = [...await Promise.all(sbi.allowedFiles.map(async path => {
    let added = ''; try { added = await readFile(join(workspace,path),'utf8'); } catch(e) { if(e.code!=='ENOENT') throw e; }
    return {path,status:'M',binary:false,added,excludedSecret:excludedSources.some(f=>f.path===path)};
  })), ...sbi.allowedDirs.map(path => ({path,status:'M',binary:false,added:'',excludedSecret:false}))];
  summary.lane = classifyLane(preflightFiles,sbi,lanePolicy);
  summary.designApproval = {required:summary.lane.requiresDesignApproval,state:summary.lane.requiresDesignApproval?'WAITING_FOR_DESIGN_APPROVAL':'NOT_REQUIRED',contextDigest:digest({inputsDigest:summary.inputsDigest,baselineSha,promotion:sbi.promotion || null})};
  await json(join(directory,'lane-assessment.json'),summary.lane);
  summary.securityAssessment = classifySecurity({files:preflightFiles,sbi},securityPolicy);
  await json(join(directory,'security-assessment.json'),{...summary.securityAssessment,phase:'preflight',headSha:baselineSha});
  await json(join(directory,'security-verification.json'),{status:'NOT_RUN',requiredVerifiers:summary.securityAssessment.requiredVerifiers,checks:[],violations:[]});
  const gateReason = humanGate(sbi, rules) || (summary.securityAssessment.requiresPreImplementationGate ? 'Human Gate: Security rule requires approval before implementation' : null);
  const preflight = assessRisk({ files: preflightFiles, metadata: metadata(sbi), humanGate: Boolean(gateReason), securityAssessment:summary.securityAssessment, lane:summary.lane }, riskPolicy);
  summary.riskPreflight = preflight;
  if (gateReason || preflight.level === 3) {
    summary.gate = { required: true, state: 'WAITING_FOR_HUMAN_GATE', approvalState:'WAITING_FOR_HUMAN_APPROVAL', reason: gateReason || (summary.designApproval.required ? 'Human Gate: Design Approval for prototype promotion' : null) || `Human Gate: ${preflight.reasons.join(', ')}`,
      headSha: baselineSha, contextDigest: digest({ inputsDigest: summary.inputsDigest, baselineSha, allowedFiles: sbi.allowedFiles, allowedDirs: sbi.allowedDirs, reasons: preflight.reasons, securityAssessment:summary.securityAssessment }) };
    summary.reason = summary.gate.reason || 'Human Gate: Design Approval for prototype promotion';
    await json(join(directory, 'risk-preflight.json'), preflight);
  }
  await json(join(directory, 'design-approval.json'), summary.designApproval);
  await json(join(directory, 'risk-assessment.json'), { ...preflight, phase: 'preflight', headSha: baselineSha });
  await json(join(directory, 'approvals.json'), { headSha: baselineSha, approvals: [], source: 'authenticated local ledger' });
  await json(join(directory, 'merge-decision.json'), summary.merge);
  return withRunLock(root, id, () => executeLoop({ root, summary, inputs, quiet, agent, reviewer, semanticReviewer }));
}
async function resumeProtected({ root, runId, quiet = false, agent = runAgent, reviewer = review, semanticReviewer, github = githubPrCli }) {
  root = await realpath(root);
  return withRunLock(root, runId, async () => {
    const stored = await readRunState(root, runId);
    // An escalated merge assessment is final even if its cause disappears; only a new run re-verifies.
    if (stored.executionStatus === 'DONE' && stored.status === 'ESCALATED') return stored;
    let summary;
    try {
      const loaded = await loadRun(root, runId);
      summary = loaded.summary;
      if (summary.executionStatus === 'DONE') return await settleMerge(root, summary, loaded.inputs, quiet, github);
      if (summary.executionStatus !== 'PENDING' || summary.iterations.length) throw new Error('Only an unstarted implementation gate or completed execution can resume; start a new run');
      return await executeLoop({ root, summary, inputs: loaded.inputs, quiet, agent, reviewer, semanticReviewer });
    } catch (error) {
      summary ??= stored;
      if (summary.executionStatus === 'DONE') return mergeFailed(root, summary, quiet, error);
      return controller(root, summary, quiet).escalate(error.message);
    }
  });
}

// Publishes exactly the tested commit as harness/<run-id> and binds the run to that pull request. Never force-pushes, never merges.
async function publishProtected({ root, runId, quiet = false, github = githubPrCli }) {
  await withRunLock(root, runId, async () => {
    const { summary, inputs } = await loadRun(root, runId);
    if (summary.executionStatus !== 'DONE' || summary.status === 'ESCALATED') throw new Error(`Execution must be DONE and not ESCALATED before opening a pull request (now ${summary.executionStatus}/${summary.status})`);
    const { workspace } = runPaths(root, runId);
    await workspaceIntegrity(workspace, summary.headSha);
    const { remote, base } = inputs.config.github;
    const repository = await github.repository(root, remote);
    if (summary.pullRequest && summary.pullRequest.repository !== repository.name) throw new Error(`run is bound to ${summary.pullRequest.repository}, not ${repository.name}`);
    await github.assertBaseIsBaseline(root, { remote, base, baselineSha: summary.baselineSha });
    const files = await changedFiles(workspace, summary.baselineSha, summary.headSha);
    if (files.some(f => isSecretPath(f.path) || hasSecret(f.added))) throw new Error('changed files contain sensitive material; refusing to push');
    const body = pullRequestBody({ summary, sbi: inputs.sbi });
    if (hasSecret(body)) throw new Error('pull request body contains sensitive material; refusing to publish');
    const branch = `harness/${runId}`;
    const open = await github.findOpenPull(repository, branch);
    if (open && open.base.ref !== base) throw new Error(`${branch} のPR #${open.number} は${open.base.ref}向けです。${base}向けとして再利用しません`);
    const remoteHead = await github.remoteBranchSha(root, remote, branch);
    if (remoteHead && remoteHead !== summary.headSha) throw new Error(`${branch} は既に別のcommit ${remoteHead.slice(0, 12)} を指しています。force pushしません`);
    if (!remoteHead) await github.push(root, remote, summary.headSha, branch);
    const pull = open ?? await github.createPull(repository, { title: `[Harness] ${inputs.sbi.id}: ${inputs.sbi.title}`, head: branch, base, body, draft: false });
    summary.pullRequest = { number: pull.number, url: pull.html_url, branch, base, repository: repository.name };
    summary.events.push({ status: summary.status, phase: 'pull-request', detail: `${pull.html_url} (${summary.headSha})`, at: new Date().toISOString() });
    await saveRun(root, summary);
  });
  return resumeProtected({ root, runId, quiet, github });
}

// Only a run started to publish, whose execution is DONE and which has no PR yet, is pushed. A FAIL or a waiting gate never opens a PR.
async function continueToPullRequest(options, summary) {
  if (!summary.publish || summary.executionStatus !== 'DONE' || summary.pullRequest) return summary;
  try { return await publishProtected({ root: options.root, runId: summary.id, quiet: options.quiet, github: options.github }); }
  catch (error) { error.message = `run ${summary.id}: PR not opened: ${error.message}（復旧: pnpm harness:pr --run ${summary.id}）`; throw error; }
}
export async function runHarness(options) {
  const root = await realpath(options.root);
  return withEvidenceProtection(root, async () => continueToPullRequest({...options,root}, await runProtected({...options,root})), { extensions: options.redactionExtensions || [] });
}
// Exit code of harness:run / approve / resume / pr / demo. 0: the run stopped where a human or GitHub CI takes over
// (PR opened and waiting for CI or Review, MERGE_ALLOWED, a gate the Risk requires, or a DONE run that never publishes). 2: the run failed or needs recovery.
// A run that could not open its PR throws, and the CLI exits 1.
export function runExitCode(run) {
  if (run.status === 'MERGE_ALLOWED') return 0;
  if (run.executionStatus === 'PENDING') return run.gate?.state === 'WAITING_FOR_HUMAN_GATE' || run.designApproval?.state === 'WAITING_FOR_DESIGN_APPROVAL' ? 0 : 2;
  if (run.executionStatus !== 'DONE' || (run.publish && !run.pullRequest)) return 2;
  const waitingForCi = Boolean(run.pullRequest) && run.status === 'BLOCKED' && run.merge?.reasons?.length > 0 && run.merge.reasons.every(r => r === 'required_ci_not_passed');
  return run.status === 'WAITING_FOR_HUMAN_REVIEW' || waitingForCi ? 0 : 2;
}
// An SBI Issue URL names the run that waits for this decision. More than one candidate is never guessed.
// Candidates come from .harness/runs/<id>/summary.json, the run state loadRun verifies; .harness/state/runs is a projection and is never read here.
async function waitingRun(root, url, purpose) {
  const waiting = [];
  for (const name of await readdir(join(root, '.harness/runs'))) {
    if (!runIdSchema.safeParse(name).success) continue;
    // Planner and API Schema directories have their own summary.json; only a run summary for this Issue matches.
    let summary;
    try { summary = await readJson(runPaths(root, name).summary); } catch { continue; }
    if (summary?.id === name && waitsForIssue(summary, url, purpose)) waiting.push(name);
  }
  if (waiting.length !== 1) throw new Error(`${url} を待っているrunが${waiting.length}件あります${waiting.length ? `（${waiting.join(', ')}）。--run RUN_ID で指定してください` : ''}`);
  return waiting[0];
}
// harness:approve records the decision through the trusted identity adapter, then continues the run as harness:resume and harness:pr would.
export async function approveRun(options) {
  const root = await realpath(options.root);
  return withEvidenceProtection(root, async () => {
    const issueUrl = options.runId ? null : parseIssueUrl(options.issueUrl).url;
    const runId = options.runId ?? await waitingRun(root, issueUrl, options.purpose);
    await recordDecision({ root, runId, purpose: options.purpose, decision: options.decision, identityProvider: options.identityProvider, issueUrl });
    return continueToPullRequest({...options,root,runId}, await resumeProtected({...options,root,runId}));
  }, { extensions: options.redactionExtensions || [] });
}
export async function openPullRequest(options) {
  const root = await realpath(options.root);
  return withEvidenceProtection(root, () => publishProtected({...options,root}), { extensions: options.redactionExtensions || [] });
}
export async function resumeRun(options) {
  const root = await realpath(options.root);
  return withEvidenceProtection(root, async () => continueToPullRequest({...options,root}, await resumeProtected({...options,root})), { extensions: options.redactionExtensions || [] });
}

// Explicit cleanup keeps evidence and the reachable run ref. Dirty worktrees are never forced away.
export async function cleanupRun({root,runId}) {
  root = await realpath(root);
  return withRunLock(root,runId,async()=>{
    const paths = runPaths(root,runId);
    const summary = await readRunState(root, runId);
    if (summary.cleanedAt) throw new Error('Invalid or already cleaned run');
    await assertWorktreeOwner(root,paths.workspace,summary.baselineSha);
    await workspaceIntegrity(paths.workspace,summary.headSha);
    if (await workspaceFingerprint(paths.workspace) !== summary.workspaceDigest) throw new Error('workspace snapshot changed');
    const ref = (await git(root,['rev-parse',`refs/harness/runs/${runId}`],true)).stdout.trim();
    if (ref && ref !== summary.headSha) throw new Error('run ref changed');
    await git(root,['update-ref',`refs/harness/runs/${runId}`,summary.headSha]);
    await git(root,['worktree','remove',paths.workspace]);
    summary.cleanedAt=new Date().toISOString();
    summary.merge={...summary.merge,state:'BLOCKED',decision:'BLOCKED',autoMergeEligible:false,reasons:['workspace_cleaned']};
    await saveRun(root,summary);
    return summary;
  });
}
