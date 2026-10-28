# SBIテンプレート

SBIは、PBIをAIが実装できる大きさに分けた作業単位である。人がSBIの内容を決め、Harnessで実行するときは同じ内容をJSONにする。

## 書く項目

| 項目 | 書く内容 |
| --- | --- |
| ID / タイトル | SBIを区別するIDと、実現する振る舞いを1行で |
| 目的 / ユーザー価値 | 何のためのSBIか |
| 対象範囲 / 対象外 | 変更する画面・API・機能と、扱わないもの |
| 受け入れ要件（acceptance criteria） | 何ができれば受け入れるか。項目ごとに一意のIDと検証方法を付ける |
| 変更してよいファイル（allowedFiles） | AIが変更してよいファイルの相対パス |
| リスク（risks） | 認証（AuthN）、認可（AuthZ）、行単位のアクセス制御（RLS）、個人情報（PII）、マイグレーション、ADRへの影響 |
| あいまいさ（ambiguous / requiresDesignDecision） | 仕様があいまいか、先に設計の判断が要るか。真偽値で書く |

受け入れ要件は、次の形のシナリオで書く。

```gherkin
Feature: [機能]
  Scenario: [観測できる振る舞い]
    Given [前提]
    When [操作]
    Then [期待する結果]
```

## セキュリティに関わる項目

| 項目 | 書く内容 |
| --- | --- |
| securityImpact | 影響するセキュリティの分類（RLS、PII、AuthN、AuthZなど）。分類は.harness/rules/security.jsonで定義している |
| requiredSecurityRules | 関係するルールID（SEC-RLS-001など） |
| requiredVerifiers | このSBIのために追加で必須にする検証 |
| preImplementationGate | trueなら、実装を始める前に人の承認を求める |
| minimumRiskLevel | 2または3 |

ここに書いた値で、docs/securityのルールを弱めることはできない。ルールが求める検証を省いても、Harnessは必ず実行する。必須の検証が用意されていなければ、そこで止まる。

JSONの例は.harness/state/sample-sbi.jsonにある。
