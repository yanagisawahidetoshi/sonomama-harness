import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExistingSchema } from './api-schema-reader.mjs';
// api-schema-authn-check verifier: the OpenAPI Source of Truth states the authentication of every operation. Each operation has security
// (its own or the document's), names only defined schemes, and documents 401 when it requires authentication. An operation whose
// security is [] or lists {} is public and reported; whether it may be public is decided by a human at the gate, not here.
const methods = ['get', 'put', 'post', 'patch', 'delete'];

export async function checkApiSchemaAuthn({ root }) {
  const fail = errors => ({ status: 'FAIL', operations: [], public: [], errors });
  let schema;
  try { schema = await readExistingSchema(root); } catch (error) { return fail([error.message]); }
  if (!schema) return fail(['packages/api-schema: no OpenAPI document (openapi.yaml, openapi.yml or openapi.json) to check']);
  const { document } = schema;
  const schemes = Object.keys(document.components?.securitySchemes ?? {});
  const operations = [], open = [], errors = [];
  if (!schemes.length) errors.push(`${schema.path}: components.securitySchemes defines no security scheme`);
  for (const [route, item] of Object.entries(document.paths ?? {})) for (const method of methods.filter(m => item?.[m])) {
    const operation = item[method], name = `${method.toUpperCase()} ${route}`;
    operations.push(name);
    const security = operation.security ?? document.security;
    if (!Array.isArray(security)) { errors.push(`${name}: security is not declared on the operation or the document`); continue; }
    for (const scheme of security.flatMap(requirement => Object.keys(requirement ?? {}))) {
      if (!schemes.includes(scheme)) errors.push(`${name}: security scheme ${scheme} is not defined in components.securitySchemes`);
    }
    if (!security.length || security.some(requirement => !Object.keys(requirement ?? {}).length)) open.push(name);
    else if (!operation.responses?.['401']) errors.push(`${name}: requires authentication but does not document 401`);
  }
  if (!operations.length) errors.push(`${schema.path}: defines no operation to check`);
  return { status: errors.length ? 'FAIL' : 'PASS', operations, public: open, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const result = await checkApiSchemaAuthn({ root });
  for (const line of result.errors) console.error(`ERROR ${line}`);
  for (const name of result.public) console.log(`PUBLIC ${name}`);
  console.log(`API contract authentication (${result.operations.length} operations): ${result.status}`);
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
