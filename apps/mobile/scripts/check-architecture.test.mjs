import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { checkArchitecture } from './check-architecture.mjs';

const fixture = (files) => {
  const src = mkdtempSync(join(tmpdir(), 'mobile-arch-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  return src;
};

const valid = {
  'app/_layout.tsx': "import { QueryProvider } from '@/providers/QueryProvider';\n",
  'app/index.tsx': "import { HomeScreen } from '@/features/home';\n",
  'providers/QueryProvider/index.tsx': "import { createQueryClient } from '@/shared/api';\n",
  'features/home/index.ts': "export { HomeScreen } from './screens/HomeScreen';\n",
  'features/home/screens/HomeScreen/index.tsx':
    "import { PageHeading } from '@/shared/components/PageHeading';\nimport { useHome } from '../../hooks/useHome';\n",
  'features/home/hooks/useHome.ts': "import { useQuery } from '@tanstack/react-query';\n",
  'shared/components/PageHeading/index.tsx': "import { tokens } from '../../theme';\n",
  'shared/theme/index.ts': 'export const tokens = {};\n',
  'shared/api/index.ts': "export * from './http-client';\n",
  'env.d.ts': 'declare module "*.png";\n',
};

describe('checkArchitecture', () => {
  describe('given app → features → shared imports only', () => {
    it('when checking then reports no violation', () => {
      assert.deepEqual(checkArchitecture(fixture(valid)), []);
    });
  });

  describe('given features/A → features/B', () => {
    it('when a feature imports another feature through the alias then reports it', () => {
      const src = fixture({ ...valid, 'features/lessons/index.ts': "import { HomeScreen } from '@/features/home';\n" });
      assert.deepEqual(checkArchitecture(src), [
        { file: 'features/lessons/index.ts', specifier: '@/features/home', rule: 'features/A → features/B' },
      ]);
    });

    it('when a feature imports another feature through a relative path then reports it', () => {
      const src = fixture({
        ...valid,
        'features/lessons/screens/Lessons/index.tsx': "import { useHome } from '../../../home/hooks/useHome';\n",
      });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['features/A → features/B'],
      );
    });
  });

  describe('given shared → features', () => {
    it('when shared imports a feature then reports it', () => {
      const src = fixture({ ...valid, 'shared/lib/format.ts': "export { HomeScreen } from '@/features/home';\n" });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['shared → features'],
      );
    });
  });

  describe('given shared → app', () => {
    it('when shared imports the root layout then reports it', () => {
      const src = fixture({ ...valid, 'shared/lib/navigate.ts': "const load = () => import('@/app/_layout');\n" });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['shared → app'],
      );
    });
  });

  describe('given other upward imports', () => {
    it('when a feature imports app or providers then reports both', () => {
      const src = fixture({
        ...valid,
        'features/home/hooks/useRouter.ts':
          "import RootLayout from '@/app/_layout';\nimport { QueryProvider } from '@/providers/QueryProvider';\n",
      });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['features → app', 'features → providers'],
      );
    });

    it('when app imports a feature internal module instead of its index then reports it', () => {
      const src = fixture({
        ...valid,
        'app/index.tsx': "import { HomeScreen } from '@/features/home/screens/HomeScreen';\n",
      });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['app → features/<feature>/index.ts only'],
      );
    });
  });

  describe('given a declaration file outside the layers', () => {
    it('when env.d.ts sits next to the layers then reports no violation', () => {
      assert.deepEqual(checkArchitecture(fixture(valid)), []);
    });

    it('when a feature imports the declaration file then reports it, so it cannot become a detour', () => {
      const src = fixture({ ...valid, 'features/home/hooks/useEnv.ts': "import '@/env.d';\n" });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['layered → non-layer file'],
      );
    });
  });

  describe('given an unclassified top-level directory such as src/lib', () => {
    it('when a feature imports it through the alias then reports it', () => {
      const src = fixture({
        ...valid,
        'lib/format.ts': 'export const format = String;\n',
        'features/home/hooks/useFormat.ts': "import { format } from '@/lib/format';\n",
      });
      assert.deepEqual(checkArchitecture(src), [
        { file: 'features/home/hooks/useFormat.ts', specifier: '@/lib/format', rule: 'unknown top-level layer' },
      ]);
    });

    it('when a feature imports it through a relative path then reports the same rule', () => {
      const src = fixture({
        ...valid,
        'lib/format.ts': 'export const format = String;\n',
        'features/home/hooks/useFormat.ts': "import { format } from '../../../lib/format';\n",
      });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['unknown top-level layer'],
      );
    });

    it('when features/A reaches features/B through it then reports both hops', () => {
      const src = fixture({
        ...valid,
        'lib/bridge.ts': "export { HomeScreen } from '@/features/home';\n",
        'features/lessons/index.ts': "export { HomeScreen } from '@/lib/bridge';\n",
      });
      assert.deepEqual(
        checkArchitecture(src)
          .map((v) => `${v.file}: ${v.rule}`)
          .sort(),
        ['features/lessons/index.ts: unknown top-level layer', 'lib/bridge.ts: unknown top-level layer'],
      );
    });

    it('when shared imports it then reports it', () => {
      const src = fixture({
        ...valid,
        'lib/format.ts': 'export const format = String;\n',
        'shared/lib/date.ts': "export { format } from '../../lib/format';\n",
      });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['unknown top-level layer'],
      );
    });
  });

  describe('given a relative import that leaves src', () => {
    it('when a feature imports a file outside src then reports it as an unknown layer', () => {
      const src = fixture({
        ...valid,
        'features/home/hooks/useOutside.ts': "import { x } from '../../../../outside';\n",
      });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['unknown top-level layer'],
      );
    });
  });
});
