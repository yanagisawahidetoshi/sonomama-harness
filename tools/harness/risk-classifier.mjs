import { riskPolicySchema } from './schemas.mjs';

// LEVEL 1 is the default (#157). Rules only raise the level, and the highest floor any of them sets wins.
export function assessRisk({ files = [], metadata = {}, humanGate = false, aiRisk = null, securityAssessment = null, }, rawPolicy) {
  const policy = riskPolicySchema.parse(rawPolicy);
  const reasons = [], matches = [];
  let floor = 0;
  const match = (level, reason, source, path = null) => {
    floor = Math.max(floor, level); reasons.push(reason); matches.push({ source, reason, level, path });
  };
  if (humanGate) match(3, 'human_gate', 'human-gate');
  // classifySecurity clamps minimumRiskLevel to at least 2 even when nothing matched, so only a matched rule may raise the floor, to its own minimum.
  if (securityAssessment?.securitySensitive || securityAssessment?.minimumRiskLevel === 3) match(Math.max(2, securityAssessment.minimumRiskLevel || 2), 'security_rule_minimum', 'security-enforcement');
  if (metadata.minimumRiskLevel > 1) match(metadata.minimumRiskLevel, 'sbi_minimum', 'sbi-metadata');
  const metadataText = JSON.stringify(metadata);
  for (const rule of policy.metadataRules) {
    if (new RegExp(rule.pattern, 'i').test(metadataText)) match(rule.minimumLevel, rule.id, 'sbi-metadata');
  }
  for (const file of files) {
    for (const path of [file.path, file.previousPath].filter(Boolean)) {
      for (const rule of policy.pathRules) {
        // A verified Run snapshot is under .harness/ by contract; only those two location matches are dropped (see sbi-source riskView).
        // riskView only ever marks .harness/state/sbi-<N>.json whose content is the snapshot the Harness wrote, so this cannot exempt .harness/rules/.
        if (file.verifiedSbiSnapshot && ['harness_policy', 'policy_root'].includes(rule.id)) continue;
        if (new RegExp(rule.pattern, 'i').test(path)) match(rule.minimumLevel, rule.id, 'path', path);
      }
    }
    // Inspect changed lines, including removals. An unknown semantic effect stays at the default level.
    const text = `${file.added || ''}\n${file.deleted || ''}`;
    for (const rule of policy.metadataRules) {
      if (new RegExp(rule.pattern, 'i').test(text)) match(rule.minimumLevel, rule.id, 'changed-content', file.path);
    }
  }
  let level = Math.max(policy.defaultLevel, floor);
  if (!floor) reasons.push('default_low');
  if (aiRisk !== null) {
    if (![1, 2, 3].includes(aiRisk)) throw new Error('Invalid AI risk level');
    matches.push({ source: 'ai-advisory', level: aiRisk, reason: 'AI can only raise risk' });
    if (aiRisk > level) reasons.push('ai_raised_risk');
    level = Math.max(level, aiRisk);
  }
  return { level, label: ['LOW', 'MEDIUM', 'HIGH'][level - 1], reasons: [...new Set(reasons)], matches,
    requiredHumanApprovals: Math.max(policy.levels[level].requiredHumanApprovals, securityAssessment?.requiredHumanApprovals || 0),
    autoMergeAllowed: level === 1 && !humanGate && !securityAssessment?.securitySensitive && policy.levels[level].autoMerge,
    humanGate, defaultLevel: policy.defaultLevel };
}
