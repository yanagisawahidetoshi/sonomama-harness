export function humanGate(sbi, rules) {
  if (sbi.ambiguous) return '仕様が曖昧です。SBIを人間が具体化してください。';
  if (sbi.requiresDesignDecision) return '重要設計判断が必要です。人間がADRを決定してください。';
  const risk = sbi.risks.find(r => rules.humanGate.some(g => g.toLowerCase() === r.toLowerCase()));
  const path = sbi.allowedFiles.find(p => rules.protectedPathPatterns.some(pattern => new RegExp(pattern, 'i').test(p)));
  if (risk || path) return `Human Gate: ${risk || path}。人間のレビューが必要です。`;
  if (sbi.risks.length) return `Human Gate: 未分類risk ${sbi.risks.join(', ')} を人間が分類してください。`;
  return null;
}
