# SONOMAMA Harness開発・運用ルール

- 常に日本語で会話する。
- 今回はPhase 0/1のローカルHarness。Rails API / Expo / React adminはplaceholder。
- このリポジトリはHarness専用。別プロジェクトの動画PoCや参照ファイルを追加しない。
- SBIのBDD/Gherkin・acceptance criteriaからテストを先に作成する。
  Given → When → Thenを明記し、失敗確認後に実装を進める。
  Git管理下では正しい失敗テストを先にコミットする。実装に合わせて期待値を緩めない。
- テストは対象と同じ場所へ配置する。将来のUIではコンポーネントとカスタムフックの両方を検証する。
- app → features → sharedの依存方向を守り、feature間の直接依存は禁止。
- 外部入力はZodで検証。TypeScript型名はTプレフィックス、Propsはinterface Props。
  React.FCは禁止。コンポーネントはComponentName/index.tsxに置く。
- 関連フックはコンポーネント配下のhooksへ置き、1フック1責務とする。
  styles.tsとセマンティックな色トークンでライト・ダークに対応する。
- TanStack QueryはstaleTime=5分、gcTime=10分。4xxはretryせず、その他は最大3回。
  sharedのHTTP clientで認証・エラー・型を統一する。
- StorybookはComponentName.stories.tsx、titleはディレクトリパスに合わせる。
- pnpm harness:check / pnpm harness:test / pnpm harness:demoで検証する。
- AI自己申告は採用せずVerifier・Reviewer・Completion Judgeが完了判定する。
- 3回連続失敗、仕様曖昧、重要設計判断で停止する。
- AuthN/AuthZ/RLS/PII/Migration/ADR変更はHuman Gate。人間が判断をSBI/ADRに残す。
- agentの許可ファイルにテスト・設定・ルール・証跡を含めない。
- 自動mergeは禁止。最終mergeは人間が行う。
- 読み取り・通常編集・テスト・型確認・lint・format・通常add/commit/push・PR作成は確認不要。
  merge/rebase/force push/reset --hard/ブランチ・タグ削除等は実行前に確認する。

## Risk / Human Approval拡張

- Default Risk Levelは2。明示的なsafe ruleのみLEVEL 1への降格を許可する。
- LEVEL 3の最低ルール、Human Gateは常に優先する。AIはRiskを下げられない。
- 変更内容、検証対象、レビュー対象、SHAは同じrun workspaceに固定する。
- 実装前gateと実装後merge approvalは別state・別purpose・別contextで管理する。
- 承認は信頼するidentity adapter経由だけ。agentのJSONや証跡ファイルを承認の正本にしない。
- LEVEL 2は1人、LEVEL 3は異なる2人以上。重複、AI、旧SHA、撤回済みの承認は無効。
- 必須チェックはすべてPASS。対象外と明示したmissing appだけSKIP可能。
- 出力はMERGE_ALLOWEDとautoMergeEligibleまで。実mergeとMERGED遷移は実装しない。
- 承認待ちのresumeと実装の再試行は分離し、Plannerより実行・判定の整合性を優先する。

## Security Enforcement

- Security RequirementsのSSOTはdocs/security・product・ADR。Harness内で業務権限を決めない。
- Security rule IDを文書・security.json・human-gates.jsonで対応させる。
- Security-sensitiveは事前Gate、最低LEVEL 3、必須Verifierを強制する。
- required Security VerifierのFAIL/SKIP/NOT_CONFIGURED、rule violation、未承認GateではDONEもMERGE_ALLOWEDも禁止。
- 新しいSecurity影響と秘密値の提案は、workspaceへ適用する前に止める。
- 秘密ファイルはworktree・export・Gitから除外する。trackedで検出した場合はcheckout前に停止する。実値をログや会話へ出さない。
- ログ・prompt・JSON・例外はredactionを通す。レビューZIPはharness:exportで再検査して生成する。
- 外部CLIの生レスポンスをrun配下へ直接書かせない。

## Application TestとTrusted Acceptance Test

- SBI.allowedFilesに明記したapps/**、packages/**、prototypes/**のApplication Testは実装と一緒に変更できる。TDDを守る。
- .harness/verification/**、tools/harness/**、AGENTS.md、.github/**、.githooks/**はAgentの書込禁止。
- Application TestのPASSだけではACやDONEを満たさない。ACは独立したTrusted Acceptanceのassertionで検証する。
- VerifierのappliesToとlaneで変更範囲を選ぶ。AC・Security・明示必須指定はlane/pathより優先し、必須検証をSKIPしない。
- prototypes/web、prototypes/mobileは軽量ゲート。apps/**とpackages/**は常にProduction。認証・PII・本番API等への影響はSecurity Gateへ昇格する。
- 試作の本番移行は新しいProduction SBIと実装前Design Approvalを必要とし、本番検証を省略しない。
- runは元のHEADからdetached Git worktreeで実行する。元リポジトリはcleanで開始し、証跡と承認台帳をrunのGit履歴に入れない。
- cleanupはcleanなworktreeだけを削除し、証跡とrefs/harness/runs/<run-id>を保持する。force/remove/resetは使わない。
