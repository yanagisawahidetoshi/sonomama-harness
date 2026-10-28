import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
// Trusted acceptance for SBI-MOBILE-ARCH (#31). Reads the worktree only; the expo verifier runs the architecture check and its tests.
const root = process.argv[2];
const app = join(root, 'apps/mobile');
const src = join(app, 'src');
const doc = 'docs/architecture/frontend.md';
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
const pkg = () => JSON.parse(read('apps/mobile/package.json'));
const deps = () => ({ ...pkg().dependencies, ...pkg().devDependencies });
const commands = () => JSON.parse(read('.harness/config/harness.json')).verifiers.find(v => v.id === 'expo').commands.map(c => c.join(' '));
const docText = () => read(doc);
const mentions = terms => { const text = docText(); for (const term of terms) assert.ok(text.includes(term), `${doc}: ${term}`); };
// Independent of the app's checker: every import must follow app → features → shared.
const imports = path => [...readFileSync(path, 'utf8').matchAll(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/g)].map(m => m[1]);
const target = (from, spec) => spec.startsWith('@/') ? join(src, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
const layer = path => {
  const [first, second] = relative(src, path).split('/');
  if (first === 'features') return { name: 'features', feature: second };
  return { name: ['app', 'shared', 'providers'].includes(first) ? first : 'other' };
};
const violations = () => code(src).flatMap(from => imports(from).flatMap(spec => {
  const to = target(from, spec);
  if (!to) return [];
  const a = layer(from), b = layer(to);
  const bad = (a.name === 'features' && b.name === 'features' && a.feature !== b.feature)
    || (a.name === 'features' && ['app', 'providers'].includes(b.name))
    || (a.name === 'shared' && ['features', 'app', 'providers'].includes(b.name))
    || (a.name === 'providers' && ['features', 'app'].includes(b.name));
  return bad ? [`${relative(app, from)} → ${spec}`] : [];
}));
try {
  const scenarios = [
    ['MOBILE-ARCH-AC-1', 'Given the #22 Expo environment, When reading apps/mobile/src, Then app / features / shared / providers exist', () => {
      for (const dir of ['app', 'features', 'shared', 'providers']) assert.ok(existsSync(join(src, dir)), dir);
      assert.ok(existsSync(join(app, 'app.json')), 'Expo environment from #22');
    }],
    ['MOBILE-ARCH-AC-2', 'Given the contract, When reading it, Then the responsibility of app / features / shared / providers is written', () => {
      mentions(['src/app', 'src/features', 'src/shared', 'src/providers']);
    }],
    ['MOBILE-ARCH-AC-3', 'Given the student app, When listing routes and features, Then nothing targets coaches, instructors or staff', () => {
      mentions(['受講生専用', 'apps/admin']);
      for (const path of files(join(src, 'app')).concat(files(join(src, 'features')))) {
        assert.doesNotMatch(relative(src, path), /\b(coach|instructor|teacher|mentor|mg|cs|staff|admin|ops)\b/i, relative(src, path));
      }
    }],
    ['MOBILE-ARCH-AC-4', 'Given the contract, When reading the dependency rule, Then app → features → shared is defined', () => {
      mentions(['app → features → shared']);
    }],
    ['MOBILE-ARCH-AC-5', 'Given the source, When following imports, Then no feature imports another feature and no layer imports upward', () => {
      mentions(['features/A → features/B']);
      assert.deepEqual(violations(), []);
    }],
    ['MOBILE-ARCH-AC-6', 'Given Expo Router, When reading src/app, Then routes only render feature screens', () => {
      for (const path of code(join(src, 'app'))) {
        const text = readFileSync(path, 'utf8');
        assert.doesNotMatch(text, /from ['"](axios|zod|react-hook-form)['"]|\buse(Query|Mutation|Form)\(|\bfetch\(/, relative(app, path));
        for (const spec of imports(path).filter(s => s.startsWith('@/features/'))) assert.match(spec, /^@\/features\/[\w-]+$/, `${relative(app, path)} imports a feature through its index`);
      }
      assert.ok(code(join(src, 'app')).some(p => /from ['"]@\/features\/[\w-]+['"]/.test(readFileSync(p, 'utf8'))), 'a route renders a feature screen');
    }],
    ['MOBILE-ARCH-AC-7', 'Given the contract, When reading the feature layout, Then api / components / hooks / schemas / types / screens / index.ts are defined', () => {
      mentions(['api/', 'components/', 'hooks/', 'schemas/', 'types/', 'screens/', 'index.ts']);
      const features = readdirSync(join(src, 'features'));
      assert.ok(features.length > 0, 'at least one feature');
      for (const name of features) assert.ok(existsSync(join(src, 'features', name, 'index.ts')), `features/${name}/index.ts`);
    }],
    ['MOBILE-ARCH-AC-8', 'Given the contract, When promoting code, Then only code used by several features moves to shared', () => {
      mentions(['複数Feature', 'shared/components']);
    }],
    ['MOBILE-ARCH-AC-9', 'Given the contract, When managing state, Then TanStack Query / React Hook Form / Zod / React state are the defaults', () => {
      mentions(['TanStack Query', 'React Hook Form', 'Zod', 'useState', 'useReducer', 'staleTime', 'gcTime']);
    }],
    ['MOBILE-ARCH-AC-10', 'Given the dependencies, When listing them, Then no global state library is installed', () => {
      for (const name of Object.keys(deps())) assert.doesNotMatch(name, /redux|zustand|jotai|mobx|recoil|valtio/i, name);
      mentions(['Redux', 'Zustand', 'ADR']);
    }],
    ['MOBILE-ARCH-AC-11', 'Given components and screens, When calling the API, Then only shared/api and feature api modules touch Axios', () => {
      mentions(['shared HTTP client']);
      for (const path of code(src)) {
        if (/\/(shared\/api|features\/[\w-]+\/api)\//.test(path)) continue;
        assert.doesNotMatch(readFileSync(path, 'utf8'), /from ['"]axios['"]|\bfetch\(/, relative(app, path));
      }
    }],
    ['MOBILE-ARCH-AC-12', 'Given TypeScript, Metro and Jest, When importing with @/, Then the path alias resolves', () => {
      assert.match(read('apps/mobile/tsconfig.json'), /"@\/\*"\s*:\s*\[\s*"\.\/src\/\*"\s*\]/);
      assert.match(read('apps/mobile/jest.config.js'), /'\^@\/\(\.\*\)\$'\s*:\s*'<rootDir>\/src\/\$1'/);
      assert.ok(code(src).some(p => /from ['"]@\/(features|shared|providers)\//.test(readFileSync(p, 'utf8'))), 'source uses the alias');
    }],
    ['MOBILE-ARCH-AC-13', 'Given docs/architecture, When onboarding, Then frontend.md exists', () => {
      assert.ok(existsSync(join(root, doc)), doc);
    }],
    ['MOBILE-ARCH-AC-14', 'Given AGENTS.md, When comparing it with the contract, Then the shared component and query rules are restated', () => {
      mentions(['ComponentName/index.tsx', 'interface Props', 'React.FC', 'Tプレフィックス', 'styles.ts', '5分', '10分', '4xx', '最大3回', 'ComponentName.stories.tsx']);
    }],
    ['MOBILE-ARCH-AC-15', 'Given the app, When checking architecture, Then a deterministic checker exists', () => {
      assert.ok(existsSync(join(app, 'scripts/check-architecture.mjs')), 'scripts/check-architecture.mjs');
      assert.match(pkg().scripts['check:architecture'], /check-architecture\.mjs/);
    }],
    ['MOBILE-ARCH-AC-16', 'Given the Harness, When verifying mobile, Then the architecture check and its tests are verifier commands', () => {
      assert.match(pkg().scripts['test:architecture'], /node --test/);
      for (const script of ['check:architecture', 'test:architecture']) assert.ok(commands().some(c => c.includes(`run ${script}`)), script);
    }],
    ['MOBILE-ARCH-AC-17', 'Given valid dependencies, When the checker runs on src, Then it passes', () => {
      assert.ok(commands().some(c => c.includes('run check:architecture')));
      assert.deepEqual(violations(), []);
    }],
    ['MOBILE-ARCH-AC-18', 'Given forbidden dependencies in fixtures, When the checker runs, Then its tests expect a failure for each kind', () => {
      const test = read('apps/mobile/scripts/check-architecture.test.mjs');
      for (const kind of ['features/A → features/B', 'shared → features', 'shared → app']) assert.ok(test.includes(kind), kind);
    }],
    ['MOBILE-ARCH-AC-19', 'Given the Harness, When verifying mobile, Then typecheck / Biome / test stay registered', () => {
      for (const script of ['typecheck', 'check', 'test']) assert.ok(commands().some(c => c.includes(`run ${script}`)), script);
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
