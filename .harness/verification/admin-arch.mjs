import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { hasCommand } from './lib/commands.mjs';
// Trusted acceptance for SBI-ADMIN-ARCH (#32). Reads the worktree only; the admin verifier runs the architecture check and its tests.
const root = process.argv[2];
const app = join(root, 'apps/admin');
const src = join(app, 'src');
const doc = 'docs/architecture/admin-frontend.md';
const read = path => readFileSync(join(root, path), 'utf8');
const files = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    entry.isDirectory() ? files(path, out) : out.push(path);
  }
  return out;
};
const code = dir => files(dir).filter(p => /\.(ts|tsx)$/.test(p));
const pkg = () => JSON.parse(read('apps/admin/package.json'));
const deps = () => ({ ...pkg().dependencies, ...pkg().devDependencies });
const commands = () => JSON.parse(read('.harness/config/harness.json')).verifiers.find(v => v.id === 'admin').commands;
const docText = () => read(doc);
const mentions = terms => { const text = docText(); for (const term of terms) assert.ok(text.includes(term), `${doc}: ${term}`); };
// Independent of the app's checker: every import must follow app → features → shared.
const imports = path => [...readFileSync(path, 'utf8').matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)].map(m => m[1]);
const target = (from, spec) => spec.startsWith('@/') ? join(src, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
const layer = path => {
  const [first, second] = relative(src, path).split('/');
  if (first === 'features') return { name: 'features', feature: second };
  // Only the four layers, main.tsx and explicit non-layer files are known; any other top-level path is an unknown layer.
  return { name: ['app', 'shared', 'providers'].includes(first) ? first : first === 'main.tsx' ? 'app' : first === 'test' || /\.d(\.ts)?$/.test(first) ? 'non-layer' : 'unknown' };
};
const violations = () => code(src).flatMap(from => imports(from).flatMap(spec => {
  const to = target(from, spec);
  if (!to) return [];
  const a = layer(from), b = layer(to);
  const bad = (a.name !== 'non-layer' && (a.name === 'unknown' || ['unknown', 'non-layer'].includes(b.name)))
    || (a.name === 'features' && b.name === 'features' && a.feature !== b.feature)
    || (a.name === 'features' && ['app', 'providers'].includes(b.name))
    || (a.name === 'shared' && ['features', 'app', 'providers'].includes(b.name))
    || (a.name === 'providers' && ['features', 'app'].includes(b.name));
  return bad ? [`${relative(app, from)} → ${spec}`] : [];
}));
try {
  const scenarios = [
    ['ADMIN-ARCH-AC-1', 'Given the #20 React environment, When reading apps/admin/src, Then app / features / shared / providers exist', () => {
      for (const dir of ['app', 'features', 'shared', 'providers']) assert.ok(existsSync(join(src, dir)), dir);
      assert.ok(existsSync(join(app, 'vite.config.ts')), 'Vite environment from #20');
    }],
    ['ADMIN-ARCH-AC-2', 'Given the contract, When reading it, Then the responsibility of app / features / shared / providers is written', () => {
      mentions(['src/app', 'src/features', 'src/shared', 'src/providers']);
    }],
    ['ADMIN-ARCH-AC-3', 'Given admin and mobile, When reading the contract, Then admin is the staff console and the student app stays in apps/mobile', () => {
      mentions(['apps/mobile', '受講生']);
      assert.ok(!files(join(src, 'features')).some(p => /\/features\/(student-app|mobile)\b/.test(p)), 'no student app feature');
    }],
    ['ADMIN-ARCH-AC-4', 'Given the contract, When reading the dependency rule, Then app → features → shared is defined', () => {
      mentions(['app → features → shared']);
    }],
    ['ADMIN-ARCH-AC-5', 'Given the source, When following imports, Then no feature imports another feature and no layer imports upward', () => {
      mentions(['features/A → features/B']);
      assert.deepEqual(violations(), []);
    }],
    ['ADMIN-ARCH-AC-6', 'Given the route tree, When reading src/app, Then routes only compose feature pages', () => {
      for (const path of code(join(src, 'app'))) {
        const text = readFileSync(path, 'utf8');
        assert.doesNotMatch(text, /from ['"](axios|zod|react-hook-form)['"]|\buse(Query|Mutation|Form)\(|\bfetch\(/, relative(app, path));
        for (const spec of imports(path).filter(s => s.startsWith('@/features/'))) assert.match(spec, /^@\/features\/[\w-]+$/, `${relative(app, path)} imports a feature through its index`);
      }
      assert.ok(code(join(src, 'app')).some(p => /from ['"]@\/features\/[\w-]+['"]/.test(readFileSync(p, 'utf8'))), 'a route renders a feature page');
    }],
    ['ADMIN-ARCH-AC-7', 'Given the contract, When reading the feature layout, Then api / components / hooks / schemas / types / pages / index.ts are defined', () => {
      mentions(['api/', 'components/', 'hooks/', 'schemas/', 'types/', 'pages/', 'index.ts']);
      const features = readdirSync(join(src, 'features'));
      assert.ok(features.length > 0, 'at least one feature');
      for (const name of features) assert.ok(existsSync(join(src, 'features', name, 'index.ts')), `features/${name}/index.ts`);
    }],
    ['ADMIN-ARCH-AC-8', 'Given the contract, When promoting code, Then only code used by several features moves to shared', () => {
      mentions(['複数Feature', 'shared/components']);
    }],
    ['ADMIN-ARCH-AC-9', 'Given the contract, When managing state, Then TanStack Query / React Hook Form / Zod / React state are the defaults', () => {
      mentions(['TanStack Query', 'React Hook Form', 'Zod', 'useState', 'useReducer', 'staleTime', 'gcTime']);
    }],
    ['ADMIN-ARCH-AC-10', 'Given the dependencies, When listing them, Then no global state library is installed', () => {
      for (const name of Object.keys(deps())) assert.doesNotMatch(name, /redux|zustand|jotai|mobx|recoil|valtio/i, name);
      mentions(['Redux', 'Zustand', 'ADR']);
    }],
    ['ADMIN-ARCH-AC-11', 'Given components and pages, When calling the API, Then only shared/api and feature api modules touch Axios', () => {
      mentions(['shared HTTP client']);
      for (const path of code(src)) {
        if (/\/(shared\/api|features\/[\w-]+\/api)\//.test(path)) continue;
        assert.doesNotMatch(readFileSync(path, 'utf8'), /from ['"]axios['"]|\bfetch\(/, relative(app, path));
      }
    }],
    ['ADMIN-ARCH-AC-12', 'Given several staff roles, When reading the contract, Then features are not duplicated per role', () => {
      mentions(['roleごとにFeatureを複製しない']);
      assert.ok(!readdirSync(join(src, 'features')).some(name => /^(coach|instructor|leader|mg|cs|ops)-/.test(name)), 'no role-prefixed feature');
    }],
    ['ADMIN-ARCH-AC-13', 'Given UI permission checks, When reading the contract, Then they never replace backend authorization', () => {
      mentions(['Backend認可の代替にしない']);
    }],
    ['ADMIN-ARCH-AC-14', 'Given TypeScript and Vite, When importing with @/, Then the path alias resolves', () => {
      assert.match(read('apps/admin/tsconfig.app.json'), /"@\/\*"\s*:\s*\[\s*"\.\/src\/\*"\s*\]/);
      assert.match(read('apps/admin/vite.config.ts'), /tsconfigPaths:\s*true/);
      assert.ok(code(src).some(p => /from ['"]@\/(features|shared|providers)\//.test(readFileSync(p, 'utf8'))), 'source uses the alias');
    }],
    ['ADMIN-ARCH-AC-15', 'Given docs/architecture, When onboarding, Then admin-frontend.md exists', () => {
      assert.ok(existsSync(join(root, doc)), doc);
    }],
    ['ADMIN-ARCH-AC-16', 'Given AGENTS.md, When comparing it with the contract, Then the shared component and query rules are restated', () => {
      mentions(['ComponentName/index.tsx', 'interface Props', 'React.FC', 'Tプレフィックス', 'styles.ts', '5分', '10分', '4xx', '最大3回', 'ComponentName.stories.tsx']);
    }],
    ['ADMIN-ARCH-AC-17', 'Given the app, When checking architecture, Then a deterministic checker exists', () => {
      assert.ok(existsSync(join(app, 'scripts/check-architecture.mjs')), 'scripts/check-architecture.mjs');
      assert.match(pkg().scripts['check:architecture'], /check-architecture\.mjs/);
    }],
    ['ADMIN-ARCH-AC-18', 'Given the Harness, When verifying admin, Then the architecture check and its tests are verifier commands', () => {
      assert.match(pkg().scripts['test:architecture'], /node --test/);
      for (const script of ['check:architecture', 'test:architecture']) assert.ok(hasCommand(commands(), ['pnpm', 'run', script]), script);
    }],
    ['ADMIN-ARCH-AC-19', 'Given valid dependencies, When the checker runs on src, Then it passes', () => {
      assert.ok(hasCommand(commands(), ['pnpm', 'run', 'check:architecture']));
      assert.deepEqual(violations(), []);
    }],
    ['ADMIN-ARCH-AC-20', 'Given forbidden dependencies in fixtures, When the checker runs, Then its tests expect a failure for each kind', () => {
      const test = read('apps/admin/scripts/check-architecture.test.mjs');
      for (const kind of ['features/A → features/B', 'shared → features', 'shared → app', 'unknown top-level layer', 'layered → non-layer file']) assert.ok(test.includes(kind), kind);
    }],
    ['ADMIN-ARCH-AC-21', 'Given the Harness, When verifying admin, Then typecheck / Biome / Vitest / build stay registered', () => {
      for (const script of ['typecheck', 'check', 'test', 'build']) assert.ok(hasCommand(commands(), ['pnpm', 'run', script]), script);
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
