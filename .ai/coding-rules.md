# Coding rules

## テスト

- SBIのBDD/Gherkin・acceptance criteriaからテストを先に作成する。Given → When → Thenを明記し、失敗を確認してから実装する。
- Git管理下では正しい失敗テストを先にコミットする。実装に合わせて期待値を緩めない。
- テストは対象と同じ場所へ配置する。UIではコンポーネントとカスタムフックの両方を検証する。
- SBI.allowedFilesに明記したapps/**、packages/**、prototypes/**のApplication Testは、実装と一緒に変更できる。
- Application TestのPASSだけではACやDONEを満たさない。ACは独立したTrusted Acceptance（.harness/verification）のassertionで検証する。

## 構成と型

- app → features → sharedの依存方向を守る。feature間の直接依存は禁止。
- 外部入力はZodで検証する。TypeScript型名はTプレフィックス、Propsはinterface Props。
- React.FCは禁止。コンポーネントはComponentName/index.tsxに置く。
- 関連フックはコンポーネント配下のhooksへ置き、1フック1責務とする。
- styles.tsとセマンティックな色トークンでライト・ダークに対応する。
- TanStack QueryはstaleTime=5分、gcTime=10分。4xxはretryせず、その他は最大3回。
- sharedのHTTP clientで認証・エラー・型を統一する。
- StorybookはComponentName.stories.tsx、titleはディレクトリパスに合わせる。
- apps/adminではsparkle-designを直接importしない（許可はsrc/shared/components/ui/**だけ）。wrapperはSparkleのpropsをそのまま受け、再定義しない。使うcomponentだけを使う時点でwrapする。見た目はSparkle DesignのcomponentとTailwindのクラスで作り、独自UIを並行して作らない。

## 検証

- pnpm harness:check / pnpm harness:test / pnpm harness:demoで検証する。
