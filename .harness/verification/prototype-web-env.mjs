import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
// Trusted acceptance for SBI-PROTOTYPE-WEB-ENV (#24). Reads the worktree only; the prototype-web verifier runs the commands.
const root = process.argv[2];
const app = join(root, 'prototypes/web');
const read = path => readFileSync(join(root, path), 'utf8');
const files = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'storybook-static'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    entry.isDirectory() ? files(path, out) : out.push(path);
  }
  return out;
};
const sources = () => files(join(app, 'src')).filter(p => /\.(ts|tsx)$/.test(p));
const source = () => sources().map(p => readFileSync(p, 'utf8')).join('\n');
const pkg = () => JSON.parse(read('prototypes/web/package.json'));
const deps = () => ({ ...pkg().dependencies, ...pkg().devDependencies });
const hasDeps = names => { const all = deps(); for (const name of names) assert.ok(all[name], `missing dependency ${name}`); };
const forbids = (pattern, label) => { for (const name of Object.keys(deps())) assert.doesNotMatch(name, pattern, `${label}: ${name}`); };
const commands = () => JSON.parse(read('.harness/config/harness.json')).verifiers.find(v => v.id === 'prototype-web').commands.map(c => c.join(' '));
try {
  const scenarios = [
    ['PWEB-AC-1', 'Given prototypes/web, When reading it, Then the prototype package exists', () => {
      assert.equal(pkg().name, 'prototype-web');
      assert.equal(pkg().private, true);
    }],
    ['PWEB-AC-2', 'Given the monorepo, When resolving workspaces, Then prototype-web is a locked pnpm workspace package', () => {
      assert.match(read('pnpm-workspace.yaml'), /['"]?prototypes\/\*['"]?/);
      assert.match(read('pnpm-lock.yaml'), /^ {2}prototypes\/web:$/m);
    }],
    ['PWEB-AC-3', 'Given the package, When starting, Then React 19 + TypeScript + Vite run the dev server', () => {
      hasDeps(['react', 'react-dom', 'vite', 'typescript', '@vitejs/plugin-react']);
      assert.match(pkg().dependencies.react, /^\^?19\./);
      assert.match(pkg().scripts.dev, /^vite\b/);
      for (const path of ['index.html', 'vite.config.ts', 'src/main.tsx']) assert.ok(existsSync(join(app, path)), path);
    }],
    ['PWEB-AC-4', 'Given the package, When designers open Storybook, Then a React Vite Storybook is configured', () => {
      hasDeps(['storybook', '@storybook/react-vite']);
      assert.match(pkg().scripts.storybook, /storybook dev/);
      assert.ok(existsSync(join(app, '.storybook/main.ts')), '.storybook/main.ts');
    }],
    ['PWEB-AC-5', 'Given the Harness, When verifying the prototype, Then the Storybook static build is a registered command', () => {
      assert.match(pkg().scripts['build-storybook'], /storybook build/);
      assert.ok(commands().some(c => c.includes('run build-storybook')));
    }],
    ['PWEB-AC-6', 'Given the package, When linting and formatting, Then Biome is configured and ESLint / Prettier are absent', () => {
      hasDeps(['@biomejs/biome']);
      assert.ok(existsSync(join(app, 'biome.json')), 'biome.json');
      for (const name of ['lint', 'format:check', 'check']) assert.match(pkg().scripts[name], /\bbiome\b/, name);
      forbids(/eslint|prettier/i, 'ESLint/Prettier must not be installed');
      assert.ok(commands().some(c => c.includes('run check')));
    }],
    ['PWEB-AC-7', 'Given the Harness, When verifying the prototype, Then typecheck and Vite build are registered', () => {
      assert.match(pkg().scripts.typecheck, /\btsc\b/);
      for (const script of ['typecheck', 'build']) assert.ok(commands().some(c => c.includes(`run ${script}`)), script);
    }],
    ['PWEB-AC-8', 'Given the source, When listing stories, Then at least one sample component has a story', () => {
      const stories = sources().filter(p => p.endsWith('.stories.tsx'));
      assert.ok(stories.length > 0, 'at least one story');
      for (const story of stories) assert.ok(existsSync(join(story, '..', 'index.tsx')), `${relative(app, story)} sits next to its component`);
    }],
    ['PWEB-AC-9', 'Given the stories, When rendering states, Then they read local mock data only', () => {
      assert.ok(files(join(app, 'src')).some(p => /\/mocks\//.test(p)), 'local mock data directory');
      assert.match(source(), /from ['"][./]+.*mocks/);
    }],
    ['PWEB-AC-10', 'Given the prototype, When it runs, Then it never calls a remote API', () => {
      forbids(/^axios$|^@tanstack\/react-query$|^ky$|^graphql|^@apollo\//, 'Prototype must not ship an API client');
      assert.doesNotMatch(source(), /\bfetch\(|XMLHttpRequest|WebSocket\(|https?:\/\/(?!localhost|127\.0\.0\.1)/);
      assert.doesNotMatch(source(), /import\.meta\.env\.VITE_/);
    }],
    ['PWEB-AC-11', 'Given the prototype, When listing files, Then no env file, token or credential is kept', () => {
      for (const path of files(app)) assert.doesNotMatch(relative(app, path), /(^|\/)\.env|\.(pem|key|p12)$|credential|secret/i);
      assert.doesNotMatch(source(), /(token|password|secret|api_?key)\s*[:=]\s*['"][^'"]+['"]/i);
    }],
    ['PWEB-AC-12', 'Given the prototype, When reading imports, Then it is separated from apps/admin', () => {
      assert.doesNotMatch(source(), /apps\/admin|from ['"]admin['"]|from ['"]admin\//);
      assert.ok(!Object.keys(deps()).includes('admin'), 'no dependency on admin');
    }],
    ['PWEB-AC-13', 'Given the README, When onboarding a designer, Then purpose, commands, mock policy and the promotion flow are documented', () => {
      const readme = read('prototypes/web/README.md');
      for (const term of ['本番コードではない', 'pnpm install', 'pnpm --filter prototype-web dev', 'pnpm --filter prototype-web storybook',
        'pnpm --filter prototype-web check', 'pnpm --filter prototype-web typecheck', '.stories.tsx', 'mock', 'secret',
        'Design Approval', 'Production SBI', 'apps/admin']) assert.ok(readme.includes(term), term);
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
