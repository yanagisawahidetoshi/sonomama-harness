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

const line = text.max(200);
export const plannedSbiSchema = z.strictObject({
  id: text.max(20), title: text.max(80), purpose: text.max(300),
  scope: z.strictObject({ included: z.array(line).max(8), excluded: z.array(line).max(8) }),
  acceptanceCriteria: z.array(z.strictObject({ id: text.max(20), description: z.string().max(200) })).max(12),
  scenarios: z.array(z.strictObject({ name: line, given: z.array(line).max(8), when: z.array(line).max(8), then: z.array(line).max(8), acceptanceIds: z.array(text.max(20)).max(12) })).max(12),
  dependsOn: z.array(text.max(20)).max(12), changeAreas: z.array(z.string().max(80)).max(12),
  riskCandidate: z.enum(['L1', 'L2', 'L3']), securityImpact: z.array(z.string().max(40)).max(12),
  verification: z.strictObject({ applicationTest: z.string().max(120), acceptance: z.string().max(120), e2e: z.string().max(120) }),
});
export const planResponseSchema = z.strictObject({ sbis: z.array(plannedSbiSchema).max(20), escalation: z.string().nullable().optional() });
const strings = { type: 'array', items: { type: 'string' } };
const object = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const planJsonSchema = object({
  sbis: { type: 'array', items: object({
    id: { type: 'string' }, title: { type: 'string' }, purpose: { type: 'string' },
    scope: object({ included: strings, excluded: strings }),
    acceptanceCriteria: { type: 'array', items: object({ id: { type: 'string' }, description: { type: 'string' } }) },
    scenarios: { type: 'array', items: object({ name: { type: 'string' }, given: strings, when: strings, then: strings, acceptanceIds: strings }) },
    dependsOn: strings, changeAreas: strings,
    riskCandidate: { type: 'string', enum: ['L1', 'L2', 'L3'] }, securityImpact: strings,
    verification: object({ applicationTest: { type: 'string' }, acceptance: { type: 'string' }, e2e: { type: 'string' } }),
  }) },
  escalation: { type: ['string', 'null'] },
});
// API Schema Planner contract. Every map of OpenAPI is an array of named entries so the provider schema stays closed (no dynamic keys).
// Blank strings pass Zod on purpose: the API Schema Quality Judge reports them with a reason.
const word = z.string().max(80), sentence = z.string().max(300), maybe = schema => schema.nullable();
const scalarTypes = ['string', 'integer', 'number', 'boolean'];
const enumValues = maybe(z.array(z.string().max(80)).max(30));
const bodyRef = { component: z.string().max(64), array: z.boolean() };
export const apiPropertySchema = z.strictObject({
  name: z.string().max(64), type: z.enum([...scalarTypes, 'object', 'array']), format: maybe(z.string().max(40)), enum: enumValues, ref: maybe(z.string().max(64)),
  items: maybe(z.strictObject({ type: z.enum([...scalarTypes, 'object']), format: maybe(z.string().max(40)), enum: enumValues, ref: maybe(z.string().max(64)) })),
  required: z.boolean(), nullable: z.boolean(), description: sentence, example: maybe(z.string().max(200)),
  constraints: z.strictObject({ minLength: maybe(z.number().int().min(0)), maxLength: maybe(z.number().int().min(0)), minimum: maybe(z.number()), maximum: maybe(z.number()), pattern: maybe(z.string().max(200)) }),
});
export const apiEndpointSchema = z.strictObject({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().max(200), operationId: word, summary: sentence, tags: z.array(word).max(10),
  change: z.enum(['add', 'modify', 'remove']), authN: z.enum(['cognito-jwt', 'public']), authZ: z.strictObject({ roles: z.array(word).max(10), rule: maybe(sentence) }),
  pii: z.boolean(), logCaution: z.array(sentence).max(10),
  parameters: z.array(z.strictObject({ name: z.string().max(64), in: z.enum(['path', 'query', 'header']), required: z.boolean(), description: sentence, type: z.enum(scalarTypes), format: maybe(z.string().max(40)), enum: enumValues, example: maybe(z.string().max(200)) })).max(20),
  requestBody: maybe(z.strictObject({ ...bodyRef, required: z.boolean() })),
  responses: z.array(z.strictObject({ status: z.number().int(), description: sentence, body: maybe(z.strictObject(bodyRef)) })).max(12),
});
export const apiProposalSchema = z.strictObject({
  title: z.string().max(80), summary: sentence, version: z.string().max(10), securityImpact: z.array(z.string().max(40)).max(12),
  endpoints: z.array(apiEndpointSchema).max(10),
  components: z.array(z.strictObject({ name: z.string().max(64), description: sentence, pii: z.boolean(), properties: z.array(apiPropertySchema).max(30) })).max(20),
});
export const apiSchemaResponseSchema = z.strictObject({ proposal: apiProposalSchema.nullable(), escalation: z.string().nullable().optional() });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const nullableString = { type: ['string', 'null'] }, nullableNumber = { type: ['number', 'null'] }, nullableInteger = { type: ['integer', 'null'] };
const enumJson = nullable(strings);
const bodyRefJson = { component: { type: 'string' }, array: { type: 'boolean' } };
const propertyJson = object({
  name: { type: 'string' }, type: { type: 'string', enum: [...scalarTypes, 'object', 'array'] }, format: nullableString, enum: enumJson, ref: nullableString,
  items: nullable(object({ type: { type: 'string', enum: [...scalarTypes, 'object'] }, format: nullableString, enum: enumJson, ref: nullableString })),
  required: { type: 'boolean' }, nullable: { type: 'boolean' }, description: { type: 'string' }, example: nullableString,
  constraints: object({ minLength: nullableInteger, maxLength: nullableInteger, minimum: nullableNumber, maximum: nullableNumber, pattern: nullableString }),
});
const endpointJson = object({
  method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string' }, operationId: { type: 'string' }, summary: { type: 'string' }, tags: strings,
  change: { type: 'string', enum: ['add', 'modify', 'remove'] }, authN: { type: 'string', enum: ['cognito-jwt', 'public'] }, authZ: object({ roles: strings, rule: nullableString }),
  pii: { type: 'boolean' }, logCaution: strings,
  parameters: { type: 'array', items: object({ name: { type: 'string' }, in: { type: 'string', enum: ['path', 'query', 'header'] }, required: { type: 'boolean' }, description: { type: 'string' }, type: { type: 'string', enum: scalarTypes }, format: nullableString, enum: enumJson, example: nullableString }) },
  requestBody: nullable(object({ ...bodyRefJson, required: { type: 'boolean' } })),
  responses: { type: 'array', items: object({ status: { type: 'integer' }, description: { type: 'string' }, body: nullable(object(bodyRefJson)) }) },
});
export const apiSchemaJsonSchema = object({
  proposal: nullable(object({
    title: { type: 'string' }, summary: { type: 'string' }, version: { type: 'string' }, securityImpact: strings,
    endpoints: { type: 'array', items: endpointJson },
    components: { type: 'array', items: object({ name: { type: 'string' }, description: { type: 'string' }, pii: { type: 'boolean' }, properties: { type: 'array', items: propertyJson } }) },
  })),
  escalation: { type: ['string', 'null'] },
});
// GitHub REST responses carry many more fields; only the ones the Planner relies on are validated.
export const githubIssueSchema = z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullable().default(null), html_url: z.url(),
  state: z.string().optional(), labels: z.array(z.object({ name: z.string() })).default([]), pull_request: z.unknown().optional(),
});
export const githubIssueListSchema = z.array(githubIssueSchema);
export const githubCommentSchema = z.object({ id: z.number().int().positive(), body: z.string().nullable().default(null), html_url: z.url() });
export const githubCommentListSchema = z.array(githubCommentSchema);
export const githubLabelListSchema = z.array(z.object({ name: z.string() }));

