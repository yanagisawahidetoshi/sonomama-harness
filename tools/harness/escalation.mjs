// Machine-countable stop reasons for Health Metrics. Human-facing reason text is kept separately.
export const escalationCodes = Object.freeze(['SPEC_AMBIGUOUS', 'DESIGN_DECISION_REQUIRED', 'AGENT_ESCALATION', 'SECRET_PROPOSAL', 'NEW_SECURITY_SCOPE', 'NEW_HIGH_RISK',
  'VERIFIER_NOT_CONFIGURED', 'SECURITY_VERIFIER_NOT_CONFIGURED', 'SCOPE_VIOLATION', 'LANE_ESCALATION', 'ITERATION_LIMIT', 'CONSECUTIVE_FAILURE',
  'SOURCE_CHANGED', 'WORKSPACE_CHANGED', 'UNKNOWN']);
export function classifyEscalation(message) {
  const text = String(message ?? '');
  if (/^scope[ /]|^trusted test path is reserved/.test(text)) return 'SCOPE_VIOLATION';
  if (/^Prototype scope escalated/.test(text)) return 'LANE_ESCALATION';
  if (/^HEAD\/snapshot changed|^workspace snapshot changed|^Verifier mutated|not an owned Git worktree/.test(text)) return 'WORKSPACE_CHANGED';
  if (/^Source must be clean|^input snapshot changed|snapshot changed; start a new run|^trusted tool\/skill snapshot changed/.test(text)) return 'SOURCE_CHANGED';
  return 'UNKNOWN';
}
export function humanGate(sbi, rules) {
  if (sbi.ambiguous) return '仕様が曖昧です。SBIを人間が具体化してください。';
  if (sbi.requiresDesignDecision) return '重要設計判断が必要です。人間がADRを決定してください。';
  const risk = sbi.risks.find(r => rules.humanGate.some(g => g.toLowerCase() === r.toLowerCase()));
  const path = sbi.allowedFiles.find(p => rules.protectedPathPatterns.some(pattern => new RegExp(pattern, 'i').test(p)));
  if (risk || path) return `Human Gate: ${risk || path}。人間のレビューが必要です。`;
  if (sbi.risks.length) return `Human Gate: 未分類risk ${sbi.risks.join(', ')} を人間が分類してください。`;
  return null;
}
