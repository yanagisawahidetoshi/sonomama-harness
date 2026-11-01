# SONOMAMA Harness AI入口

常に日本語で会話する。詳細なルールは.ai/と.harness/にある。

## 読む順番

1. .ai/context/project.md
2. .ai/architecture.md
3. .ai/coding-rules.md
4. .ai/security-rules.md
5. 作業に応じて.ai/workflows/（implementation・pbi-sbi-planner・api-schema・pull-request）
6. 実行・検証・強制のルールは.harness/（config・rules・verification・skills）を参照する

docs/は人間向け。ADRや人間の設計判断を確認するときだけ参照する。

## 最上位の禁止事項

- 自動mergeはLEVEL 1だけ許可する。必須チェックがすべてPASSし、autoMergeEligibleがtrueのときに限る。LEVEL 2・3の最終mergeは人間が行う。
- AI自己申告は採用せずVerifier・Reviewer・Completion Judgeが完了判定する。
- 3回連続失敗、仕様曖昧、重要設計判断で停止する。
- AuthN/AuthZ/RLS/PII変更はHuman Gate。人間はSBI承認でその判断をSBI/ADRに残し、実装前に別のGateは置かない。LEVEL 3と実装後の異なる2人以上のReviewは必ず残す。AIはRiskを下げられない。
  承認済みSBIが認証不要と明記した新規endpointの追加は、既存・共通の認証を変えない限りAuthN変更とみなさない。既存endpointの認証解除、共通設定の変更、承認された公開範囲の拡大はAuthN変更のまま（ADR-0010）。
- 既定はLEVEL 1（人間承認なし）。Migration・schema・OpenAPI・CI・Dockerfile・ADR・Harness実装はLEVEL 2（人間1人）。重大リスクとポリシー自身（.harness/rules/・.harness/state/・.github/rulesets/・.githooks/）だけLEVEL 3（異なる2人）。
- 承認済みSBIで決められない判断（範囲外の変更、新しいSecurity・Architecture判断、ADR変更、Design・API契約との矛盾）が出たら、ESCALATED / NEEDS_HUMAN_DECISIONで止まる。人間がSBIを更新・再承認し、新しいrunで再開する。
- AI Review（Semantic Review）は全Risk Levelで必須。人間の承認人数には数えない。
- .harness/verification/**、tools/harness/**、AGENTS.md、.ai/**、.github/**、.githooks/**はAgentの書込禁止。Agentの許可ファイルにTrusted Acceptance・設定・ルール・証跡を含めない。
- 秘密値をログ・会話・Gitへ出さない。
- 読み取り・通常編集・テスト・型確認・lint・format・通常add/commit/push・PR作成は確認不要。
  merge/rebase/force push/reset --hard/ブランチ・タグ削除等は実行前に確認する（LEVEL 1の自動mergeを除く）。
