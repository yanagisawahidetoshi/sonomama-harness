// Machine-countable stop reasons for Health Metrics. Human-facing reason text is kept separately.
export const escalationCodes = Object.freeze(['SPEC_AMBIGUOUS', 'DESIGN_DECISION_REQUIRED', 'AGENT_ESCALATION', 'SECRET_PROPOSAL', 'NEW_SECURITY_SCOPE', 'NEW_HIGH_RISK',
  'VERIFIER_NOT_CONFIGURED', 'SECURITY_VERIFIER_NOT_CONFIGURED', 'SCOPE_VIOLATION', 'LANE_ESCALATION', 'ITERATION_LIMIT', 'CONSECUTIVE_FAILURE',
  'SOURCE_DIRTY', 'SOURCE_CHANGED', 'WORKSPACE_CHANGED', 'APPROVAL_INVALID', 'SECURITY_CHECKS_CHANGED', 'REVERIFY_CONFLICT', 'UNKNOWN']);
// A decision the approved SBI cannot settle (#175): the human decides, updates the SBI, approves it again and starts a new run.
// The others are failures a human investigates (environment, configuration, tampering, repeated failures).
const humanDecisionCodes = new Set(['SPEC_AMBIGUOUS', 'DESIGN_DECISION_REQUIRED', 'AGENT_ESCALATION', 'NEW_SECURITY_SCOPE', 'NEW_HIGH_RISK', 'SCOPE_VIOLATION', 'LANE_ESCALATION']);
export const needsHumanDecision = code => humanDecisionCodes.has(code);
export function classifyEscalation(message) {
  const text = String(message ?? '');
  if (/^scope[ /]|^trusted test path is reserved/.test(text)) return 'SCOPE_VIOLATION';
  if (/^Prototype scope escalated/.test(text)) return 'LANE_ESCALATION';
  if (/^HEAD\/snapshot changed|^workspace snapshot changed|^Verifier mutated|not an owned Git worktree|^Run workspace was cleaned/.test(text)) return 'WORKSPACE_CHANGED';
  if (/^Source must be clean|^input snapshot changed|snapshot changed; start a new run|^trusted tool\/skill snapshot changed/.test(text)) return 'SOURCE_CHANGED';
  if (/signature invalid/.test(text)) return 'APPROVAL_INVALID';
  if (/^Required security checks changed/.test(text)) return 'SECURITY_CHECKS_CHANGED';
  return 'UNKNOWN';
}
// After Execution DONE a failure only stops the merge assessment. A mismatch that re-verification alone can repair
// needs a new run; anything else (an uncommitted source file, a transient Git/IO error) is retried by resume.
export function mergeFailure(error) {
  if (error?.code === 'SOURCE_DIRTY') return { code: 'SOURCE_DIRTY', retryable: true };
  const code = classifyEscalation(error?.message);
  return { code, retryable: code === 'UNKNOWN' };
}
// The reason an SBI carries a Human Gate risk. Since #175 the human decides it at SBI approval: it raises the Risk to level 3 and two
// humans after implementation, and never stops the run before implementation. ambiguous / requiresDesignDecision still escalate.
export function humanGate(sbi, rules) {
  if (sbi.ambiguous) return '仕様が曖昧です。SBIを人間が具体化してください。';
  if (sbi.requiresDesignDecision) return '重要設計判断が必要です。人間がADRを決定してください。';
  const risk = sbi.risks.find(r => rules.humanGate.some(g => g.toLowerCase() === r.toLowerCase()));
  const path = [...sbi.allowedFiles, ...(sbi.allowedDirs ?? [])].find(p => rules.protectedPathPatterns.some(pattern => new RegExp(pattern, 'i').test(p)));
  if (risk || path) return `Human Gate: ${risk || path}。人間のレビューが必要です。`;
  if (sbi.risks.length) return `Human Gate: 未分類risk ${sbi.risks.join(', ')} を人間が分類してください。`;
  return null;
}
