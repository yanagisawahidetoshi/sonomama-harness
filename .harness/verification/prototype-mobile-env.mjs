import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
// Trusted acceptance for SBI-PROTOTYPE-MOBILE-ENV (#25). Reads the worktree only; the prototype-mobile verifier runs the commands.
const root = process.argv[2];
const app = join(root, 'prototypes/mobile');
const read = path => readFileSync(join(root, path), 'utf8');
const files = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.expo', 'ios', 'android'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    entry.isDirectory() ? files(path, out) : out.push(path);
  }
  return out;
};
const code = () => [...files(join(app, 'src')), ...files(join(app, '.rnstorybook')), join(app, 'index.ts')]
  .filter(p => /\.(ts|tsx)$/.test(p) && existsSync(p));
const source = () => code().map(p => readFileSync(p, 'utf8')).join('\n');
const pkg = () => JSON.parse(read('prototypes/mobile/package.json'));
const deps = () => ({ ...pkg().dependencies, ...pkg().devDependencies });
const hasDeps = names => { const all = deps(); for (const name of names) assert.ok(all[name], `missing dependency ${name}`); };
const forbids = (pattern, label) => { for (const name of Object.keys(deps())) assert.doesNotMatch(name, pattern, `${label}: ${name}`); };
const commands = () => JSON.parse(read('.harness/config/harness.json')).verifiers.find(v => v.id === 'prototype-mobile').commands.map(c => c.join(' '));
try {
  const scenarios = [
    ['PMOB-AC-1', 'Given prototypes/mobile, When reading it, Then the prototype package exists', () => {
      assert.equal(pkg().name, 'prototype-mobile');
      assert.equal(pkg().private, true);
    }],
    ['PMOB-AC-2', 'Given the monorepo, When resolving workspaces, Then prototype-mobile is a locked pnpm workspace package', () => {
      assert.match(read('pnpm-workspace.yaml'), /['"]?prototypes\/\*['"]?/);
      assert.match(read('pnpm-lock.yaml'), /^ {2}prototypes\/mobile:$/m);
    }],
    ['PMOB-AC-3', 'Given the package, When starting, Then Expo SDK 58 + React Native + TypeScript run', () => {
      hasDeps(['expo', 'react', 'react-native', 'typescript']);
      assert.match(pkg().dependencies.expo, /^[~^]?58\./);
      assert.match(pkg().scripts.start, /expo start/);
      assert.ok(existsSync(join(app, 'app.json')), 'app.json');
    }],
    ['PMOB-AC-4', 'Given the app, When navigating screens, Then Expo Router routes live under src/app', () => {
      hasDeps(['expo-router']);
      assert.ok(files(join(app, 'src/app')).some(p => p.endsWith('_layout.tsx')), 'root layout');
    }],
    ['PMOB-AC-5', 'Given the package, When designers open Storybook, Then React Native Storybook is configured', () => {
      hasDeps(['@storybook/react-native']);
      // storybook is the peer of @storybook/react-native; it is resolved from the workspace root so its bin does not shadow the storybook script.
      const rootPkg = JSON.parse(read('package.json'));
      assert.ok(deps().storybook || rootPkg.devDependencies?.storybook, 'storybook available to the package');
      assert.ok(existsSync(join(app, '.rnstorybook/main.ts')), '.rnstorybook/main.ts');
      assert.match(pkg().scripts.storybook, /STORYBOOK/);
    }],
    ['PMOB-AC-6', 'Given the entry point, When Storybook is enabled, Then a dedicated entry selected by the storybook script replaces Expo Router instead of a route', () => {
      const entry = read('prototypes/mobile/index.ts');
      assert.equal(pkg().main, 'index.ts');
      assert.match(entry, /\.rnstorybook/);
      assert.match(entry, /expo-router\/entry/);
      // The storybook script, the entry switch, Metro and the README must agree on one variable name.
      const name = pkg().scripts.storybook.match(/\b(EXPO_PUBLIC_\w+)=true\b/)?.[1];
      assert.ok(name, 'storybook script sets an EXPO_PUBLIC_ variable');
      const reads = new RegExp(`process\\.env\\.${name}\\b`);
      assert.match(entry, reads, `index.ts reads ${name}`);
      assert.match(read('prototypes/mobile/metro.config.js'), reads, `metro.config.js reads ${name}`);
      assert.ok(read('prototypes/mobile/README.md').includes(`${name}=true`), `README sets ${name}`);
      assert.ok(!files(join(app, 'src/app')).some(p => /storybook/i.test(readFileSync(p, 'utf8'))), 'no Storybook inside Expo Router routes');
    }],
    ['PMOB-AC-7', 'Given the package, When running on simulators, Then ios / android / storybook scripts exist and the README explains them', () => {
      for (const name of ['ios', 'android', 'storybook']) assert.ok(pkg().scripts[name], name);
      const readme = read('prototypes/mobile/README.md');
      for (const term of ['iOS Simulator', 'Android Emulator', 'pnpm --filter prototype-mobile storybook']) assert.ok(readme.includes(term), term);
    }],
    ['PMOB-AC-8', 'Given the package, When linting and formatting, Then Biome is configured and ESLint / Prettier are absent', () => {
      hasDeps(['@biomejs/biome']);
      assert.ok(existsSync(join(app, 'biome.json')), 'biome.json');
      for (const name of ['lint', 'format:check', 'check']) assert.match(pkg().scripts[name], /\bbiome\b/, name);
      forbids(/eslint|prettier/i, 'ESLint/Prettier must not be installed');
      assert.ok(commands().some(c => c.includes('run check')));
    }],
    ['PMOB-AC-9', 'Given the Harness, When verifying the prototype, Then typecheck is registered', () => {
      assert.match(pkg().scripts.typecheck, /\btsc\b/);
      assert.ok(commands().some(c => c.includes('run typecheck')));
    }],
    ['PMOB-AC-10', 'Given the Harness, When verifying the prototype, Then Expo Doctor is registered', () => {
      assert.match(pkg().scripts.doctor, /expo-doctor/);
      assert.ok(commands().some(c => c.includes('run doctor')));
    }],
    ['PMOB-AC-11', 'Given the source, When listing stories, Then at least one React Native component has a story', () => {
      const stories = code().filter(p => p.endsWith('.stories.tsx'));
      assert.ok(stories.length > 0, 'at least one story');
      for (const story of stories) assert.ok(existsSync(join(story, '..', 'index.tsx')), `${relative(app, story)} sits next to its component`);
      assert.match(source(), /from ['"]react-native['"]/);
    }],
    ['PMOB-AC-12', 'Given the stories, When rendering states, Then they read local mock data only', () => {
      assert.ok(files(join(app, 'src')).some(p => /\/mocks\//.test(p)), 'local mock data directory');
      assert.match(source(), /from ['"][./]+.*mocks/);
    }],
    ['PMOB-AC-13', 'Given the prototype, When it runs, Then it never calls a remote API', () => {
      forbids(/^axios$|^@tanstack\/react-query$|^ky$|^graphql|^@apollo\//, 'Prototype must not ship an API client');
      assert.doesNotMatch(source(), /\bfetch\(|XMLHttpRequest|new WebSocket\(|https?:\/\/(?!localhost|127\.0\.0\.1)/);
      assert.doesNotMatch(source(), /EXPO_PUBLIC_API/);
    }],
    ['PMOB-AC-14', 'Given the prototype, When listing files, Then no env file, token or credential is kept', () => {
      for (const path of files(app)) assert.doesNotMatch(relative(app, path), /(^|\/)\.env|\.(pem|key|p12|p8|jks|mobileprovision)$|credential|secret/i);
      assert.doesNotMatch(source(), /(token|password|secret|api_?key)\s*[:=]\s*['"][^'"]+['"]/i);
      forbids(/async-storage|expo-secure-store|expo-notifications|amplify|cognito|firebase/i, 'No storage, push or auth SDK');
    }],
    ['PMOB-AC-15', 'Given the prototype, When reading imports, Then it is separated from apps/mobile', () => {
      assert.doesNotMatch(source(), /apps\/mobile|from ['"]mobile['"]|from ['"]mobile\//);
      assert.ok(!Object.keys(deps()).includes('mobile'), 'no dependency on mobile');
      assert.notEqual(JSON.parse(read('prototypes/mobile/app.json')).expo.ios?.bundleIdentifier, JSON.parse(read('apps/mobile/app.json')).expo.ios?.bundleIdentifier);
    }],
    ['PMOB-AC-16', 'Given the README, When onboarding a designer, Then purpose, commands, mock policy and the promotion flow are documented', () => {
      const readme = read('prototypes/mobile/README.md');
      for (const term of ['本番コードではない', 'pnpm install', 'pnpm --filter prototype-mobile start', 'pnpm --filter prototype-mobile check',
        'pnpm --filter prototype-mobile typecheck', 'expo-doctor', '.stories.tsx', 'EXPO_PUBLIC_STORYBOOK', 'mock', 'secret',
        'Design Approval', 'Production SBI', 'apps/mobile']) assert.ok(readme.includes(term), term);
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
