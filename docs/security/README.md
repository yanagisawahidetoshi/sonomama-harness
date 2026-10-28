# Security Requirements / Policy

このディレクトリが、人間向けのSecurity RequirementsのSSOTである。
今回は方針の全文や業務上の権限を確定させず、決めるべき項目と実行ルールの対応を示す。
誰が何を閲覧できるか、PIIの定義、保存期間、匿名化の条件は、product担当者と人間の設計判断で決める。

## 実行ルールとの対応

- SEC-CONFIG-001: Security Policy・設定の変更は事前Human Gate、最低LEVEL 3。
- 認証・認可・RLSはauthorization.md。
- PII・ログ・データライフサイクルはpii.md。
- Secret / Credentialはsecrets.md。
- Migration・schema・CI/CD・Infrastructure・破壊的操作・重要設計はthreat-model.md。

.harness/rules/security.jsonは、上の要件を検知・検証・停止につなげる機械可読のルールである。
human-gates.jsonは、事前承認が必要なSecurity rule IDを参照する。
checkはIDと文書参照の整合性を検証する。意味の上で妥当かどうかは人間がレビューする。
PolicyをHarnessの中だけに閉じ込めない。未決事項をAIが推測して確定させない。
