import { riskPolicySchema } from './schemas.mjs';

// Rules provide floors; safe rules are explicit candidates, never overrides for a floor.
export function assessRisk({ files = [], metadata = {}, humanGate = false, aiRisk = null, securityAssessment = null, lane = null }, rawPolicy) {
  const policy = riskPolicySchema.parse(rawPolicy);
  const reasons = [], matches = [];
  let floor = 0;
  const match = (level, reason, source, path = null) => {
    floor = Math.max(floor, level); reasons.push(reason); matches.push({ source, reason, level, path });
  };
  if (humanGate) match(3, 'human_gate', 'human-gate');
  if (securityAssessment?.securitySensitive || securityAssessment?.minimumRiskLevel === 3) match(3, 'security_rule_minimum', 'security-enforcement');
  if (metadata.minimumRiskLevel === 3) match(3, 'sbi_minimum', 'sbi-metadata');
  const metadataText = JSON.stringify(metadata);
  for (const rule of policy.metadataRules) {
    if (new RegExp(rule.pattern, 'i').test(metadataText)) match(rule.minimumLevel, rule.id, 'sbi-metadata');
  }
  for (const file of files) {
    for (const path of [file.path, file.previousPath].filter(Boolean)) {
      for (const rule of policy.pathRules) {
        if (new RegExp(rule.pattern, 'i').test(path)) match(rule.minimumLevel, rule.id, 'path', path);
      }
    }
    // Inspect changed lines, including removals. An unknown semantic effect remains medium.
    const text = `${file.added || ''}\n${file.deleted || ''}`;
    for (const rule of policy.metadataRules) {
      if (new RegExp(rule.pattern, 'i').test(text)) match(rule.minimumLevel, rule.id, 'changed-content', file.path);
    }
  }
  const safeMatches = files.map(file => {
    if (file.binary || file.previousPath || file.modeChanged || (file.mode && file.mode !== '100644')) return null;
    return policy.safeRules.find(rule => (!rule.requiredLane || (lane?.name === rule.requiredLane && !lane.requiresSecurityGate && !lane.requiresDesignApproval))
      && new RegExp(rule.pattern).test(file.path) && rule.allowedStatuses.includes(file.status)
      && Buffer.byteLength(`${file.added || ''}${file.deleted || ''}`) <= rule.maxChangedBytes);
  });
  const safe = files.length > 0 && safeMatches.every(Boolean);
  let level = Math.max(safe ? 1 : policy.defaultLevel, floor);
  if (safe && floor < 2) reasons.push(...safeMatches.map(rule => rule.id));
  else reasons.push('default_medium');
  if (aiRisk !== null) {
    if (![1, 2, 3].includes(aiRisk)) throw new Error('Invalid AI risk level');
    matches.push({ source: 'ai-advisory', level: aiRisk, reason: 'AI can only raise risk' });
    if (aiRisk > level) reasons.push('ai_raised_risk');
    level = Math.max(level, aiRisk);
  }
  return { level, label: ['LOW', 'MEDIUM', 'HIGH'][level - 1], reasons: [...new Set(reasons)], matches,
    requiredHumanApprovals: Math.max(policy.levels[level].requiredHumanApprovals, securityAssessment?.requiredHumanApprovals || 0),
    autoMergeAllowed: lane?.name !== 'prototype' && level === 1 && !humanGate && !securityAssessment?.securitySensitive && policy.levels[level].autoMerge,
    humanGate, defaultLevel: policy.defaultLevel };
}
