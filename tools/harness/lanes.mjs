import defaults from '../../.harness/config/lanes.json' with { type: 'json' };
import { lanePolicySchema } from './schemas.mjs';
// apps/** and packages/** are always Production, whatever lanes.json lists in addition.
export function isProductionPath(path, rawPolicy = defaults) {
  return /^(apps|packages)\//.test(path) || lanePolicySchema.parse(rawPolicy).productionPaths.some(p => new RegExp(p).test(path));
}
// Unknown and mixed paths fail closed to production. No actor-provided lane override.
export function classifyLane(files, sbi, rawPolicy = defaults) {
  const policy = lanePolicySchema.parse(rawPolicy);
  const paths = files.map(f => f.path);
  const prototype = paths.length > 0 && paths.every(path => /^prototypes\/(web|mobile)\//.test(path) && policy.prototypePaths.some(p => new RegExp(p).test(path)))
    && !paths.some(path => /^(apps|packages)\//.test(path) || policy.productionPaths.some(p => new RegExp(p).test(path)));
  const scope = JSON.stringify({files, title:sbi.title,description:sbi.description,risks:sbi.risks,securityImpact:sbi.securityImpact,acceptanceCriteria:sbi.acceptanceCriteria});
  const sensitive = policy.securityPatterns.some(p => new RegExp(p,'i').test(scope));
  const promoted = Boolean(sbi.promotion);
  return { name: prototype && !sensitive && !promoted ? 'prototype' : 'production',
    qualityGates: prototype && !sensitive && !promoted ? policy.prototypeGates : policy.productionGates,
    requiresSecurityGate:sensitive,
    reasons:[prototype ? 'prototype-paths' : 'production-or-unknown-paths', ...(sensitive?['security-sensitive-scope']:[]),...(promoted?['prototype-promotion']:[])] };
}
