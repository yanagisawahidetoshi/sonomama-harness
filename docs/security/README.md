# Security Requirements / Policy

このディレクトリが人間向けSecurity RequirementsのSSOT。
今回は方針全文や業務上の権限を確定せず、決定すべき項目と実行ルールとの対応を示す。
誰が何を閲覧できるか、PIIの定義、保存期間、匿名化条件はproduct担当者と人間の設計判断で決める。

## 実行ルールとの対応

- SEC-CONFIG-001: Security Policy・設定変更は事前Human Gate、最低LEVEL 3。
- 認証・認可・RLSはauthorization.md。
- PII・ログ・データライフサイクルはpii.md。
- Secret / Credentialはsecrets.md。
- Migration・schema・CI/CD・Infrastructure・破壊的操作・重要設計はthreat-model.md。

.harness/rules/security.jsonは上記要件を検知・検証・停止へつなぐ機械可読ルール。
human-gates.jsonは事前承認が必要なSecurity rule IDを参照する。
checkはIDと文書参照の整合性を検証する。意味上の妥当性は人間がレビューする。
PolicyはHarness内だけに閉じ込めない。未決事項をAIが推測して確定しない。
