// Deterministic check of the app → features → shared dependency direction. See docs/architecture/admin-frontend.md.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
const DECLARATION = /\.d(\.ts)?$/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

const sourceFiles = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (SOURCE.test(entry.name)) out.push(path);
  }
  return out;
};

// main.tsx boots the app, so it belongs to the app layer. The test setup and d.ts files are explicitly not layered.
// Any other top-level path is an unknown layer, so it cannot be used to bypass the rules below.
const layerOf = (src, path) => {
  const [first, second, ...rest] = relative(src, path).split('/');
  if (first === 'features')
    return {
      layer: 'features',
      feature: second,
      internal: rest.length > 0 && !/^index(\.tsx?)?$/.test(rest.join('/')),
    };
  if (['app', 'shared', 'providers'].includes(first)) return { layer: first };
  if (/^main\.(t|j)sx?$/.test(first)) return { layer: 'app' };
  return { layer: first === 'test' || DECLARATION.test(first) ? 'non-layer' : 'unknown' };
};

const resolveImport = (src, from, specifier) => {
  if (specifier.startsWith('@/')) return join(src, specifier.slice(2));
  if (specifier.startsWith('.')) return resolve(dirname(from), specifier);
  return null;
};

const ruleFor = (from, to) => {
  if (from.layer === 'non-layer') return null;
  if (from.layer === 'unknown' || to.layer === 'unknown') return 'unknown top-level layer';
  if (to.layer === 'non-layer') return 'layered → non-layer file';
  if (from.layer === 'features' && to.layer === 'features')
    return from.feature === to.feature ? null : 'features/A → features/B';
  if (from.layer === 'features' && (to.layer === 'app' || to.layer === 'providers')) return `features → ${to.layer}`;
  if (from.layer === 'shared' && to.layer !== 'shared') return `shared → ${to.layer}`;
  if (from.layer === 'providers' && (to.layer === 'app' || to.layer === 'features')) return `providers → ${to.layer}`;
  if (from.layer === 'app' && to.layer === 'features' && to.internal) return 'app → features/<feature>/index.ts only';
  return null;
};

export function checkArchitecture(src) {
  return sourceFiles(src).flatMap((file) => {
    const from = layerOf(src, file);
    return [...readFileSync(file, 'utf8').matchAll(IMPORT)].flatMap(([, specifier]) => {
      const target = resolveImport(src, file, specifier);
      const rule = target && ruleFor(from, layerOf(src, target));
      return rule ? [{ file: relative(src, file), specifier, rule }] : [];
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = resolve(process.argv[2] ?? 'src');
  const violations = checkArchitecture(src);
  for (const v of violations) console.error(`${v.file}: ${v.specifier} (${v.rule})`);
  console.log(violations.length ? `Architecture check: FAIL (${violations.length})` : 'Architecture check: PASS');
  process.exitCode = violations.length ? 1 : 0;
}
