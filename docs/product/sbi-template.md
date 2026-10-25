# SBIテンプレート

- ID / タイトル:
- 目的 / ユーザー価値:
- 対象範囲 / 対象外:
- acceptance criteria: 一意のIDと検証方法
- allowedFiles: runのworkspace内で許可する相対パス
- risks: AuthN / AuthZ / RLS / PII / Migration / ADR
- ambiguous / requiresDesignDecision: 真偽値

```gherkin
Feature: [機能]
  Scenario: [観測できる振る舞い]
    Given [前提]
    When [操作]
    Then [期待する結果]
```

実行用JSONは.harness/state/sample-sbi.jsonを参照。
v1の実行可能なacceptance verifierはsample-bddのみ。
別のSBIを実行する前に、信頼する検証adapterとACの対応を追加する。

## Security metadata

- securityImpact: RLS / PII / AuthN / AuthZ等、security.jsonで定義した分類
- requiredSecurityRules: SEC-RLS-001等、要件文書に紐付くID
- requiredVerifiers: SBI固有に追加する必須Security Verifier ID
- preImplementationGate: trueなら実装前承認を要求する
- minimumRiskLevel: 2または3。強制ルールより低く設定しても降格できない

matched ruleが要求する検証はSBI側で省略しても強制される。
必須検証が未設定ならNOT_CONFIGUREDで停止し、AIの自己申告で成功扱いしない。
