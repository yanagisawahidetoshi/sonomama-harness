import { securityPassed } from './security-enforcement.mjs';
import { checksPassed } from './verifier.mjs';
export function validHumanApprovals(records, { purpose, headSha, contextDigest }) {
  const latest = new Map();
  for (const a of records) {
    if (a.kind === 'human' && a.purpose === purpose && a.commitSha === headSha && a.contextDigest === contextDigest) latest.set(a.reviewer, a);
  }
  return { approvals: [...latest.values()].filter(a => a.decision === 'APPROVE'), rejected: [...latest.values()].some(a => a.decision === 'REQUEST_CHANGES') };
}
// Pure policy evaluation. Authentication of records is the approval adapter's responsibility.
export function mergeDecision({ risk, checks, approvals = [], headSha, contextDigest, humanGate = false, gateApproved = false, semanticEnabled = false, securityVerification, lane }) {
  const required = ['verification', 'policy-review', 'security', 'completion', ...(semanticEnabled ? ['semantic-review'] : [])];
  const { approvals: valid, rejected } = validHumanApprovals(approvals, { purpose: 'merge', headSha, contextDigest });
  const checkOk = Array.isArray(checks) && checksPassed(checks) && required.every(id => checks.some(c => c.id === id && c.required === true && c.status === 'PASS'));
  const effectiveLevel = humanGate ? Math.max(risk.level, 3) : risk.level;
  const requiredApprovals = Math.max(risk.requiredHumanApprovals ?? 0, effectiveLevel === 3 ? 2 : effectiveLevel === 2 ? 1 : 0);
  let decision = 'BLOCKED';
  const reasons = [];
  if (!/^[0-9a-f]{40,64}$/.test(headSha || '') || !contextDigest || ![1, 2, 3].includes(risk.level)) reasons.push('missing_or_invalid_snapshot');
  else if (lane?.requiresDesignApproval && !lane.designApproved) { decision = 'WAITING_FOR_DESIGN_APPROVAL'; reasons.push('design_approval_not_approved'); }
  else if (humanGate && !gateApproved) { decision = 'WAITING_FOR_HUMAN_GATE'; reasons.push('implementation_gate_not_approved'); }
  else if (!checkOk) reasons.push('required_checks_not_passed');
  else if (!securityPassed(securityVerification) || (securityVerification.headSha && securityVerification.headSha !== headSha)) reasons.push('required_security_checks_not_passed');
  else if (rejected) { decision = 'REJECTED'; reasons.push('human_requested_changes'); }
  else if (valid.length < requiredApprovals) { decision = 'WAITING_FOR_HUMAN_REVIEW'; reasons.push('insufficient_human_approvals'); }
  else { decision = 'MERGE_ALLOWED'; reasons.push('all_conditions_satisfied'); }
  return { state: decision, decision, riskLevel: effectiveLevel, headSha, contextDigest, requiredApprovals,
    validApprovals: valid.length, validReviewers: valid.map(a => a.reviewer), reasons,
    autoMergeEligible: lane?.name !== 'prototype' && decision === 'MERGE_ALLOWED' && effectiveLevel === 1 && risk.autoMergeAllowed !== false && !humanGate && checkOk };
}
