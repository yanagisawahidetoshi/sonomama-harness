# 受講生アプリ Frontend Architecture Contract (apps/mobile)

`apps/mobile` は受講生専用のネイティブアプリ。講師・coach・MG・CS・運営向けの画面は `apps/admin` で扱い、それらの Route や Feature をここに置かない。

業務機能ごとの Feature-based Vertical Slice とし、依存方向は **app → features → shared** に固定する。この規約は `pnpm --filter mobile run check:architecture` が機械的に検査し、Harness の expo verifier が毎回実行する。

## ディレクトリと責務

`src/` の下に4つの層を置く。

| 層 | 責務 | import してよい先 |
| --- | --- | --- |
| `src/app` | Expo Router の route（`_layout.tsx` と画面の route）。Provider の合成は `_layout.tsx` で行う | `features`（各 Feature の `index.ts` だけ）、`providers`、`shared` |
| `src/providers` | アプリ全体の Provider（`QueryProvider` など）。認証 Provider は認証方式の決定後に追加する | `shared` |
| `src/features` | 業務機能ごとの UI・API adapter・hooks・schema・型・test | 同じ Feature と `shared` |
| `src/shared` | Feature に依存しない横断的なもの | `shared` |

Expo Router は `src/app` の下のファイルをすべて route として扱う。route 以外のファイル（Provider、component、hook）を `src/app` に置かない。

### 禁止する依存

| 禁止 | 理由 |
| --- | --- |
| features/A → features/B | Feature 間の結合を防ぎ、変更を1つの Feature に閉じる。共通で使うものは `shared` に移す |
| shared → features / app / providers | `shared` を業務から独立させる |
| features → app / providers | Feature を route や Provider の構成から独立させる |
| providers → app / features | Provider をアプリ全体の土台に限定する |
| app → Feature の内部ファイル | route は `@/features/<feature>` で `index.ts` から公開されたものだけを使う |

import は `@/` の path alias（`@/features/*`、`@/shared/*`、`@/providers/*`）でも相対パスでも検査する。alias は `tsconfig.json` の `paths` で定義し、Metro は Expo の tsconfig paths 対応で、Jest は `moduleNameMapper` で解決する。

## Route

route は Feature の Screen を表示するだけにする。

```tsx
import { HomeScreen } from '@/features/home';

export default function Index() {
  return <HomeScreen />;
}
```

route には API request、TanStack Query の query / mutation 定義、form validation、複雑な state、業務ロジックを書かない。認証が必要な route group（`(auth)` / `(app)`）は認証方式の決定後に追加する。

## Feature の構成

```text
src/features/<feature>/
├─ api/          Feature の API adapter（shared HTTP client を使う）
├─ components/   Feature 内だけで使う component
├─ hooks/        Query / mutation / form の hook
├─ schemas/      Zod schema
├─ types/        型（T プレフィックス）
├─ screens/      route から表示する Screen
└─ index.ts      Feature の公開 API。route はここからだけ import する
```

必要なディレクトリだけを作る。test は対象と同じディレクトリに置く。

## Component と hooks

[.ai/coding-rules.md](../../.ai/coding-rules.md) の規約をそのまま適用する。

```text
components/ComponentName/
├─ index.tsx
├─ hooks/
├─ styles.ts
├─ ComponentName.test.tsx
└─ ComponentName.stories.tsx
```

- component は `ComponentName/index.tsx` に置き、Props は `interface Props` で書く。`React.FC` は使わない。
- TypeScript の型名は Tプレフィックスを付ける。
- 関連する hook は component 配下の `hooks/` に置き、1つの hook に1つの責務を持たせる。
- ライト・ダークは `styles.ts` と `src/shared/theme` のセマンティックな色トークンで対応する。
- Storybook は apps/mobile には未導入。導入後は `ComponentName.stories.tsx` を component の隣に置き、title をディレクトリパスに合わせる。
- Maestro が参照する `testID`（`home-title` など）は Screen を移動しても変えない。

## shared に置くもの

`src/shared` には `api/`（shared HTTP client と QueryClient）、`components/`、`hooks/`、`lib/`、`schemas/`、`theme/`、`types/` を置く。業務固有のコードは該当する Feature に置き、`shared` を雑多な置き場にしない。

Feature のコードを `shared/components` などへ移すのは、複数Featureから実際に使われるようになってからにする。最初から共通化しない。

## State

| 種類 | 使うもの |
| --- | --- |
| Server state | TanStack Query（staleTime 5分、gcTime 10分。4xx は retry せず、その他は最大3回） |
| Form state | React Hook Form |
| Validation | Zod（外部入力はすべて検証する） |
| Local UI state | `useState` / `useReducer` |

Redux・Zustand などの global state library は導入しない。必要になったら ADR で判断する。

## API の境界

component と Screen から Axios や `fetch` を直接呼ばない。

```text
Screen / Component → Feature hook → Feature api → shared HTTP client → API
```

Axios を import してよいのは `src/shared/api` と `src/features/<feature>/api` だけ。認証ヘッダーやエラーの型は shared HTTP client で統一する。将来は `packages/api-schema/openapi.yaml` から生成した client を Feature api から使う。OpenAPI の code generation はまだ行わない。

## 変更するとき

新しい global dependency の追加と、この規約（層・依存方向・Feature 構成）の変更は ADR の対象にする。
