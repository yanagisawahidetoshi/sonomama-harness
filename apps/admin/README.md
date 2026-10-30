# SONOMAMA 管理画面 (apps/admin)

運営・CS・MG・講師向け管理画面。React 19 + TypeScript + Vite。業務画面は後続SBIで追加する。

| 用途          | ライブラリ                                                                       |
| ------------- | -------------------------------------------------------------------------------- |
| Routing       | TanStack Router                                                                  |
| Server state  | TanStack Query (staleTime 5分 / gcTime 10分 / 4xxはretryなし・その他は最大3回)   |
| HTTP          | Axios (`src/shared/api`)                                                         |
| Form          | React Hook Form + Zod (`@hookform/resolvers`)                                    |
| UI            | Sparkle Design (`sparkle-design`) + Tailwind CSS v4 (`src/shared/components/ui`) |
| Lint / Format | Biome (ESLint / Prettierは使わない)                                              |
| Test          | Vitest + React Testing Library + jsdom                                           |

UIは `@/shared/components/ui/<ComponentName>` の wrapper 経由で使い、`sparkle-design` を直接importしない。規約は [Architecture Contract](../../docs/architecture/admin-frontend.md#design-systemsparkle-design)。

## 前提

- Node 22 (`.node-version`)
- pnpm 8 (root `package.json` の `packageManager`)

## セットアップ

```sh
pnpm install
cp apps/admin/.env.example apps/admin/.env.local
```

## コマンド

```sh
pnpm --filter admin dev           # http://localhost:5173
pnpm --filter admin build
pnpm --filter admin typecheck
pnpm --filter admin lint          # biome lint
pnpm --filter admin format:check  # biome format
pnpm --filter admin check         # biome check (lint + format + import整列)
pnpm --filter admin test
pnpm --filter admin storybook        # http://localhost:6007
pnpm --filter admin build-storybook
pnpm --filter admin run sparkle:generate  # sparkle.config.json → src/app/sparkle-design.css
```

`sparkle:generate` は `index.html` のフォント読込ブロックも更新する。変わったら `.storybook/preview-head.html` に同じ内容を写す。

自動修正は `pnpm --filter admin exec biome check --write .`。

## API接続

接続先は `VITE_API_BASE_URL` で切り替える。値は起動時ではなく、`src/shared/api` を初めてimportしたときにZodで検証する。

```text
VITE_API_BASE_URL=http://127.0.0.1:4010
```

ローカルではPrism Mock Serverを使える。別ターミナルで起動し、上記の値のまま `dev` を実行する。

```sh
pnpm api:mock <Issue URL>
```

## 認証

認証ProviderはAmazon Cognito（User Pool）を使う。
Provider固有SDK・login画面・token管理・route guardは導入していない。導入時は `src/shared/api/http-client.ts` のAxios interceptorで認証ヘッダーを付与し、HTTP層からProvider固有実装を分離する。

## Harness

`.harness/config/harness.json` の `admin` verifierが `typecheck` / `check` / `test` / `build` を実行する。
受け入れ条件は `.harness/verification/admin-env.mjs` で検証する。
