# PII・ログ・データライフサイクル

## 未決の要件

何をPIIとするか、利用目的、閲覧範囲、保存期間、削除・匿名化条件を人間が決める。
検知用パターンは要件の完全な定義ではない。業務仕様と関連ADRを根拠に更新する。

## 実行ルール

- SEC-PII-001: PIIへの影響。pii-log-checkが必要。
- SEC-LOG-001: LoggingへのPII出力。pii-log-checkが必要。
- SEC-LIFECYCLE-001: 削除・匿名化・retention。data-lifecycle-testが必要。

事前Human Gateと最低LEVEL 3を強制する。ログ検査は初期パターンによる検出であり、
権限モデルや実データの匿名化要件そのものを判定・決定するものではない。
