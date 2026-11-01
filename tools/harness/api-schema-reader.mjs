import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { exists } from './io.mjs';

// packages/api-schema holds the single OpenAPI Source of Truth. Only OpenAPI 3.1 is read, so a merged proposal never mixes 3.0 and 3.1 semantics.
const candidates = ['openapi.yaml', 'openapi.yml', 'openapi.json'].map(file => `packages/api-schema/${file}`);
const methods = ['get', 'put', 'post', 'patch', 'delete'];
const nonNull = schema => Array.isArray(schema?.anyOf) ? schema.anyOf.find(member => member?.type !== 'null') ?? {} : schema ?? {};
const typeOf = schema => {
  const target = nonNull(schema);
  if (Array.isArray(target.type)) return target.type.find(type => type !== 'null') ?? null;
  return target.type ?? (target.$ref ? 'object' : null);
};
const isNullable = schema => (Array.isArray(schema?.type) && schema.type.includes('null')) || (Array.isArray(schema?.anyOf) && schema.anyOf.some(member => member?.type === 'null'));

export async function readExistingSchema(root) {
  const found = [];
  for (const path of candidates) if (await exists(join(root, path))) found.push(path);
  if (!found.length) return null;
  if (found.length > 1) throw new Error(`OpenAPIのSource of Truthが複数あります（${found.join(', ')}）。1つにしてから実行してください`);
  const [path] = found;
  let document;
  try { document = path.endsWith('.json') ? JSON.parse(await readFile(join(root, path), 'utf8')) : parseYaml(await readFile(join(root, path), 'utf8')); }
  catch (error) { throw new Error(`${path} を解析できません: ${error.message}`); }
  if (!document || typeof document !== 'object' || typeof document.openapi !== 'string' || !/^3\.1\.\d+$/.test(document.openapi)) throw new Error(`${path} はOpenAPI 3.1.x ではありません。HarnessはOpenAPI 3.1.xだけを読み込みます`);
  const endpoints = Object.entries(document.paths ?? {}).flatMap(([route, item]) => methods.filter(method => item?.[method]).map(method => {
    const operation = item[method];
    return {
      method: method.toUpperCase(), path: route, operationId: operation.operationId ?? null,
      parameters: [...(item.parameters ?? []), ...(operation.parameters ?? [])].filter(p => p?.name).map(p => ({ name: p.name, in: p.in, required: Boolean(p.required) })),
      successStatuses: Object.keys(operation.responses ?? {}).filter(status => /^2\d\d$/.test(status)).map(Number),
      authenticated: (operation.security ?? document.security ?? []).length > 0,
      authz: operation['x-sonomama-authz'] ? { roles: [...(operation['x-sonomama-authz'].roles ?? [])], rule: operation['x-sonomama-authz'].rule ?? null } : null,
    };
  }));
  const components = Object.entries(document.components?.schemas ?? {}).map(([name, schema]) => ({
    name, properties: Object.entries(schema?.properties ?? {}).map(([property, value]) => ({
      name: property, type: typeOf(value), enum: Array.isArray(nonNull(value).enum) ? nonNull(value).enum.filter(v => v !== null) : null,
      required: (schema.required ?? []).includes(property), nullable: isNullable(value),
    })),
  }));
  return { path, openapi: document.openapi, endpoints, components, document };
}
