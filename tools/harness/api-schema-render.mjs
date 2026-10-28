// Structured proposal → OpenAPI 3.1. The Harness owns openapi/info, the Bearer JWT scheme and the shared Error schema; the provider cannot redefine them.
export const reviewChecklist = Object.freeze([
  'endpointの粒度は妥当か', 'method / pathは自然か', 'request / responseはFrontendが使いやすいか', 'required / nullable / enumは妥当か',
  'error responseは適切か', 'AuthN / AuthZ境界は正しいか', '既存APIと重複・矛盾していないか', 'breaking changeになっていないか',
]);
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const errorSchemas = {
  Error: { type: 'object', description: '全APIで共通のエラーレスポンス', required: ['code', 'message'], properties: {
    code: { type: 'string', description: '機械判定用のエラーコード' }, message: { type: 'string', description: '利用者向けのメッセージ' },
    details: { type: 'array', items: ref('ErrorDetail'), description: '入力エラーなどの詳細' },
  } },
  ErrorDetail: { type: 'object', required: ['message'], properties: { field: { type: ['string', 'null'], description: '対象のフィールド' }, message: { type: 'string' } } },
};
// Provider-neutral: the contract says a Bearer JWT is required, not who issues it. The issuer is chosen in the Rails adapter.
const bearerAuth = { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '認証Providerが発行するJWT（Bearer）。検証と業務認可（x-sonomama-authz）はRails APIが行う。' };
const typed = (type, value) => type === 'integer' ? Number.parseInt(value, 10) : type === 'number' ? Number(value) : type === 'boolean' ? value === 'true' : value;
const compact = value => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== '' && !(Array.isArray(entry) && !entry.length)));

function schemaOf({ type, format, enum: values, ref: target, items }) {
  if (type === 'object') return ref(target);
  if (type === 'array') return { type: 'array', items: schemaOf(items) };
  return compact({ type, format, enum: values });
}
function renderProperty(property) {
  let schema = schemaOf(property);
  if (property.nullable) {
    if (schema.$ref) schema = { anyOf: [schema, { type: 'null' }] };
    else schema = { ...schema, type: [schema.type, 'null'], ...(schema.enum ? { enum: [...schema.enum, null] } : {}) };
  }
  const { minLength, maxLength, minimum, maximum, pattern } = property.constraints;
  return compact({ ...schema, description: property.description, example: property.example === null ? null : typed(property.type, property.example), minLength, maxLength, minimum, maximum, pattern });
}
function renderComponent(component) {
  return compact({
    type: 'object', description: component.description,
    required: component.properties.filter(p => p.required).map(p => p.name),
    properties: Object.fromEntries(component.properties.map(p => [p.name, renderProperty(p)])),
    'x-sonomama-pii': component.pii,
  });
}
const content = body => ({ 'application/json': { schema: body.array ? { type: 'array', items: ref(body.component) } : ref(body.component) } });
function renderOperation(endpoint) {
  const jwt = endpoint.authN === 'bearer-jwt';
  // security is always explicit: [] marks a public endpoint even when the document later gains a global requirement.
  return {
    ...compact({ operationId: endpoint.operationId, summary: endpoint.summary, tags: endpoint.tags }),
    security: jwt ? [{ bearerAuth: [] }] : [],
    ...compact({
    'x-sonomama-authz': jwt ? { enforcedBy: 'rails', roles: endpoint.authZ.roles, rule: endpoint.authZ.rule } : null,
    'x-sonomama-data': { pii: endpoint.pii, logCaution: endpoint.logCaution },
    parameters: endpoint.parameters.map(p => compact({ name: p.name, in: p.in, required: p.required, description: p.description, schema: compact({ type: p.type, format: p.format, enum: p.enum }), example: p.example === null ? null : typed(p.type, p.example) })),
    requestBody: endpoint.requestBody ? { required: endpoint.requestBody.required, content: content(endpoint.requestBody) } : null,
    responses: Object.fromEntries(endpoint.responses.map(r => [String(r.status), compact({ description: r.description || `HTTP ${r.status}`, content: r.body ? content(r.body) : null })])),
    }),
  };
}
// With an existing schema the proposal is merged into a copy of it, so the result can replace packages/api-schema/openapi.yaml after approval.
export function renderOpenApi(proposal, existing) {
  const document = existing ? structuredClone(existing.document) : { openapi: '3.1.0', info: { title: 'SONOMAMA API', version: '0.1.0' }, paths: {} };
  document.paths ??= {};
  document.components ??= {};
  document.components.securitySchemes = { ...document.components.securitySchemes, bearerAuth };
  document.components.schemas = { ...document.components.schemas, ...errorSchemas };
  for (const component of proposal.components) document.components.schemas[component.name] = renderComponent(component);
  for (const endpoint of proposal.endpoints) {
    const method = endpoint.method.toLowerCase();
    if (endpoint.change === 'remove') {
      delete document.paths[endpoint.path]?.[method];
      if (document.paths[endpoint.path] && !Object.keys(document.paths[endpoint.path]).length) delete document.paths[endpoint.path];
      continue;
    }
    document.paths[endpoint.path] = { ...document.paths[endpoint.path], [method]: renderOperation(endpoint) };
  }
  return document;
}

