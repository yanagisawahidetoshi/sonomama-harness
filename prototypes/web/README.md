# SONOMAMA Web Prototype (prototypes/web)

デザイナーがReactとStorybookでUIを直接試作・検証する場所（Executable Design Workspace）。
**本番コードではない**。管理画面の本番実装は `apps/admin` にあり、ここからコピーして本番化しない。

React 19 + TypeScript + Vite + Storybook + Biome。UI component libraryはDesign Systemの方針が決まるまで導入しない。

## 前提

- Node 22 (`.node-version`)、pnpm 8 (root `package.json` の `packageManager`)

## コマンド

```sh
pnpm install                                   # repo rootで実行
pnpm --filter prototype-web dev                # Vite dev server (http://localhost:5173)
pnpm --filter prototype-web storybook          # Storybook (http://localhost:6006)
pnpm --filter prototype-web build
pnpm --filter prototype-web build-storybook
pnpm --filter prototype-web typecheck
pnpm --filter prototype-web check              # Biome (lint + format + import整列)
```

自動修正は `pnpm --filter prototype-web exec biome check --write .`。ESLint / Prettierは使わない。

## Storyの追加

1. `src/components/<ComponentName>/index.tsx` にcomponentを作る。Propsは `interface Props`。スタイルは同じ場所の `styles.ts` に書く。
2. 色・余白・文字サイズは `src/tokens.css` のsemantic token（`var(--color-text)` など）を使う。ダークモードはtoken側で切り替わる。
3. 同じ場所に `<ComponentName>.stories.tsx` を置く。`title` はディレクトリパス（例: `components/LessonCard`）に合わせる。
4. variant、loading / empty / errorの状態、長い文字列、画面幅（toolbarのviewport）をそれぞれStoryにする。簡単な操作は `play` で書く。

サンプルは `src/components/LessonCard`。

## mock data

- 表示に使うデータは `src/mocks/` のlocal mock dataだけにする。実ユーザーのデータは使わない。
- Production / Staging APIへ接続しない。API clientやfetchを入れない。OpenAPI由来のmockが必要なら `pnpm api:mock <Issue URL>` のPrism Mock Serverを使う（任意）。
- secret / token / `.env` をここに置かない。Harnessのsecret scanで検出される。

## 本番への昇格 (Promotion Flow)

```text
Figma / Design Intent
  → prototypes/web で試作
  → Storybook Review
  → Design Approval
  → Production SBI（promotion.source = prototypes/web）
  → apps/admin で実装
  → Production Harness
```

prototypeのPASSは本番実装の承認にならない。Design Approvalのあと、新しいProduction SBIで `apps/admin` に実装し直し、本番の検証を通す。

## Harness

prototype laneの `prototype-web` verifierが install / typecheck / Biome check / Vite build / Storybook build を実行する。secret scanは全runで必須。
受け入れ条件は `.harness/verification/prototype-web-env.mjs` で検証する。
