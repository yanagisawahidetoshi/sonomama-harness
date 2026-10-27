import { hasSecret } from './evidence-protection.mjs';

// Deterministic API Schema Quality Judge. FAIL keeps a proposal out of Human Review; breaking candidates are reported for the human, not failed.
export const reservedComponents = Object.freeze(['Error', 'ErrorDetail']);
export const supportedStatuses = Object.freeze([200, 201, 202, 204, 400, 401, 403, 404, 409, 422, 429, 500, 503]);
export const limits = Object.freeze({ endpoints: 10, components: 20, propertiesPerComponent: 30 });
const authNImpact = ['AuthN', 'APIAuthentication'], authZImpact = ['AuthZ', 'APIAuthorization'];
const credentialName = /password|passwd|secret|credential|api_?key|access_?key|private_?key/i;
const pathPattern = /^(\/([a-z0-9][a-z0-9_-]*|\{[a-z][A-Za-z0-9]*\}))+$/;
const label = endpoint => `${endpoint.method} ${endpoint.path}`;
const placeholders = path => [...path.matchAll(/\{([^}]*)\}/g)].map(match => match[1]);

function exampleProblem({ type, enum: values, example }) {
  if (example === null || example === undefined) return null;
  if (type === 'object' || type === 'array') return `${type}にexampleは指定できません`;
  if (values && !values.includes(example)) return `example（${example}）がenumに含まれません`;
  if (type === 'integer' && !/^-?\d+$/.test(example)) return `integerのexampleが整数ではありません（${example}）`;
  if (type === 'number' && (!example.trim() || !Number.isFinite(Number(example)))) return `numberのexampleが数値ではありません（${example}）`;
  if (type === 'boolean' && !['true', 'false'].includes(example)) return `booleanのexampleはtrue / falseです（${example}）`;
  return null;
}