const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const bodyName = body => body ? `${body.component}${body.array ? '[]' : ''}` : 'なし';
export function renderSummary({ issue, proposal, quality, contractDiff = { breaking: [], nonBreaking: [] }, existing, directory, approvedLabel, reviewLabel }) {
  const active = proposal.endpoints.filter(e => e.change !== 'remove');
  const impact = proposal.securityImpact.length ? proposal.securityImpact.join(', ') : 'None';
  const caution = [...new Set(active.flatMap(e => e.logCaution))];
  return [
    `# API Schema Proposal: #${issue.number} ${issue.title}`, '',
    `- Issue: ${issue.url}`, `- 状態: Human Review待ち。承認まではFrontend / Backendの実装SBIへ進めない`,
    `- API Schema Quality Judge: ${quality.status}`, `- 既存OpenAPI: ${existing?.path ?? 'なし（新規）'}`, `- version: ${proposal.version}`,
    `- 破壊的変更の候補: ${quality.changes.breaking.length + contractDiff.breaking.length}件（意味上 ${quality.changes.breaking.length}件、既存OpenAPIとの構造差分 ${contractDiff.breaking.length}件）`,
    `- Proposal: ${directory}/openapi.yaml（OpenAPI 3.1）、${directory}/proposal.json、${directory}/summary.md`, '',
    proposal.summary, '',
    '## Endpoint', '',
    '| change | method / path | operationId | 認証 | 認可（Rails） | PII |', '| --- | --- | --- | --- | --- | --- |',
    ...proposal.endpoints.map(e => `| ${e.change} | ${cell(`${e.method} ${e.path}`)} | ${cell(e.operationId)} | ${e.authN === 'bearer-jwt' ? 'Bearer JWT必須' : '公開'} | ${cell([...e.authZ.roles.map(r => `role ${r}`), e.authZ.rule].filter(Boolean).join(' / ') || 'なし')} | ${e.pii ? 'あり' : 'なし'} |`), '',
    '## Request / Response', '',
    ...active.flatMap(e => [
      `### ${e.method} ${e.path}`, '', e.summary, '',
      ...e.parameters.map(p => `- parameter ${p.name}（${p.in}、${p.required ? '必須' : '任意'}、${p.type}${p.format ? ` / ${p.format}` : ''}${p.enum ? ` / enum ${p.enum.join(', ')}` : ''}）`),
      `- request body: ${e.requestBody ? `${bodyName(e.requestBody)}（${e.requestBody.required ? '必須' : '任意'}）` : 'なし'}`,
      `- response: ${e.responses.map(r => `${r.status} ${bodyName(r.body)}`).join(', ')}`, '',
    ]),
    '## Schema', '',
    ...proposal.components.flatMap(c => [
      `### ${c.name}${c.pii ? '（PII）' : ''}`, '', c.description, '',
      '| property | type | required | nullable | enum / format / ref |', '| --- | --- | --- | --- | --- |',
      ...c.properties.map(p => `| ${cell(p.name)} | ${p.type === 'array' ? `array of ${p.items?.ref ?? p.items?.type}` : p.type} | ${p.required ? '必須' : '任意'} | ${p.nullable ? 'null可' : '不可'} | ${cell([p.enum && `enum ${p.enum.join(', ')}`, p.format, p.ref].filter(Boolean).join(' / ') || '-')} |`), '',
    ]),
    'error responseはHarnessが定義する共通のError schema（code / message / details）を使う。', '',
    '## Security Impact', '',
    `- 分類: ${impact}`,
    `- ログ出力注意: ${caution.length ? caution.join(' / ') : 'なし'}`,
    '- Secret / Credentialの実値はschema・exampleに含めない（Quality Judgeで検査済み）', '',
    '## Breaking / Non-breaking', '',
    '破壊的変更の候補:', ...(quality.changes.breaking.length ? quality.changes.breaking.map(line => `- ${line}`) : ['- なし']), '',
    '非破壊の変更:', ...(quality.changes.nonBreaking.length ? quality.changes.nonBreaking.map(line => `- ${line}`) : ['- なし']), '',
    ...(existing ? [
      '### 既存OpenAPIとの構造差分', '',
      'modifyは既存operation・同名componentを丸ごと置き換える。提案モデルで表現できない既存の内容も、消える場合はここに出る。', '',
      '破壊的変更の候補（削除・変更・制約追加）:', ...(contractDiff.breaking.length ? contractDiff.breaking.map(line => `- ${line}`) : ['- なし']), '',
      '非破壊（追加・説明の変更）:', ...(contractDiff.nonBreaking.length ? contractDiff.nonBreaking.map(line => `- ${line}`) : ['- なし']), '',
    ] : []),
    '## Human Review', '',
    ...reviewChecklist.map(item => `- [ ] ${item}`), '',
    `承認は Proposal をcommitしたうえで \`pnpm planner:api-schema-approve ${issue.url}\` で署名付き台帳に記録する。`,
    `Security Impactがあれば異なる人間2人、なければ1人の承認が必要。承認はこの内容のdigestとcommit SHAに紐づき、内容が変われば無効になる。`,
    `Issueの \`${approvedLabel}\` / \`${reviewLabel}\` は台帳の状態を映す目印で、承認の正本ではない。Plannerは承認・実装・mergeを行わない。`, '',
  ].join('\n');
}
