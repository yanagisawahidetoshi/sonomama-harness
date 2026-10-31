import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hasCommand } from './lib/commands.mjs';
import { assertAuthSection } from './lib/readme.mjs';
// Trusted acceptance for SBI-ADMIN-ENV (#20). Reads the worktree only; the admin application verifier runs the commands.
const root = process.argv[2];
const app = join(root, 'apps/admin');
const read = path => readFileSync(join(root, path), 'utf8');
const files = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    entry.isDirectory() ? files(path, out) : out.push(path);
  }
  return out;
};
const source = () => files(join(app, 'src')).filter(p => /\.(ts|tsx)$/.test(p)).map(p => readFileSync(p, 'utf8')).join('\n');
const pkg = () => JSON.parse(read('apps/admin/package.json'));
const deps = () => ({ ...pkg().dependencies, ...pkg().devDependencies });
const hasDeps = names => { const all = deps(); for (const name of names) assert.ok(all[name], `missing dependency ${name}`); };
const forbids = (pattern, label) => {
  for (const name of Object.keys(deps())) assert.doesNotMatch(name, pattern, `${label}: ${name}`);
};
try {
  const scenarios = [
    ['ADMIN-AC-1', 'Given apps/admin, When reading it, Then React + TypeScript + Vite exists', () => {
      hasDeps(['react', 'react-dom', 'vite', 'typescript', '@vitejs/plugin-react']);
      assert.match(pkg().dependencies.react, /^\^?19\./);
      for (const path of ['index.html', 'vite.config.ts', 'tsconfig.json', 'src/main.tsx']) assert.ok(existsSync(join(app, path)), path);
    }],
    ['ADMIN-AC-2', 'Given the monorepo, When resolving workspaces, Then admin is a locked pnpm workspace package', () => {
      assert.equal(pkg().name, 'admin');
      assert.match(read('pnpm-workspace.yaml'), /['"]?apps\/\*['"]?/);
      assert.match(read('pnpm-lock.yaml'), /^ {2}apps\/admin:$/m);
    }],
    ['ADMIN-AC-3', 'Given the app, When routing, Then TanStack Router is wired', () => {
      hasDeps(['@tanstack/react-router']);
      assert.match(source(), /createRouter\(/);
      assert.match(source(), /RouterProvider/);
    }],
    ['ADMIN-AC-4', 'Given the app, When fetching server state, Then TanStack Query is provided', () => {
      hasDeps(['@tanstack/react-query']);
      assert.match(source(), /QueryClientProvider/);
    }],
    ['ADMIN-AC-5', 'Given the app, When calling an API, Then a shared Axios instance exists', () => {
      hasDeps(['axios']);
      assert.match(source(), /axios\.create\(/);
    }],
    ['ADMIN-AC-6', 'Given the app, When building a form, Then React Hook Form and Zod are connected', () => {
      hasDeps(['react-hook-form', 'zod', '@hookform/resolvers']);
    }],
    ['ADMIN-AC-7', 'Given the app, When linting and formatting, Then Biome is configured', () => {
      hasDeps(['@biomejs/biome']);
      assert.ok(['biome.json', 'biome.jsonc'].some(name => existsSync(join(app, name))), 'biome config');
    }],
    ['ADMIN-AC-8', 'Given the app, When listing tools, Then ESLint and Prettier are absent', () => {
      forbids(/eslint|prettier/i, 'ESLint/Prettier must not be installed');
      for (const name of readdirSync(app)) assert.doesNotMatch(name, /^\.?(eslint|prettier)/i, name);
    }],
    ['ADMIN-AC-9', 'Given the app, When configuring the API, Then VITE_API_BASE_URL is templated and validated', () => {
      assert.match(read('apps/admin/.env.example'), /^VITE_API_BASE_URL=http:\/\/127\.0\.0\.1:4010$/m);
      assert.match(source(), /import\.meta\.env\.VITE_API_BASE_URL|VITE_API_BASE_URL/);
    }],
    ['ADMIN-AC-10', 'Given the package, When listing scripts, Then dev/build/typecheck/lint/format:check/check/test exist and use Biome', () => {
      const scripts = pkg().scripts;
      for (const name of ['dev', 'build', 'typecheck', 'lint', 'format:check', 'check', 'test']) assert.ok(scripts[name], name);
      for (const name of ['lint', 'format:check', 'check']) assert.match(scripts[name], /\bbiome\b/, name);
      assert.match(scripts.test, /\bvitest\b/);
    }],
    ['ADMIN-AC-11', 'Given the app, When testing, Then Vitest + RTL + jsdom and at least one test exist', () => {
      hasDeps(['vitest', '@testing-library/react', '@testing-library/jest-dom', 'jsdom']);
      assert.ok(files(join(app, 'src')).some(p => /\.test\.tsx?$/.test(p)), 'at least one test');
    }],
    ['ADMIN-AC-12', 'Given the package, When building for production, Then vite build is the build script', () => {
      assert.match(pkg().scripts.build, /\bvite build\b/);
    }],
    ['ADMIN-AC-13', 'Given the Harness, When verifying admin, Then typecheck, Biome check, test and build are registered', () => {
      const admin = JSON.parse(read('.harness/config/harness.json')).verifiers.find(v => v.id === 'admin');
      for (const script of ['typecheck', 'check', 'test', 'build']) assert.ok(hasCommand(admin.commands, ['pnpm', 'run', script]), script);
    }],
    ['ADMIN-AC-14', 'Given the app, When listing dependencies, Then no auth provider SDK is installed', () => {
      forbids(/amplify|cognito|firebase|google-auth|@react-oauth|oidc|auth0|@clerk|supabase/i, 'Auth provider SDK must not be installed');
    }],
    // #123: Sparkle Design is the UI foundation, pinned exactly while it is a 2.x beta and used only through shared/components/ui wrappers.
    ['ADMIN-AC-15', 'Given the app, When listing dependencies and imports, Then Sparkle Design is the only UI component library and is used through shared/components/ui', () => {
      assert.match(pkg().dependencies?.['sparkle-design'] ?? '', /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, 'sparkle-design must be an exact-pinned dependency');
      forbids(/^@mui\/|^@chakra-ui\/|^antd$|^@mantine\/|^@radix-ui\/|^react-bootstrap$|^@headlessui\/|^@nextui-org\/|^@heroui\//, 'UI component library other than Sparkle Design must not be installed');
      const wrappers = join(app, 'src/shared/components/ui');
      assert.ok(files(wrappers).some(p => /\/index\.tsx$/.test(p)), 'at least one wrapper in src/shared/components/ui');
      const direct = /\bfrom\s+['"]sparkle-design(?:\/[^'"]*)?['"]|\bimport\s*\(\s*['"]sparkle-design(?:\/[^'"]*)?['"]|\bimport\s+['"]sparkle-design(?:\/[^'"]*)?['"]/;
      for (const path of files(join(app, 'src')).filter(p => /\.(ts|tsx)$/.test(p) && !p.startsWith(`${wrappers}/`))) {
        assert.doesNotMatch(readFileSync(path, 'utf8'), direct, `sparkle-design must be imported only from src/shared/components/ui: ${relative(root, path)}`);
      }
    }],
    ['ADMIN-AC-16', 'Given the README, When onboarding, Then the development steps are documented', () => {
      const readme = read('apps/admin/README.md');
      for (const term of ['Node', 'pnpm install', 'pnpm --filter admin dev', 'pnpm --filter admin build', 'pnpm --filter admin test',
        'pnpm --filter admin check', 'pnpm --filter admin typecheck', 'VITE_API_BASE_URL', 'pnpm api:mock']) assert.ok(readme.includes(term), term);
      assertAuthSection(readme);
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
