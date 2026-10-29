import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { checkArchitecture } from './check-architecture.mjs';

const fixture = (files) => {
  const src = mkdtempSync(join(tmpdir(), 'admin-arch-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  return src;
};

const valid = {
  'main.tsx': "import { App } from './app/App';\n",
  'app/App.tsx': "import { QueryProvider } from '@/providers/QueryProvider';\nimport { router } from './router';\n",
  'app/router.tsx': "import { HomePage } from '@/features/home';\n",
  'providers/QueryProvider/index.tsx': "import { createQueryClient } from '@/shared/api';\n",
  'features/home/index.ts': "export { HomePage } from './pages/HomePage';\n",
  'features/home/pages/HomePage/index.tsx':
    "import { PageHeading } from '@/shared/components/PageHeading';\nimport { useHome } from '../../hooks/useHome';\n",
  'features/home/hooks/useHome.ts': "import { useQuery } from '@tanstack/react-query';\n",
  'shared/components/PageHeading/index.tsx': "import { tokens } from '../../theme';\n",
  'shared/theme/index.ts': 'export const tokens = {};\n',
  'shared/api/index.ts': "export * from './http-client';\n",
  'test/setup.ts': "import '@testing-library/jest-dom/vitest';\nimport { tokens } from '@/shared/theme';\n",
  'vite-env.d.ts': '/// <reference types="vite/client" />\n',
};

describe('checkArchitecture', () => {
  describe('given app → features → shared imports only', () => {
    it('when checking then reports no violation', () => {
      assert.deepEqual(checkArchitecture(fixture(valid)), []);
    });
  });

  describe('given features/A → features/B', () => {
    it('when a feature imports another feature through the alias then reports it', () => {
      const src = fixture({ ...valid, 'features/billing/index.ts': "import { HomePage } from '@/features/home';\n" });
      assert.deepEqual(checkArchitecture(src), [
        { file: 'features/billing/index.ts', specifier: '@/features/home', rule: 'features/A → features/B' },
      ]);
    });

    it('when a feature imports another feature through a relative path then reports it', () => {
      const src = fixture({
        ...valid,
        'features/billing/pages/Bill/index.tsx': "import { useHome } from '../../../home/hooks/useHome';\n",
      });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['features/A → features/B'],
      );
    });
  });

  describe('given shared → features', () => {
    it('when shared imports a feature then reports it', () => {
      const src = fixture({ ...valid, 'shared/lib/format.ts': "export { HomePage } from '@/features/home';\n" });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['shared → features'],
      );
    });
  });

  describe('given shared → app', () => {
    it('when shared imports the router then reports it', () => {
      const src = fixture({ ...valid, 'shared/lib/navigate.ts': "const load = () => import('@/app/router');\n" });
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
          "import { router } from '@/app/router';\nimport { QueryProvider } from '@/providers/QueryProvider';\n",
      });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['features → app', 'features → providers'],
      );
    });

    it('when app imports a feature internal module instead of its index then reports it', () => {
      const src = fixture({
        ...valid,
        'app/router.tsx': "import { HomePage } from '@/features/home/pages/HomePage';\n",
      });
      assert.deepEqual(
        checkArchitecture(src).map((v) => v.rule),
        ['app → features/<feature>/index.ts only'],
      );
    });
  });

  describe('given files outside the layers that are explicitly allowed', () => {
    it('when the test setup and vite-env.d.ts sit next to the layers then reports no violation', () => {
      assert.deepEqual(checkArchitecture(fixture(valid)), []);
    });

    it('when a feature imports the test setup then reports it, so it cannot become a detour', () => {
      const src = fixture({ ...valid, 'features/home/hooks/useSetup.ts': "import '@/test/setup';\n" });
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
        'lib/bridge.ts': "export { HomePage } from '@/features/home';\n",
        'features/billing/index.ts': "export { HomePage } from '@/lib/bridge';\n",
      });
      assert.deepEqual(
        checkArchitecture(src)
          .map((v) => `${v.file}: ${v.rule}`)
          .sort(),
        ['features/billing/index.ts: unknown top-level layer', 'lib/bridge.ts: unknown top-level layer'],
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

  describe('given sparkle-design imports', () => {
    it('when only shared/components/ui imports sparkle-design then reports no violation', () => {
      const src = fixture({
        ...valid,
        'shared/components/ui/Button/index.tsx': "import { Button as SparkleButton } from 'sparkle-design';\n",
        'shared/components/ui/Input/index.tsx': "import { Input } from 'sparkle-design/input';\n",
      });
      assert.deepEqual(checkArchitecture(src), []);
    });

    it('when a feature page imports sparkle-design directly then reports it', () => {
      const src = fixture({
        ...valid,
        'features/home/pages/HomePage/index.tsx': "import { Button } from 'sparkle-design';\n",
      });
      assert.deepEqual(checkArchitecture(src), [
        {
          file: 'features/home/pages/HomePage/index.tsx',
          specifier: 'sparkle-design',
          rule: 'sparkle-design outside shared/components/ui',
        },
      ]);
    });

    it('when app, providers or other shared code imports a sparkle-design subpath then reports each', () => {
      const src = fixture({
        ...valid,
        'app/router.tsx': "import { HomePage } from '@/features/home';\nimport { Tag } from 'sparkle-design/tag';\n",
        'providers/ToastProvider/index.tsx': "import { Toaster } from 'sparkle-design';\n",
        'shared/components/PageHeading/index.tsx': "const load = () => import('sparkle-design/card');\n",
      });
      assert.deepEqual(
        checkArchitecture(src)
          .map((v) => `${v.file}: ${v.specifier}`)
          .sort(),
        [
          'app/router.tsx: sparkle-design/tag',
          'providers/ToastProvider/index.tsx: sparkle-design',
          'shared/components/PageHeading/index.tsx: sparkle-design/card',
        ],
      );
    });

    it('when a package whose name only starts with sparkle-design is imported then reports no violation', () => {
      const src = fixture({ ...valid, 'features/home/hooks/useTheme.ts': "import { x } from 'sparkle-design-cli';\n" });
      assert.deepEqual(checkArchitecture(src), []);
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
