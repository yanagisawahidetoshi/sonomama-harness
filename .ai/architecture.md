# Architecture（AI向け）

人間向けの説明はdocs/architecture/README.md。ここには実装時に守る構成と、Harnessの実行モデルを置く。

## アプリ構成

- apps/api: Rails API。apps/mobile: Expo（受講生アプリ）。apps/admin: React（管理画面）。
- prototypes/web・prototypes/mobile: デザイナー用の試作。本番コードではなく、ここからコピーして本番化しない。
- API契約のSSOTはpackages/api-schemaのOpenAPI。Rails・Expo・adminは同じスキーマを参照する。
- アプリ内の依存方向はapp → features → shared。feature間の直接依存は禁止。apps/admin・apps/mobileのsrc直下はapp / features / shared / providersとentrypoint・test setup・d.tsだけ。未分類のtop-level（src/lib等）はarchitecture checkでFAILする。
- Auth providerは未決定。明示的な承認なしにCognito / Firebase / Google等のProvider固有SDKを追加しない。

## Harness v1

State → Agent → Verifier → Reviewer → Completion Judge。
失敗時は証跡を次iterationに渡す。各runは新しい作業領域を持つ。
実装はtools/harness、設定は.harness/config、判断規則は.harness/rules。
Reviewerは決定的なポリシーチェックで、設計・セキュリティの専門レビューは含まない。
実際のmergeは対象外。PBI → SBI PlannerはSBI Issueの作成まで、API Schema PlannerはOpenAPI Proposalの生成とレビュー依頼までで、承認・実装・merge・packages/api-schemaへの反映はしない。

## Review adapterの接続点

現在は独立したローカルGit workspaceと人間用CLIを使用する。
将来のGitHub接続でも、Risk ClassifierとMerge Policy Judgeの純粋関数をそのまま使う。

### 実装済みの接続点

- workspace.git / changedFiles: 現在HEADとbaselineからの差分。rename前のパスも判定対象にする。
- verifierRegistry: verifier IDと、信頼するコマンド・AC IDの登録。
- recordDecisionのidentityProvider: 信頼する認証経路からid / kind=human / sourceを返す。
- authenticatedRecords: purpose、SHA、context、取り消しを含む署名済み承認履歴。
- assessRisk: 差分、SBI/AC、Human Gate、AIの上方リスク提案を入力にRulesを評価する。
- mergeDecision: 必須チェック、Risk、認証済み承認を入力に可否だけを返す。
- runHarness/resumeRunのsemanticReviewer: 有効時の意味レビュー。PASS/FAILと任意のriskLevelを返す。

### GitHub adapterで保証すること

現在HEAD・ベース差分・必須check結果を取得し、最新HEADに対する有効な人間のレビューを正規化する。
botやAI、重複人物、取り消し済み・古いSHAのレビューを人数へ含めない。
permissionやreviewer適格性は認証済みサービスの情報で検証する。
Gate承認をPRレビューと混同しない。risk/level-1〜3のラベルは分類結果の投影であり承認の根拠ではない。

Risk/approvalの取得から可否表示までにHEADが変わったら再評価する。
現段階ではMERGEDを書き込まず、merge APIは実装しない。