export const riskPolicySchema = z.strictObject({
  version: z.literal(1), defaultLevel: z.literal(2),
  levels: z.strictObject({
    '1': z.strictObject({ requiredHumanApprovals: z.literal(0), autoMerge: z.literal(true) }),
    '2': z.strictObject({ requiredHumanApprovals: z.literal(1), autoMerge: z.literal(false) }),
    '3': z.strictObject({ requiredHumanApprovals: z.number().int().min(2), autoMerge: z.literal(false) }),
  }),
  pathRules: z.array(z.strictObject({ id: text, pattern: text, minimumLevel: z.union([z.literal(2), z.literal(3)]) })).min(1),
  metadataRules: z.array(z.strictObject({ id: text, pattern: text, minimumLevel: z.union([z.literal(2), z.literal(3)]) })).min(1),
  safeRules: z.array(z.strictObject({ id: text, pattern: text, candidateLevel: z.literal(1), requiredLane: z.enum(['prototype', 'production']).optional(), allowedStatuses: z.array(z.enum(['A', 'M'])), maxChangedBytes: z.number().int().positive() })),
});
export const approvalRecordSchema = z.strictObject({
  id: text, runId: text, purpose: z.enum(['implementation-gate', 'design-approval', 'merge']),
  reviewer: text, kind: z.literal('human'), identitySource: text,
  decision: z.enum(['APPROVE', 'REQUEST_CHANGES', 'REVOKE']), approvedAt: z.iso.datetime(),
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/), contextDigest: text, signature: text,
});

export const apiSchemaApprovalRecordSchema = z.strictObject({
  id: text, purpose: z.literal('api-schema'), issueUrl: z.url(), reviewer: text, kind: z.literal('human'), identitySource: text,
  decision: z.enum(['APPROVE', 'REQUEST_CHANGES', 'REVOKE']), decidedAt: z.iso.datetime(),
  commitSha: z.string().regex(/^[0-9a-f]{40,64}$/), proposalDigest: z.string().regex(/^[0-9a-f]{64}$/), signature: text,
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
