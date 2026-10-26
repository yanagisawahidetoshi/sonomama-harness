import { z } from 'zod';
const text = z.string().min(1);
export const relativePath = text.refine(p => !p.startsWith('/') && !p.includes('\\') && p.split('/').every(s => s !== '..' && s !== '.' && s !== ''), 'unsafe relative path');
export const sbiSchema = z.strictObject({
  id: text.regex(/^[A-Za-z0-9_-]+$/), title: text, description: text,
  gherkin: text.refine(s => ['Feature:', 'Scenario:', 'Given ', 'When ', 'Then '].every(k => s.includes(k)), 'BDD/Gherkin required'),
  acceptanceCriteria: z.array(z.strictObject({ id: text, description: text, verifier: text })).min(1),
  allowedFiles: z.array(relativePath).min(1), risks: z.array(text),
  ambiguous: z.boolean(), requiresDesignDecision: z.boolean(),
  securityImpact: z.array(text).default([]), requiredSecurityRules: z.array(text).default([]),
  requiredVerifiers: z.array(text).default([]), preImplementationGate: z.boolean().default(false),
  promotion: z.strictObject({ source: relativePath.refine(p => /^prototypes\/(web|mobile)(\/|$)/.test(p)), designApproval: z.null().optional() }).optional(),
  minimumRiskLevel: z.union([z.literal(2), z.literal(3)]).default(2),
}).refine(s => new Set(s.acceptanceCriteria.map(a => a.id)).size === s.acceptanceCriteria.length, 'duplicate acceptance criteria');
export const configSchema = z.strictObject({
  version: z.literal(1), provider: z.enum(['fake', 'codex', 'claude']), sbi: relativePath,
  maxConsecutiveFailures: z.number().int().min(1).max(3), maxIterations: z.number().int().min(1).max(20),
  timeoutMs: z.number().int().min(100).max(600000),
  securityVerifiers: z.array(z.strictObject({ id: text, directory: z.union([z.literal('.'), relativePath]), commands: z.array(z.array(text).min(1)) })).default([]),
  semanticReview: z.strictObject({ enabled: z.boolean() }).default({ enabled: false }),
  verifiers: z.array(z.strictObject({ id: text, directory: z.union([z.literal('.'), relativePath]), marker: relativePath.optional(),
    allowMissing: z.boolean().default(true), planned: z.array(text).min(1), commands: z.array(z.array(text).min(1)),
    acceptanceIds: z.array(text).default([]),
    appliesTo: z.array(text).optional(),
    lanes: z.array(z.enum(['prototype', 'production'])).default(['prototype', 'production']),
    trust: z.enum(['application', 'acceptance']).default('application'),
    trustedScript: relativePath.optional(),
  })).min(1),
}).refine(c => new Set(c.verifiers.map(v => v.id)).size === c.verifiers.length && !c.verifiers.some(v => v.id === 'sample-bdd'), 'duplicate or reserved verifier');
export const rulesSchema = z.strictObject({
  humanGate: z.array(z.enum(['AuthN', 'AuthZ', 'RLS', 'PII', 'Migration', 'ADR'])).length(6),
  protectedPathPatterns: z.array(text).min(1), maxFileBytes: z.number().int().positive(),
}).refine(r => new Set(r.humanGate).size === 6, 'all Human Gates required');
export const responseSchema = z.strictObject({
  files: z.array(z.strictObject({ path: relativePath, content: z.string() })).max(20),
  escalation: z.string().nullable().optional(),
});
export const responseJsonSchema = {
  type: 'object', additionalProperties: false, required: ['files', 'escalation'],
  properties: {
    files: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
    escalation: { type: ['string', 'null'] },
  },
};

export const riskPolicySchema = z.strictObject({
  version: z.literal(1), defaultLevel: z.literal(2),
  levels: z.strictObject({
    '1': z.strictObject({ requiredHumanApprovals: z.literal(0), autoMerge: z.literal(true) }),
    '2': z.strictObject({ requiredHumanApprovals: z.literal(1), autoMerge: z.literal(false) }),
    '3': z.strictObject({ requiredHumanApprovals: z.number().int().min(2), autoMerge: z.literal(false) }),
  }),
  pathRules: z.array(z.strictObject({ id: text, pattern: text, minimumLevel: z.union([z.literal(2), z.literal(3)]) })).min(1),
  metadataRules: z.array(z.strictObject({ id: text, pattern: text, minimumLevel: z.union([z.literal(2), z.literal(3)]) })).min(1),
  safeRules: z.array(z.strictObject({ id: text, pattern: text, candidateLevel: z.literal(1), allowedStatuses: z.array(z.enum(['A', 'M'])), maxChangedBytes: z.number().int().positive() })),
});
export const approvalRecordSchema = z.strictObject({
  id: text, runId: text, purpose: z.enum(['implementation-gate', 'design-approval', 'merge']),
  reviewer: text, kind: z.literal('human'), identitySource: text,
  decision: z.enum(['APPROVE', 'REQUEST_CHANGES', 'REVOKE']), approvedAt: z.iso.datetime(),
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/), contextDigest: text, signature: text,
});

export const securityPolicySchema = z.strictObject({
  version: z.literal(1), alwaysRequiredVerifiers: z.array(text).min(1),
  rules: z.array(z.strictObject({
    id: text.regex(/^SEC-[A-Z]+-\d+$/), description: text, categories: z.array(text).min(1),
    pathPatterns: z.array(text), contentPatterns: z.array(text), metadataPatterns: z.array(text),
    preImplementationGate: z.literal(true), minimumRiskLevel: z.literal(3),
    requiredHumanApprovals: z.number().int().min(2), requiredVerifiers: z.array(text).min(1), policyDocument: relativePath,
  })).min(1),
  verifiers: z.array(z.strictObject({ id: text, kind: z.enum(['secret', 'forbidden', 'pii-log', 'command']),
    directory: z.union([z.literal('.'), relativePath]).optional(), commands: z.array(z.array(text).min(1)).optional() })),
  secretPatterns: z.array(text).min(1), forbiddenPatterns: z.array(text), piiLogPatterns: z.array(text),
}).refine(p => new Set(p.rules.map(r => r.id)).size === p.rules.length && new Set(p.verifiers.map(v => v.id)).size === p.verifiers.length, 'duplicate security rule/verifier');
export const humanGatesSchema = z.strictObject({ version: z.literal(1), preImplementationRuleIds: z.array(text).min(1) });

export const lanePolicySchema = z.strictObject({
  version: z.literal(1), prototypePaths: z.array(text).min(1), productionPaths: z.array(text).min(1),
  securityPatterns: z.array(text).min(1),
  prototypeGates: z.tuple([z.literal('typecheck'),z.literal('lint'),z.literal('format'),z.literal('build'),z.literal('secret-scan')]),
  productionGates: z.array(text).min(1),
});
