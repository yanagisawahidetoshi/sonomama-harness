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
});
