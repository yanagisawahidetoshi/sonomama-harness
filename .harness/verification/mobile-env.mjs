import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hasCommand } from './lib/commands.mjs';
import { assertAuthSection } from './lib/readme.mjs';
// Trusted acceptance for SBI-MOBILE-ENV (#22, #135). Reads the worktree only; the expo application verifier runs the commands.
const root = process.argv[2];
const app = join(root, 'apps/mobile');
const read = path => readFileSync(join(root, path), 'utf8');
const files = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.expo', 'ios', 'android'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    entry.isDirectory() ? files(path, out) : out.push(path);
  }
  return out;
};
const source = () => files(join(app, 'src')).filter(p => /\.(ts|tsx)$/.test(p)).map(p => readFileSync(p, 'utf8')).join('\n');
const pkg = () => JSON.parse(read('apps/mobile/package.json'));
const deps = () => ({ ...pkg().dependencies, ...pkg().devDependencies });
const hasDeps = names => { const all = deps(); for (const name of names) assert.ok(all[name], `missing dependency ${name}`); };
const tokens = script => script.split(/\s+/);
const tableRow = (markdown, name) => markdown.split('\n').find(line => line.split('|')[1]?.trim() === name) ?? '';
const forbids = (pattern, label) => {
  for (const name of Object.keys(deps())) assert.doesNotMatch(name, pattern, `${label}: ${name}`);
};
try {
  const scenarios = [
    ['MOBILE-AC-1', 'Given apps/mobile, When reading it, Then Expo SDK 58 + React Native + TypeScript exists', () => {
      hasDeps(['expo', 'react', 'react-native', 'typescript']);
      assert.match(pkg().dependencies.expo, /^[~^]?58\./);
      for (const path of ['app.json', 'tsconfig.json']) assert.ok(existsSync(join(app, path)), path);
    }],
    ['MOBILE-AC-2', 'Given the monorepo, When resolving workspaces, Then mobile is a locked pnpm workspace package', () => {
      assert.equal(pkg().name, 'mobile');
      assert.match(read('pnpm-workspace.yaml'), /['"]?apps\/\*['"]?/);
      assert.match(read('pnpm-lock.yaml'), /^ {2}apps\/mobile:$/m);
    }],
    ['MOBILE-AC-3', 'Given the app, When navigating, Then Expo Router is the entry and routes live under src/app', () => {
      hasDeps(['expo-router']);
      assert.equal(pkg().main, 'expo-router/entry');
      assert.ok(files(join(app, 'src/app')).some(p => /_layout\.tsx$/.test(p)), 'root layout');
    }],
    ['MOBILE-AC-4', 'Given the app, When fetching server state, Then TanStack Query is provided', () => {
      hasDeps(['@tanstack/react-query']);
      assert.match(source(), /QueryClientProvider/);
    }],
    ['MOBILE-AC-5', 'Given the app, When calling an API, Then a shared Axios instance exists', () => {
      hasDeps(['axios']);
      assert.match(source(), /axios\.create\(/);
    }],
    ['MOBILE-AC-6', 'Given the app, When building a form, Then React Hook Form and Zod are installed', () => {
      hasDeps(['react-hook-form', 'zod', '@hookform/resolvers']);
    }],
    ['MOBILE-AC-7', 'Given the app, When linting and formatting, Then Biome is configured', () => {
      hasDeps(['@biomejs/biome']);
      assert.ok(['biome.json', 'biome.jsonc'].some(name => existsSync(join(app, name))), 'biome config');
    }],
    ['MOBILE-AC-8', 'Given the app, When listing tools, Then ESLint and Prettier are absent', () => {
      forbids(/eslint|prettier/i, 'ESLint/Prettier must not be installed');
      for (const name of readdirSync(app)) assert.doesNotMatch(name, /^\.?(eslint|prettier)/i, name);
    }],
    ['MOBILE-AC-9', 'Given the app, When configuring the API, Then EXPO_PUBLIC_API_BASE_URL is templated and read', () => {
      assert.match(read('apps/mobile/.env.example'), /^EXPO_PUBLIC_API_BASE_URL=http:\/\/127\.0\.0\.1:4010$/m);
      assert.match(source(), /process\.env\.EXPO_PUBLIC_API_BASE_URL/);
    }],
    ['MOBILE-AC-10', 'Given the package, When listing scripts, Then start/ios/android/typecheck/lint/format:check/check/test exist', () => {
      const scripts = pkg().scripts;
      for (const name of ['start', 'ios', 'android', 'typecheck', 'lint', 'format:check', 'check', 'test']) assert.ok(scripts[name], name);
      for (const name of ['lint', 'format:check', 'check']) assert.match(scripts[name], /\bbiome\b/, name);
      assert.match(scripts.test, /\bjest\b/);
    }],
    ['MOBILE-AC-11', 'Given the package, When checking Expo dependencies, Then expo-doctor is runnable', () => {
      assert.match(pkg().scripts.doctor, /\bexpo-doctor\b/);
    }],
    ['MOBILE-AC-12', 'Given the app, When testing, Then jest-expo + RNTL and at least one test exist', () => {
      hasDeps(['jest-expo', '@testing-library/react-native', 'jest']);
      assert.ok(files(join(app, 'src')).some(p => /\.test\.tsx?$/.test(p)), 'at least one test');
    }],
    ['MOBILE-AC-13', 'Given Maestro, When reading the smoke flow, Then it launches the app and asserts a stable element', () => {
      const flow = read('apps/mobile/.maestro/smoke.yaml');
      assert.match(flow, /^appId:\s*\S+/m);
      assert.match(flow, /launchApp/);
      assert.match(flow, /assertVisible/);
      const id = flow.match(/id:\s*["']?([\w-]+)/)?.[1];
      assert.ok(id && source().includes(`testID="${id}"`), 'smoke flow asserts a testID rendered by the app');
    }],
    ['MOBILE-AC-14', 'Given Maestro, When running smoke locally, Then the README explains the development build flow', () => {
      const readme = read('apps/mobile/README.md');
      for (const term of ['maestro test apps/mobile/.maestro/smoke.yaml', 'development build', 'expo run:ios', 'expo run:android']) assert.ok(readme.includes(term), term);
    }],
    ['MOBILE-AC-15', 'Given the Harness, When verifying mobile, Then typecheck, Biome check, Jest and Expo Doctor are registered', () => {
      const expo = JSON.parse(read('.harness/config/harness.json')).verifiers.find(v => v.id === 'expo');
      for (const script of ['typecheck', 'check', 'test', 'doctor']) assert.ok(hasCommand(expo.commands, ['pnpm', 'run', script]), script);
    }],
    ['MOBILE-AC-16', 'Given the Harness, When verifying mobile, Then Maestro stays out of the normal mobile verifier and is required only for Maestro-target SBIs', () => {
      const expo = JSON.parse(read('.harness/config/harness.json')).verifiers.find(v => v.id === 'expo');
      for (const c of expo.commands) assert.doesNotMatch(c.join(' '), /maestro/i, 'expo');
      forbids(/maestro/i, 'Maestro is an external CLI');
      assert.match(read('tools/harness/impact.mjs'), /maestro: maestroLanes\(runSbis\)/, 'Impact Analysis selects the Maestro lanes from the SBIs');
      const readme = read('apps/mobile/README.md');
      assert.match(readme, /通常のmobile Verifier（`expo`）には入れず/);
      assert.match(readme, /implementation SBI: Mock API \+ Maestro/);
      assert.match(readme, /validation SBI: 実API \+ Rails \+ DB \+ Maestro/);
      for (const term of ['Android Emulator', 'native fingerprint']) assert.ok(readme.includes(term), term);
      assert.doesNotMatch(readme, /required checkにも含めない/);
    }],
    ['MOBILE-AC-17', 'Given the app, When listing dependencies, Then no auth provider SDK is installed', () => {
      forbids(/amplify|cognito|firebase|google-auth|@react-oauth|oidc|auth0|@clerk|supabase|expo-auth-session/i, 'Auth provider SDK must not be installed');
    }],
    ['MOBILE-AC-18', 'Given the app, When listing dependencies, Then unused native libraries are absent', () => {
      forbids(/async-storage|expo-secure-store|expo-notifications|expo-camera|expo-media-library|expo-location|analytics|sentry|crashlytics|bugsnag|^redux$|@reduxjs|^zustand$|^jotai$|^mobx/i, 'Native library must wait for requirements');
    }],
    ['MOBILE-AC-19', 'Given the app, When listing dependencies, Then no UI component library is fixed', () => {
      forbids(/^@expo\/ui$|^react-native-paper$|^native-base$|^@rneui\/|^react-native-elements$|^tamagui$|^@tamagui\/|^@gluestack-ui\/|^@ui-kitten\//, 'UI component library must not be fixed');
    }],
    ['MOBILE-AC-20', 'Given the README, When onboarding, Then the development steps are documented', () => {
      const readme = read('apps/mobile/README.md');
      for (const term of ['Node', 'pnpm install', 'SDK 58', 'pnpm --filter mobile start', 'pnpm --filter mobile ios', 'pnpm --filter mobile android',
        'pnpm --filter mobile test', 'pnpm --filter mobile check', 'pnpm --filter mobile typecheck', 'expo-doctor', 'brew install', 'EXPO_PUBLIC_API_BASE_URL',
        'pnpm api:mock', '10.0.2.2', 'LAN']) assert.ok(readme.includes(term), term);
      assertAuthSection(readme);
    }],
    ['MOBILE-AC-21', 'Given the package, When starting daily development, Then expo start targets Expo Go explicitly', () => {
      const start = tokens(pkg().scripts.start);
      assert.deepEqual(start.slice(0, 2), ['expo', 'start']);
      assert.ok(start.includes('--go') || start.includes('-g'), 'start must pass --go');
      assert.ok(!start.includes('--dev-client') && !start.includes('-d'), 'start must not target a development build');
    }],
    ['MOBILE-AC-22', 'Given the README, When onboarding, Then Expo Go is the primary target for daily development', () => {
      const readme = read('apps/mobile/README.md');
      assert.match(readme, /通常開発はExpo Goを主対象にする/);
      assert.doesNotMatch(readme, /Expo Goではなく/);
    }],
    ['MOBILE-AC-23', 'Given the README, When choosing integration and E2E tools, Then Maestro is required', () => {
      assert.match(read('apps/mobile/README.md'), /MaestroはMobile Integration \/ E2Eの必須ツール/);
    }],
    ['MOBILE-AC-24', 'Given the test layers, When running Mobile Integration, Then Maestro runs against a Mock API on a development build', () => {
      const row = tableRow(read('apps/mobile/README.md'), 'Mobile Integration');
      for (const term of ['Maestro', 'Mock API', 'development build']) assert.ok(row.includes(term), term);
    }],
    ['MOBILE-AC-25', 'Given the test layers, When running Mobile E2E, Then Maestro runs against the real API, Rails and DB on a development build', () => {
      const row = tableRow(read('apps/mobile/README.md'), 'Mobile E2E');
      for (const term of ['Maestro', '実API', 'Rails', 'DB', 'development build']) assert.ok(row.includes(term), term);
      assert.ok(!row.includes('Mock API'), 'E2E must not use the Mock API');
    }],
    ['MOBILE-AC-26', 'Given the test layers, When testing units and components, Then Jest + React Native Testing Library is kept', () => {
      hasDeps(['jest', '@testing-library/react-native']);
      const row = tableRow(read('apps/mobile/README.md'), 'Unit / Component');
      for (const term of ['Jest', 'React Native Testing Library']) assert.ok(row.includes(term), term);
      assert.ok(!row.includes('Maestro'), 'Unit / Component must not depend on Maestro');
    }],
    ['MOBILE-AC-27', 'Given the package, When Maestro or native features need it, Then the development build commands remain', () => {
      const scripts = pkg().scripts;
      assert.match(scripts.ios, /\bexpo run:ios\b/);
      assert.match(scripts.android, /\bexpo run:android\b/);
      assert.match(read('apps/mobile/README.md'), /development buildはMaestroのIntegration \/ E2Eと、Expo Goで扱えないnative機能/);
    }],
    // #145: expo-dev-client builds the CI Development Build for Maestro; daily development still opens Expo Go.
    ['MOBILE-AC-28', 'Given the package, When expo-dev-client is installed for the CI Development Build, Then daily development still starts in Expo Go', () => {
      assert.ok(pkg().dependencies['expo-dev-client'], 'expo-dev-client builds the Development Build that Maestro runs on');
      assert.match(pkg().scripts.start, /\bexpo start --go\b/, 'start opens Expo Go');
      assert.doesNotMatch(read('apps/mobile/README.md'), /expo-dev-client` を入れるとExpo Goで開けなくなる/);
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
