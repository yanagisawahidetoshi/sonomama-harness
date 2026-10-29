# PBI → SBI Plannerの運用

1. PBIをGitHub Issueに書く。背景・目的・受け入れ要件・やらないことがあれば分割精度が上がる。
2. `gh auth status`で対象リポジトリへissues: writeできることを確認する。
3. `pnpm planner:sbi https://github.com/<owner>/<repo>/issues/<number>`を実行する。
   providerの既定はclaude。Codexだけ使える場合は`--provider codex`を付ける。CLIはインストール・ログイン済みでPATHから起動できることが必要。
4. SBI Quality JudgeがFAILならIssueは作成されず、exit 1で修正理由が表示される。PBIを直して再実行する。
5. PASSなら依存順にSBI Issueを作成し、`sbi`と`needs-review`を付与する。元PBIに`## Generated SBI`一覧をコメントする。
6. 人間がSBI Issueをレビューする。見るのは分割粒度、受け入れ要件、Gherkin、依存関係、Security影響、検証方法。
7. 採用するSBIは、ACごとのTrusted Acceptanceを人間が書いてレビューし、
   `.harness/acceptance/sbi-<SBI番号>.json`に`{ "version": 1, "sbiIssue": <SBI番号>, "verifiers": [{ "id", "trustedScript", "planned", "acceptanceIds": [IssueのAC ID] }] }`で登録する。
8. 全ACの対応を確認したら`needs-review`を外して`ready`を付ける。`gh issue edit <number> --remove-label needs-review --add-label ready`。
9. `pnpm harness:run <SBI Issue URL>`で実行する。SBI JSONは書かない。HarnessがIssueを取得・検証し、Run snapshotを保存して実装・検証・PR作成まで進める。

## SBIの種類

| kind | 開始条件 | 完了条件 |
| --- | --- | --- |
| implementation（実装SBI） | dependsOnのSBIが完了 | PRがmainへmerge済み、必須VerifierがPASS、E2E対象ならモックAPIのMaestro E2EがPASS |
| validation（最終確認SBI、Integration / E2Eが必要なPBIだけ1件まで） | 同じPBIの実装SBIがすべて完了 | 実API / Rails / DBへ接続したMaestro E2EがPASS |

人間確認はコード変更も実テストも持たないので、SBIにしない。PBI Human Acceptance Gateとして扱い、
すべての実装SBIが完了し、最終確認SBIがあればPASSした後に、そのEvidence digestに対する人間の`pbi-acceptance`承認で通る。
PBIは、すべてのSBIが完了し、PBI Human Acceptance Gateが承認され、PBIをブロックする未解決バグがないときだけ完了する。判定は`pbi-judge.mjs`の`judgePbi`で行う。
`pbi-acceptance`はImplementation Gate・Design Approval・Merge Approval・API Schema Approvalとは別の承認で、どれの代わりにもならない。
`pbi-acceptance`を署名付き台帳へ記録するCLI、Maestroのモック / 実API切り替え、E2E Evidenceの保存は未実装。

## SBI Issueの項目

種類、ID / タイトル、目的、対象範囲（必要なら対象外）、受け入れ要件、Gherkin、依存SBI、想定変更範囲、
レイヤー、想定変更ファイル数（目安超過なら理由）、Risk / Security Impact、検証方法、Gherkinと実テストの対応、元PBI。
詳細設計・関数名・実装手順・見積は含めない。

## SBIの粒度

SBI Quality Judgeは次を検査し、満たさなければIssueを作成しない。

| kind | レイヤー | 想定変更ファイル数 | 実テスト |
| --- | --- | --- | --- |
| implementation | 1つだけ。想定変更範囲が複数の`apps/*`にまたがればFAIL | 1以上。10を超えるなら分割できない理由が必須 | Application TestとScenarioごとのtestが必須。lint / typecheckだけや「不要」はFAIL |
| validation | 制約なし（PBI全体を通す） | 制約なし | E2EとScenarioごとのtestが必須 |

2時間の目安はPlannerの判断基準で、Judgeは機械判定しない。
実装後PRの変更ファイル数は、CIのCompletion Judgeが`judgeChangedFileCount`でIssueの想定と比べ、10と想定の両方を超えたらFAILにする（[ci.md](ci.md)）。

## 失敗時

- 不正なURL、取得失敗、Pull RequestのURL: exit 1。GitHubへは書き込まない。
- providerのescalation（PBIが曖昧など）: exit 1。確認事項を表示する。
- providerの出力に秘密値らしき文字列: exit 1。GitHubへは書き込まない。
- Issue作成の途中失敗: 作成済みのIssue一覧を表示してexit 1。元PBIへのコメントは投稿しない。
  再実行すると本文のmarker（PBI URL + SBI ID + 内容digest）で既存Issueを探し、open・`needs-review`付き・title/本文が今回の生成結果と
  完全一致するものだけを再利用して、未作成分だけを作る。
- 既存SBI Issueが再利用条件を満たさない（digest不一致、人間が本文やtitleを編集、`ready`化、closed）: 該当Issue番号と理由を表示してexit 1。
  GitHubへは書き込まない。人間が差分を確認し、古いIssueを閉じて`sbi`ラベルを外すか、内容を確定してから再実行する。既存Issueの本文は自動更新しない。

## GitHub Actionsで実行する場合

`GITHUB_STEP_SUMMARY`があれば同じ一覧をJob Summaryへ追記する。
workflowはこのリポジトリに含めていない。追加する場合は`issues: write`とprovider CLIの認証情報が必要で、
CI/CDとSecretの変更はLEVEL 3 / Security Gateの対象になる。

## やらないこと

Jira等の他トラッカー、`ready`への自動遷移、Human Reviewの省略、最終Risk確定、自動merge。