export function judgeApiSchema(proposal, { securityCategories = null, existing = null } = {}) {
  const findings = [], changes = { breaking: [], nonBreaking: [] };
  const add = (target, rule, reason) => findings.push({ target, rule, reason });
  const existingEndpoints = new Map((existing?.endpoints ?? []).map(e => [label(e), e]));
  const existingComponents = new Map((existing?.components ?? []).map(c => [c.name, c]));
  const proposed = new Map(proposal.components.map(c => [c.name, c]));
  const known = name => reservedComponents.includes(name) || proposed.has(name) || existingComponents.has(name);
  const refers = (target, name, where) => { if (!known(name)) add(target, 'ref-missing', `${where}が未定義のschema ${name || '（空）'} を参照しています`); };

  // Components reachable from a body, following property and item references within the proposal.
  const reachable = names => {
    const seen = new Set(), queue = [...names];
    while (queue.length) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      for (const property of proposed.get(name)?.properties ?? []) for (const ref of [property.ref, property.items?.ref]) if (ref) queue.push(ref);
    }
    return [...seen].filter(name => proposed.has(name)).map(name => proposed.get(name));
  };

  if (!proposal.endpoints.length) add('*', 'empty-proposal', 'endpointが1件も提案されていません');
  if (!/^v[1-9]\d*$/.test(proposal.version)) add('*', 'version-format', `versionは v1 の形式にしてください（${proposal.version || '空'}）`);
  const prefix = `/api/${proposal.version}/`;
  const routes = new Set(), operationIds = new Map();
  let authenticated = false, authorized = false;
  for (const endpoint of proposal.endpoints) {
    const target = label(endpoint);
    if (routes.has(target)) add(target, 'endpoint-duplicate', `${target} が重複しています`);
    routes.add(target);
    if (!/^[a-z][A-Za-z0-9]*$/.test(endpoint.operationId)) add(target, 'operation-id-format', `operationIdはcamelCaseで必須です（${endpoint.operationId || '空'}）`);
    else if (operationIds.has(endpoint.operationId)) add(target, 'operation-id-duplicate', `operationId ${endpoint.operationId} が ${operationIds.get(endpoint.operationId)} と重複しています`);
    else {
      const other = existing?.endpoints.find(e => e.operationId === endpoint.operationId && label(e) !== target);
      if (other) add(target, 'operation-id-duplicate', `operationId ${endpoint.operationId} が既存の ${label(other)} と重複しています`);
    }
    operationIds.set(endpoint.operationId, target);
    if (!endpoint.path.startsWith(prefix) || !pathPattern.test(endpoint.path)) add(target, 'path-format', `pathは ${prefix} から始め、小文字・数字・-・_ と {param} で構成してください（${endpoint.path.trim() || '空'}）`);

    const before = existingEndpoints.get(target);
    if (endpoint.change === 'add' && before) add(target, 'existing-collision', `${target} は既存のendpoint（${existing.path}）と衝突します。変更する場合はchange=modifyにしてください`);
    if (endpoint.change !== 'add' && !before) add(target, 'existing-collision', `${target} は既存のOpenAPIにないため change=${endpoint.change} にできません`);
    if (endpoint.change === 'remove') { if (before) changes.breaking.push(`endpoint削除: ${target}`); continue; }
    if (endpoint.change === 'add') changes.nonBreaking.push(`endpoint追加: ${target}`);
    else if (before) {
      const found = [];
      for (const p of endpoint.parameters) if (p.required && !before.parameters.some(b => b.name === p.name && b.in === p.in && b.required)) found.push(`必須parameterを追加: ${target} ${p.name}`);
      for (const status of before.successStatuses) if (!endpoint.responses.some(r => r.status === status)) found.push(`成功statusを削除: ${target} ${status}`);
      if (!before.authenticated && endpoint.authN === 'cognito-jwt') found.push(`公開endpointを認証必須へ変更: ${target}`);
      if (found.length) changes.breaking.push(...found);
      else changes.nonBreaking.push(`既存endpointを変更（意味上の破壊的変更は未検出。構造差分も確認）: ${target}`);
    }

    const pathNames = placeholders(endpoint.path), params = new Set();
    for (const p of endpoint.parameters) {
      const id = `${p.in}:${p.name}`;
      if (params.has(id)) add(target, 'parameter-duplicate', `parameter ${p.name}（${p.in}）が重複しています`);
      params.add(id);
      if (p.in === 'path' && !pathNames.includes(p.name)) add(target, 'path-parameters', `path parameter ${p.name} がpathにありません`);
      if (p.in === 'path' && !p.required) add(target, 'path-parameters', `path parameter ${p.name} はrequired=trueにしてください`);
      if (p.enum && !p.enum.length) add(target, 'enum-empty', `parameter ${p.name} のenumが空です`);
      const problem = exampleProblem(p);
      if (problem) add(target, 'example-type', `parameter ${p.name}: ${problem}`);
    }
    for (const name of pathNames) if (!endpoint.parameters.some(p => p.in === 'path' && p.name === name)) add(target, 'path-parameters', `pathの {${name}} に対応するpath parameterがありません`);

    if (endpoint.requestBody) {
      if (['GET', 'DELETE'].includes(endpoint.method)) add(target, 'request-body-method', `${endpoint.method} にrequest bodyは指定できません`);
      refers(target, endpoint.requestBody.component, 'request body');
    }
    const statuses = new Set();
    for (const r of endpoint.responses) {
      if (!supportedStatuses.includes(r.status)) add(target, 'status-invalid', `status ${r.status} は対象外です（${supportedStatuses.join(' / ')}）`);
      if (statuses.has(r.status)) add(target, 'status-duplicate', `status ${r.status} が重複しています`);
      statuses.add(r.status);
      if (r.status === 204 && r.body) add(target, 'no-content-body', '204にresponse bodyは指定できません');
      if (r.status >= 400 && (r.body?.component !== 'Error' || r.body.array)) add(target, 'error-schema', `error response ${r.status} は共通のError schemaを使ってください`);
      if (r.status < 400 && reservedComponents.includes(r.body?.component)) add(target, 'error-schema', `成功response ${r.status} が ${r.body.component} を返しています`);
      if (r.body) refers(target, r.body.component, `response ${r.status}`);
    }
    if (![...statuses].some(status => status >= 200 && status < 300)) add(target, 'success-missing', '成功response（2xx）がありません');

    const jwt = endpoint.authN === 'cognito-jwt', condition = endpoint.authZ.roles.length > 0 || Boolean(endpoint.authZ.rule?.trim());
    authenticated ||= jwt; authorized ||= jwt && condition;
    if (jwt && !statuses.has(401)) add(target, 'auth-responses', 'Cognito JWT必須のendpointは401を定義してください');
    if (!jwt && (statuses.has(401) || statuses.has(403))) add(target, 'auth-responses', '公開endpointに401 / 403は定義しません');
    if (!jwt && endpoint.authZ.roles.length) add(target, 'auth-responses', '公開endpointにroleは指定できません');
    if (endpoint.authZ.roles.length && !statuses.has(403)) add(target, 'auth-responses', 'role制限があるため403を定義してください');
    if (jwt && statuses.has(403) && !condition) add(target, 'auth-responses', '403を返す認可条件（roles / rule）がありません');

    const bodies = [endpoint.requestBody?.component, ...endpoint.responses.map(r => r.body?.component)].filter(Boolean);
    for (const component of reachable(bodies)) if (component.pii && !endpoint.pii) add(target, 'pii-classification', `PIIを含むschema ${component.name} を扱うためpii=trueにしてください`);
    const success = endpoint.responses.filter(r => r.status < 400 && r.body).map(r => r.body.component);
    for (const component of reachable(success)) for (const property of component.properties) {
      if (credentialName.test(property.name)) add(target, 'credential-response', `成功responseが ${component.name}.${property.name} を返します。Secret / Credentialは返却しないでください`);
    }
  }

  const componentNames = new Set();
  for (const component of proposal.components) {
    const target = component.name || '（空のcomponent名）';
    if (!/^[A-Z][A-Za-z0-9]*$/.test(component.name)) add(target, 'component-name-format', `component名はPascalCaseにしてください（${component.name || '空'}）`);
    if (reservedComponents.includes(component.name)) add(target, 'component-reserved', `${component.name} はHarnessが定義する共通schemaのため再定義できません`);
    if (componentNames.has(component.name)) add(target, 'component-duplicate', `component ${component.name} が重複しています`);
    componentNames.add(component.name);
    const propertyNames = new Set();
    for (const property of component.properties) {
      const where = `${component.name}.${property.name}`;
      if (!/^[a-z][A-Za-z0-9_]*$/.test(property.name)) add(target, 'property-name-format', `property名はcamelCaseにしてください（${property.name || '空'}）`);
      if (propertyNames.has(property.name)) add(target, 'property-duplicate', `property ${where} が重複しています`);
      propertyNames.add(property.name);
      if (property.type === 'object') {
        if (!property.ref) add(target, 'property-type', `${where}: objectはcomponentをrefで参照してください`);
        else refers(target, property.ref, where);
      } else if (property.ref) add(target, 'property-type', `${where}: ${property.type} にrefは指定できません`);
      if (property.type === 'array') {
        if (!property.items) add(target, 'property-type', `${where}: arrayにitemsがありません`);
        else if (property.items.type === 'object' && !property.items.ref) add(target, 'property-type', `${where}: objectのitemsはcomponentをrefで参照してください`);
        else if (property.items.ref) refers(target, property.items.ref, `${where}のitems`);
      } else if (property.items) add(target, 'property-type', `${where}: ${property.type} にitemsは指定できません`);
      for (const [values, at] of [[property.enum, where], [property.items?.enum, `${where}のitems`]]) {
        if (values && !values.length) add(target, 'enum-empty', `${at} のenumが空です`);
        if (values && new Set(values).size !== values.length) add(target, 'enum-empty', `${at} のenumに重複があります`);
      }
      const problem = exampleProblem(property);
      if (problem) add(target, 'example-type', `${where}: ${problem}`);
      const { minLength, maxLength, minimum, maximum } = property.constraints;
      if ((minLength !== null && maxLength !== null && minLength > maxLength) || (minimum !== null && maximum !== null && minimum > maximum)) add(target, 'constraints', `${where}: 最小値が最大値を超えています`);
    }

    const before = existingComponents.get(component.name);
    if (!before) { changes.nonBreaking.push(`component追加: ${component.name}`); continue; }
    const found = [];
    for (const old of before.properties) {
      const now = component.properties.find(p => p.name === old.name);
      if (!now) { found.push(`property削除: ${component.name}.${old.name}`); continue; }
      if (old.type && now.type !== old.type) found.push(`type変更: ${component.name}.${old.name} ${old.type} → ${now.type}`);
      const removed = (old.enum ?? []).filter(value => now.enum && !now.enum.includes(value));
      if (removed.length) found.push(`enum値削除: ${component.name}.${old.name} ${removed.join(', ')}`);
      if (now.required && !old.required) found.push(`任意から必須へ変更: ${component.name}.${old.name}`);
      if (old.nullable && !now.nullable) found.push(`nullを許可しなくなった: ${component.name}.${old.name}`);
    }
    for (const now of component.properties) if (now.required && !before.properties.some(p => p.name === now.name)) found.push(`必須propertyを追加（requestで使う場合は破壊的）: ${component.name}.${now.name}`);
    if (found.length) changes.breaking.push(...found);
    else changes.nonBreaking.push(`component変更（意味上の破壊的変更は未検出。構造差分も確認）: ${component.name}`);
  }

  const impact = new Set(proposal.securityImpact);
  for (const category of impact) if (securityCategories && !securityCategories.includes(category)) add('*', 'security-impact', `Security Impact ${category} はsecurity.jsonに定義された分類ではありません`);
  if (authenticated && !authNImpact.some(c => impact.has(c))) add('*', 'security-impact', `Cognito JWT必須のendpointがあるためSecurity Impactに ${authNImpact.join(' / ')} を宣言してください`);
  if (authorized && !authZImpact.some(c => impact.has(c))) add('*', 'security-impact', `Rails側の認可条件があるためSecurity Impactに ${authZImpact.join(' / ')} を宣言してください`);
  const pii = proposal.endpoints.some(e => e.change !== 'remove' && e.pii) || proposal.components.some(c => c.pii);
  if (pii && !impact.has('PII')) add('*', 'security-impact', 'PIIを扱うためSecurity ImpactにPIIを宣言してください');

  // Every string the proposal carries ends up in a reviewable file or GitHub comment. Locations are reported, never values.
  const walk = (value, where) => {
    if (typeof value === 'string') { if (hasSecret(value)) add(where, 'secret-value', `${where} にSecret / Credentialらしき値があります。実値をschema・exampleへ含めないでください`); }
    else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${where}[${index}]`));
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) walk(entry, where ? `${where}.${key}` : key);
  };
  walk(proposal, '');
  return { status: findings.length ? 'FAIL' : 'PASS', findings, changes };
}
