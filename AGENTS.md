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
- AuthN/AuthZ/RLS/PII/Migration/ADR変更はHuman Gate。人間が判断をSBI/ADRに残す。AIはRiskを下げられない。
- .harness/verification/**、tools/harness/**、AGENTS.md、.ai/**、.github/**、.githooks/**はAgentの書込禁止。Agentの許可ファイルにTrusted Acceptance・設定・ルール・証跡を含めない。
- 秘密値をログ・会話・Gitへ出さない。
- 読み取り・通常編集・テスト・型確認・lint・format・通常add/commit/push・PR作成は確認不要。
  merge/rebase/force push/reset --hard/ブランチ・タグ削除等は実行前に確認する（LEVEL 1の自動mergeを除く）。
