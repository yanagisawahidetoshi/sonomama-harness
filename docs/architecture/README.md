# アーキテクチャテンプレート

## 目的
[対象機能と境界]

## 構成
Rails API / Expo / React admin。契約はpackages/api-schemaのOpenAPI。
アプリ内はappがfeaturesを合成し、featuresはsharedだけに依存する。

## データと信頼境界
[認証・権限・個人情報・外部接続]

## Harness v1
State → Agent → Verifier → Reviewer → Completion Judge。
失敗時は証跡を次iterationに渡す。各runは新しい作業領域を持つ。
実装箇所はtools/harness、設定は.harness/config、判断規則は.harness/rules。
Reviewerは決定的なポリシーチェックで、設計・セキュリティの専門レビューは含まない。

## 未決事項 / 関連ADR
[人間が判断する項目とリンク]

## Security Requirementsとの境界

docs/security・docs/product・ADRが、人間の決めるSecurity RequirementsのSSOT。
Harnessは権限表、PII定義、retention期間、匿名化の要件を決定しない。
Security rule IDを文書とsecurity.jsonで共有し、human-gates.jsonは同じIDを参照する。

HarnessはSecurity impact検知、必須Verifier選択、事前Gate、最低Risk、検証、完了・merge禁止、
伏せ字化されたEvidenceの保存を担当する。Semantic Reviewや人間の人数だけで検証失敗を上書きしない。
workspace・prompt・ログ・レビューZIPの秘密情報保護はevidence-protection.mjsを経由する。
NOT_CONFIGUREDはFAIL/SKIPと区別し、必須なら処理を停止する。実際のmergeとPlannerは対象外。
