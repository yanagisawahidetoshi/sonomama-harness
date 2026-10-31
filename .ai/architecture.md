# Architecture（AI向け）

人間向けの説明はdocs/architecture/README.md。ここには実装時に守る構成と、Harnessの実行モデルを置く。

## アプリ構成

- apps/api: Rails API。apps/mobile: Expo（受講生アプリ）。apps/admin: React（管理画面）。
- prototypes/web・prototypes/mobile: デザイナー用の試作。本番コードではなく、ここからコピーして本番化しない。
- API契約のSSOTはpackages/api-schemaのOpenAPI。Rails・Expo・adminは同じスキーマを参照する。
- アプリ内の依存方向はapp → features → shared。feature間の直接依存は禁止。apps/admin・apps/mobileのsrc直下はapp / features / shared / providersとentrypoint・test setup・d.tsだけ。未分類のtop-level（src/lib等）はarchitecture checkでFAILする。
- apps/adminのUIはSparkle Design（sparkle-design）+ Tailwind CSS v4。sparkle-designのimportはsrc/shared/components/ui/**だけに置き、Page・Feature・routeは@/shared/components/ui/<ComponentName>の薄いwrapperを使う。architecture checkで検査する。
- Auth providerは未決定。明示的な承認なしにCognito / Firebase / Google等のProvider固有SDKを追加しない。

## Harness v1

State → Agent → Verifier → Reviewer → Completion Judge。
失敗時は証跡を次iterationに渡す。各runは新しい作業領域を持つ。
実装はtools/harness、設定は.harness/config、判断規則は.harness/rules。
Reviewerは決定的なポリシーチェックで、設計・セキュリティの専門レビューは含まない。
実際のmergeは対象外。PBI → SBI PlannerはSBI Issueの作成まで。実行は`harness:run <SBI Issue URL>`で、OpenAPIの変更も通常のSBI（Schema SBI）として扱う。API Schema Plannerは内部機能で、OpenAPI Proposalの生成とレビュー依頼までしか行わない。
GitHub PR Adapter（`harness:run`がDONE後に呼ぶ。`harness:pr`は復旧用）は検証済みSHAのPR作成と、GitHub Review・必須CIによるMERGE_ALLOWED判定まで。CIのjob構成は[workflows/ci.md](workflows/ci.md)。

## Review adapterの接続点

Local modeは独立したローカルGit workspaceと人間用CLIの署名台帳、GitHub PR modeはGitHub Reviewを実装後Merge Approvalの正本にする（[ADR-0001](../docs/adr/0001-github-review-merge-approval.md)）。
どちらのモードもRisk ClassifierとMerge Policy Judgeの純粋関数を共有する。

### 実装済みの接続点

- workspace.git / changedFiles: 現在HEADとbaselineからの差分。rename前のパスも判定対象にする。
- verifierRegistry: verifier IDと、信頼するコマンド・AC IDの登録。
- recordDecisionのidentityProvider: 信頼する認証経路からid / kind=human / sourceを返す。
- authenticatedRecords: purpose、SHA、context、取り消しを含む署名済み承認履歴。
- assessRisk: 差分、SBI/AC、Human Gate risk、AIの上方リスク提案を入力にRulesを評価する。
- mergeDecision: 必須チェック、Risk、認証済み承認を入力に可否だけを返す。
- runHarness/resumeRunのsemanticReviewer: AI Review（全LEVELで必須）のadapter接続点（本物は#187）。PASS/FAILと任意のriskLevelを返す。未接続はNOT_CONFIGURED、fake providerだけfake adapter（ai-review.mjs）。

### GitHub PR Adapterが保証すること

実装はtools/harness/github-pr.mjs。判定条件と運用手順は[workflows/pull-request.md](workflows/pull-request.md)にあり、ここには守る制約だけを置く。
現在HEAD・ベース差分・必須check結果を取得し、最新HEADに対する有効な人間のレビューを正規化する。
botやAI、重複人物、取り消し済み・古いSHAのレビューを人数へ含めない。
permissionやreviewer適格性は認証済みサービスの情報で検証する。
Gate承認をPRレビューと混同しない。risk/level-1〜3のラベルは分類結果の投影であり承認の根拠ではない。

Risk/approvalの取得から可否表示までにHEADが変わったら再評価する。
MERGEDを書き込まず、merge APIは実装しない。Branch Protection / Rulesetも変更しない。
