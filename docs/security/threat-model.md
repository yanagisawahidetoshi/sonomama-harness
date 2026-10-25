# Threat modelの最小テンプレート

## 人間が明確にすること

資産、利用者、信頼境界、外部接続、想定する攻撃、保護手段、残存リスクを記録する。
本番データへの影響と復旧手順を確認し、重要設計はADRを残す。

## 実行ルール

- SEC-MIGRATION-001: Migration。migration-safetyが必要。
- SEC-SCHEMA-001: DB Schema。migration-safetyが必要。
- SEC-CICD-001: CI/CD security setting。forbidden-pattern-checkが必要。
- SEC-INFRA-001: Infrastructure security setting。forbidden-pattern-checkが必要。
- SEC-DESTRUCTIVE-001: 破壊的操作・本番データ。data-lifecycle-testが必要。
- SEC-DESIGN-001: Securityに関する重要設計・ADR。forbidden-pattern-checkが必要。

いずれも事前Human Gateと最低LEVEL 3。
汎用パターン検査だけでは業務上の安全性を証明しない。必要な個別テストをRegistryへ登録する。
