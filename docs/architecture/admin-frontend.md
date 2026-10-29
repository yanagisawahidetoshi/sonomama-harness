# 管理画面 Frontend Architecture Contract (apps/admin)

`apps/admin` は講師・講師リーダー・MG・CS・運営が使う React 管理画面。受講生向けのネイティブアプリは `apps/mobile` で扱い、受講生向けの画面をここに置かない。

業務機能ごとの Feature-based Vertical Slice とし、依存方向は **app → features → shared** に固定する。この規約は `pnpm --filter admin run check:architecture` が機械的に検査し、Harness の admin verifier が毎回実行する。

## ディレクトリと責務

`src/` の下に4つの層を置く。

| 層 | 責務 | import してよい先 |
| --- | --- | --- |
| `src/app` | Router の route 定義と、Provider・Router の合成。`src/main.tsx` もこの層に含む | `features`（各 Feature の `index.ts` だけ）、`providers`、`shared` |
| `src/providers` | アプリ全体の Provider（`QueryProvider` など）。認証 Provider は認証方式の決定後に追加する | `shared` |
| `src/features` | 業務機能ごとの UI・API adapter・hooks・schema・型・test | 同じ Feature と `shared` |
| `src/shared` | Feature に依存しない横断的なもの | `shared` |

`src/test`（テストの setup）と `*.d.ts` はどの層にも属さない非layerファイルで、層のコードから import できない。`src/` 直下にこれ以外のディレクトリやファイル（`src/lib` など）を置くと、その import は `unknown top-level layer` として architecture check が FAIL する。未分類の層を経由して features/A → features/B などの禁止依存を迂回させないため。

### 禁止する依存

| 禁止 | 理由 |
| --- | --- |
| features/A → features/B | Feature 間の結合を防ぎ、変更を1つの Feature に閉じる。共通で使うものは `shared` に移す |
| shared → features / app / providers | `shared` を業務から独立させる |
| features → app / providers | Feature を route や Provider の構成から独立させる |
| providers → app / features | Provider をアプリ全体の土台に限定する |
| app → Feature の内部ファイル | route は `@/features/<feature>` で `index.ts` から公開されたものだけを使う |

import は `@/` の path alias（`@/features/*`、`@/shared/*`、`@/providers/*`）でも相対パスでも検査する。

## Route

TanStack Router の route は Navigation と画面の組み立てだけを持ち、Feature の Page を表示する。

```tsx
import { StudentListPage } from '@/features/student-list';

const studentsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/students', component: StudentListPage });
```

route には API request、TanStack Query の query / mutation 定義、form validation、複雑な state、業務ロジックを書かない。route tree の生成物を導入した場合も、生成物に業務ロジックを書かない。

## Feature の構成

```text
src/features/<feature>/
├─ api/          Feature の API adapter（shared HTTP client を使う）
├─ components/   Feature 内だけで使う component
├─ hooks/        Query / mutation / form の hook
├─ schemas/      Zod schema
├─ types/        型（T プレフィックス）
├─ pages/        route から表示する Page
└─ index.ts      Feature の公開 API。route はここからだけ import する
```

必要なディレクトリだけを作る。test は対象と同じディレクトリに置く。

### role ごとに Feature を複製しない

講師・MG・CS など利用者の区分が違っても、同じ業務概念は1つの Feature にする。`features/coach-students` と `features/mg-students` のような role ごとの Feature は作らない（roleごとにFeatureを複製しない）。表示や操作の可否は、認可仕様に基づく UI 制御として Feature の中で扱う。

Frontend の表示制御はBackend認可の代替にしない。認可の正本は API 側に置く。認証・認可の実装は別 Issue で扱う。

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
- ライト・ダークは `styles.ts` とセマンティックな色トークンで対応する。
- Storybook は `ComponentName.stories.tsx` を component の隣に置き、title をディレクトリパスに合わせる（例: `shared/components/ui/Button`）。`pnpm --filter admin storybook` で確認する。

## Design System（Sparkle Design）

管理画面の Design System には Goodpatch の [Sparkle Design](https://sparkle-design.goodpatch.com/)（`sparkle-design`）を使う。スタイルは Tailwind CSS v4 で当てる。

```text
Page / Feature → src/shared/components/ui（SONOMAMA UI wrapper）→ sparkle-design → React
```

- `sparkle-design` を import してよいのは `src/shared/components/ui/**` だけ。Page・Feature・route・providers・それ以外の `shared` は `@/shared/components/ui/<ComponentName>` を使う。subpath（`sparkle-design/input` など）も同じ扱いで、architecture check が `sparkle-design outside shared/components/ui` として FAIL にする。
- wrapper は薄く保つ。Sparkle Design の props をそのまま受け取り、型も `ComponentProps<typeof SparkleButton>` から導く。props を再定義しない。
- default props・SONOMAMA 固有の variant・accessibility の補強・deprecated API の吸収など、SONOMAMA 固有の UI 仕様は wrapper 側で吸収する。
- wrapper は管理画面で実際に使う component だけを、使う時点で追加する。使っていない component を先回りしてまとめて wrap しない。
- 見た目は Sparkle Design の component と Tailwind のクラスで作る。独自の CSS や別の UI library で Sparkle Design と同じ役割の component を作らない。
- テーマは `sparkle.config.json` で設定し、`pnpm --filter admin run sparkle:generate` で `src/app/sparkle-design.css` を生成する。生成物は手で編集しない。

`sparkle-design` は React 19 対応の 2.x を使う。2.x はまだ beta なので、`sparkle-design` と `sparkle-design-cli` はどちらも version を固定する。2.x の正式版が出たら上げる。

## shared に置くもの

`src/shared` には `api/`（shared HTTP client と QueryClient）、`components/`（Sparkle Design の wrapper は `components/ui/`）、`hooks/`、`lib/`、`schemas/`、`theme/`、`types/` を置く。業務固有のコードは該当する Feature に置き、`shared` を雑多な置き場にしない。

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

component と Page から Axios や `fetch` を直接呼ばない。

```text
Page / Component → Feature hook → Feature api → shared HTTP client → API
```

Axios を import してよいのは `src/shared/api` と `src/features/<feature>/api` だけ。認証ヘッダーやエラーの型は shared HTTP client で統一する。将来は `packages/api-schema/openapi.yaml` から生成した client を Feature api から使う。OpenAPI の code generation はまだ行わない。

## 変更するとき

新しい global dependency の追加と、この規約（層・依存方向・Feature 構成）の変更は ADR の対象にする。
