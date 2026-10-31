import { securityPassed } from './security-enforcement.mjs';
import { checksPassed } from './verifier.mjs';
export function validHumanApprovals(records, { purpose, headSha, contextDigest }) {
  const latest = new Map();
  for (const a of records) {
    if (a.kind === 'human' && a.purpose === purpose && a.commitSha === headSha && a.contextDigest === contextDigest) latest.set(a.reviewer, a);
  }
  return { approvals: [...latest.values()].filter(a => a.decision === 'APPROVE'), rejected: [...latest.values()].some(a => a.decision === 'REQUEST_CHANGES') };
}
// AI Review (semantic-review) is required at every Risk level (#175). It never counts as a human approval, and the fake adapter of the
// demo never counts for a pull request, the production path.
export function aiReviewPassed(checks, github = null) {
  const review = Array.isArray(checks) ? checks.find(c => c.id === 'semantic-review') : null;
  return review?.required === true && review.status === 'PASS' && !(github && review.adapter === 'fake');
}
// Pure policy evaluation. Authentication of records is the approval adapter's responsibility.
// With a GitHub pull request (PR mode) the merge approval comes only from GitHub Review; local merge records are not counted (ADR-0001).
// humanGate marks a Human Gate risk (AuthN/AuthZ/RLS/PII/Migration/ADR) the approved SBI declared: level 3 and two humans after implementation.
export function mergeDecision({ risk, checks, approvals = [], headSha, contextDigest, humanGate = false, securityVerification, lane, github = null, baseline = null }) {
  const required = ['verification', 'policy-review', 'security', 'completion'];
  const local = validHumanApprovals(approvals, { purpose: 'merge', headSha, contextDigest });
  const valid = github ? (github.reviews?.approvedHumans ?? []).map(login => ({ reviewer: `github:${login}` })) : local.approvals;
  const rejected = github ? github.reviews?.changesRequested === true : local.rejected;
  const pull = github?.pullRequest;
  const checkOk = Array.isArray(checks) && checksPassed(checks.filter(c => c.id !== 'semantic-review')) && required.every(id => checks.some(c => c.id === id && c.required === true && c.status === 'PASS'));
  const effectiveLevel = humanGate ? Math.max(risk.level, 3) : risk.level;
  const requiredApprovals = Math.max(risk.requiredHumanApprovals ?? 0, effectiveLevel === 3 ? 2 : effectiveLevel === 2 ? 1 : 0);
  let decision = 'BLOCKED';
  const reasons = [];
  if (!/^[0-9a-f]{40,64}$/.test(headSha || '') || !contextDigest || ![1, 2, 3].includes(risk.level)) reasons.push('missing_or_invalid_snapshot');
  else if (!checkOk) reasons.push('required_checks_not_passed');
  else if (!aiReviewPassed(checks, github)) reasons.push('ai_review_not_passed');
  else if (!securityPassed(securityVerification) || (securityVerification.headSha && securityVerification.headSha !== headSha)) reasons.push('required_security_checks_not_passed');
  else if (github?.unavailable) reasons.push('github_state_unavailable');
  else if (github && (pull?.state !== 'open' || pull?.merged)) reasons.push('pull_request_not_open');
  // The tested SHA is the merge result only while the base is still the run baseline (ADR-0001).
  else if (github && (!baseline?.sha || pull?.baseRef !== baseline.ref || pull?.baseSha !== baseline.sha || pull?.remoteBaseSha !== baseline.sha)) reasons.push('base_not_baseline');
  else if (github && (pull?.testedShaMatches !== true || pull?.headSha !== headSha)) reasons.push('tested_sha_mismatch');
  else if (github && github.ci?.status !== 'PASS') reasons.push('required_ci_not_passed');
  else if (rejected) { decision = 'REJECTED'; reasons.push(github ? 'github_changes_requested' : 'human_requested_changes'); }
  else if (valid.length < requiredApprovals) { decision = 'WAITING_FOR_HUMAN_REVIEW'; reasons.push('insufficient_human_approvals'); }
  else { decision = 'MERGE_ALLOWED'; reasons.push('all_conditions_satisfied'); }
  return { state: decision, decision, riskLevel: effectiveLevel, headSha, contextDigest, requiredApprovals,
    validApprovals: valid.length, validReviewers: valid.map(a => a.reviewer), approvalSource: github ? 'github-review' : 'local-ledger', reasons,
    autoMergeEligible: lane?.name !== 'prototype' && decision === 'MERGE_ALLOWED' && effectiveLevel === 1 && risk.autoMergeAllowed !== false && !humanGate && checkOk && aiReviewPassed(checks, github) };
}
