# アーキテクチャテンプレート

## 目的
[対象機能と境界]

## 構成
Rails API / Expo / React adminで構成する。契約はpackages/api-schemaのOpenAPIで定義する。
アプリ内では、appがfeaturesを組み合わせ、featuresはsharedだけに依存する。

## データと信頼境界
[認証・権限・個人情報・外部接続]

## Harness v1
State → Agent → Verifier → Reviewer → Completion Judgeの順に進む。
失敗したときは、証跡を次のiterationに渡す。runごとに新しい作業領域を用意する。
実装はtools/harness、設定は.harness/config、判断規則は.harness/rulesにある。
Reviewerは決定的なポリシーチェックであり、設計やセキュリティの専門レビューは行わない。

## 未決事項 / 関連ADR
[人間が判断する項目とリンク]

## Security Requirementsとの境界

人間が決めるSecurity RequirementsのSSOTは、docs/security・docs/product・ADRである。
Harnessは、権限表、PII定義、retention期間、匿名化の要件を決めない。
Security rule IDは文書とsecurity.jsonで共有し、human-gates.jsonも同じIDを参照する。

Harnessが担当するのは、Security impactの検知、必須Verifierの選択、事前Gate、最低Riskの適用、検証、完了・mergeの禁止、伏せ字にしたEvidenceの保存である。
Semantic Reviewの結果や承認者の人数だけで、検証の失敗を覆さない。
workspace・prompt・ログ・レビューZIPから秘密情報を守る処理は、evidence-protection.mjsを通す。
NOT_CONFIGUREDはFAILやSKIPとは別の状態として扱い、必須のVerifierがNOT_CONFIGUREDなら処理を止める。

実際のmergeは扱わない。
PBI → SBI PlannerはSBI Issueの作成までを担当し、実行・判定・mergeには関わらない。
API Schema PlannerはOpenAPI Proposalの生成とレビュー依頼までを担当し、承認・実装・packages/api-schemaへの反映はしない。
