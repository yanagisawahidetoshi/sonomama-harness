# PBI → SBI Plannerの運用

1. PBIをGitHub Issueに書く。背景・目的・受け入れ要件・やらないことがあれば分割精度が上がる。
2. `gh auth status`で対象リポジトリへissues: writeできることを確認する。
3. `pnpm planner:sbi https://github.com/<owner>/<repo>/issues/<number> --provider claude`を実行する。
   providerはcodex / claude。CLIはインストール・ログイン済みでPATHから起動できることが必要。
4. SBI Quality JudgeがFAILならIssueは作成されず、exit 1で修正理由が表示される。PBIを直して再実行する。
5. PASSなら依存順にSBI Issueを作成し、`sbi`と`needs-review`を付与する。元PBIに`## Generated SBI`一覧をコメントする。
6. 人間がSBI Issueをレビューする。見るのは分割粒度、受け入れ要件、Gherkin、依存関係、Security影響、検証方法。
7. 採用するSBIは`needs-review`を外して`ready`を付ける。`gh issue edit <number> --remove-label needs-review --add-label ready`。
8. `ready`のSBIを人間がSBI JSON（docs/product/sbi-template.md）へ落とし、Execution Harnessで実行する。

## SBI Issueの項目

ID / タイトル、目的、対象範囲（必要なら対象外）、受け入れ要件、Gherkin、依存SBI、想定変更範囲、
Risk / Security Impact、検証方法、元PBI。詳細設計・関数名・実装手順・見積は含めない。

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

Jira等の他トラッカー、Issueからの自動実行、`ready`への自動遷移、Human Reviewの省略、最終Risk確定、自動merge。
