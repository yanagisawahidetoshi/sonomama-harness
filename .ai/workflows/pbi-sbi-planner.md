# PBI → SBI Plannerの運用

1. PBIをGitHub Issueに書く。背景・目的・受け入れ要件・やらないことがあれば分割精度が上がる。
2. `gh auth status`で対象リポジトリへissues: writeできることを確認する。
3. `pnpm planner:sbi https://github.com/<owner>/<repo>/issues/<number>`を実行する。
   providerの既定はclaude。Codexだけ使える場合は`--provider codex`を付ける。CLIはインストール・ログイン済みでPATHから起動できることが必要。
4. SBI Quality JudgeがFAILならIssueは作成されず、exit 1で修正理由が表示される。PBIを直して再実行する。
5. PASSなら依存順にSBI Issueを作成し、`sbi`と`needs-review`を付与する。元PBIの本文に`## SBI構成`（SBI ID・Issue番号・kind・依存の完全な集合）を書き、`## Generated SBI`一覧をコメントする。
6. 人間がSBI Issueをレビューする。見るのは分割粒度、受け入れ要件、Gherkin、依存関係、Security影響、検証方法。
7. 採用するSBIは、ACごとのTrusted Acceptanceを人間が書いてレビューし、
   `.harness/acceptance/sbi-<SBI番号>.json`に`{ "version": 1, "sbiIssue": <SBI番号>, "verifiers": [{ "id", "trustedScript", "planned", "acceptanceIds": [IssueのAC ID] }] }`で登録する。
8. 全ACの対応を確認したら`needs-review`を外して`ready`を付ける。`gh issue edit <number> --remove-label needs-review --add-label ready`。
9. PBIの`## SBI構成`を確認し、`pnpm harness:pbi-plan-approve <PBI URL>`で一度だけ承認する（下記「PBI plan」）。
9. `pnpm harness:run <SBI Issue URL>`で実行する。SBI JSONは書かない。HarnessがIssueを取得・検証し、Run snapshotを保存して実装・検証・PR作成まで進める。

## SBIの種類

| kind | 開始条件 | 完了条件 |
| --- | --- | --- |
| implementation（実装SBI） | dependsOnのSBIが完了 | PRがmainへmerge済み、必須VerifierがPASS、E2E対象ならモックAPIのMaestro E2EがPASS |
| validation（最終確認SBI、Integration / E2Eが必要なPBIだけ1件まで） | 同じPBIの実装SBIがすべて完了 | 実API / Rails / DBへ接続したMaestro E2EがPASS |

人間確認はコード変更も実テストも持たないので、SBIにしない。PBI Human Acceptance Gateとして扱い、
すべての実装SBIが完了し、最終確認SBIがあればPASSした後に、そのEvidence digestに対する人間の`pbi-acceptance`承認で通る。
PBIは、すべてのSBIが完了し、PBI Human Acceptance Gateが承認され、PBIのblocker（GitHub issue dependenciesの`blocked by`）がすべてclosedのときだけ完了する。判定は`pbi-judge.mjs`の`judgePbi`で行う。
`pbi-acceptance`はImplementation Gate・Design Approval・Merge Approval・API Schema Approvalとは別の承認で、どれの代わりにもならない。
Maestroのlane（実装SBIはモックAPI、最終確認SBIは実API）とCompletion Judgeでの必須判定は[ci.md](ci.md)にある。

### PBI plan（PBIのSBI集合）

PBIのSBI集合の正本は、Plannerが書いた`## SBI構成`と、それに対する人間の承認コメントの組。
`pnpm harness:pbi-plan-approve <PBI URL>`は、`## SBI構成`がGitHub上のSBI Issue（`sbi`ラベルとPlannerのmarker）と一致するときだけ、人の`gh`でPBIに`harness-pbi-plan: <digest>`をコメントする。撤回は`--decision revoke`（`harness-pbi-plan-revoke: <digest>`）。

- digestは、PBI番号と、SBIごとのSBI ID・Issue番号・kind・依存（ID順に並べ、依存も並べる）のsha256。`## SBI構成`を書き換える、SBIを足す・外すとdigestが変わり、承認は無効になる。
- 承認として数えるのは、write以上の権限を持つ人の、承認行だけのコメント。botは数えない。権限を読めない人、編集されたコメントも数えない。人ごとに最新の判断を使い、1人で足りる。検証は`github-approval-records.mjs`（#147の`harness-spec`と共有）。
- `## SBI構成`が無い既存のPBIは、`pnpm harness:pbi-plan <PBI URL>`でGitHub上のSBI IssueからPBI本文に書いてから承認する。Plannerは再実行しない。

### PBIの完了判定

```sh
pnpm harness:pbi-status <PBI URL> [--json]
pnpm harness:pbi-accept <PBI URL> --evidence <digest> [--decision approve|revoke|request-changes]
```

`harness:pbi-status`は次を集めて`judgePbi`に渡し、`DONE` / `NOT_DONE`と理由を表示する（DONEはexit 0、NOT_DONEはexit 2）。`--json`は同じ結果をJSONで出す。

| 入力 | 取得元 |
| --- | --- |
| PBI plan | PBI本文の`## SBI構成`と`harness-pbi-plan`コメント。無い・未承認・承認が読めないときはNOT_DONE |
| SBI | `sbi`ラベルのIssueのうち、Plannerのmarkerがこのpbi URLを指すもの。kindは`## 種類`、依存は`## 依存SBI`。承認済みPBI planと完全に一致しなければNOT_DONE（「SBI #N が見つかりません」「SBI #N が承認済みPBI planに登録されていません」）。同じSBI IDのIssueが2件あってもNOT_DONE |
| merge | 依存SBIの確認と同じ。mainへmergeされ、`Closes #N`と`SBI-Issue:` trailerを持つHarness PR。Issueを手で閉じただけでは数えない |
| 必須Verifier | merged PRのhead SHAのcheck run。`github.requiredChecks`とmainのRulesetのrequired status checksがすべてsuccess |
| kind・E2E対象 | merged PRのhead SHAに入っている `.harness/state/sbi-<N>.json`（CIがIssueとの一致を確かめたsnapshot）。Issueの`## 種類`と一致しなければNOT_DONE。E2E対象かどうかはImpact Analysisと同じ`maestroLanes`で決める |
| E2E Evidence | merged head の `harness` checkが属するworkflow runの `maestro-results` artifact（`<lane>.json`）。実装SBIは`mock.json`、最終確認SBIは`real.json`だけを読む。lane・headSha・flow 1件以上・ログartifact 1件以上をCompletion Judgeと同じ条件で確かめる |
| blocker | PBIのGitHub issue dependencies（blocked by）。labelは見ない。closedでないものが1件でもあればNOT_DONE |
| Human Acceptance | `.harness/state/human/pbi-acceptance/`の署名付き台帳 |

GitHub・Evidence・台帳のどれかを読めなければ、理由を出してNOT_DONEにする。
Evidenceを読むのはmainへmergeされたHarness PRのCI runだけなので、最終確認SBIもHarness PRをmergeする必要がある。artifactは保存期限（90日）を過ぎると読めなくなり、そのPBIはNOT_DONEに戻る。

Evidence digestは、承認済みPBI planのdigest、SBIの構成（ID・Issue番号・kind）と、最終確認SBIがあればその`real.json`のsha256、なければ実装SBIごとのIssue・PR・head SHA・merge commit・E2E結果と`mock.json`のsha256をまとめたsha256。SBIを足す・外す・入れ替えると過去のAPPROVEは無効になる。
すべてのSBIが完了すると`harness:pbi-status`がdigestと`harness:pbi-accept`のコマンドを表示する。人間はEvidenceを確認してから記録する。
APPROVEはPBIの最終Gateなので、PBI planが承認済みで、すべてのSBIが完了し（最終確認SBIがあればPASS）、Evidenceを読めて`--evidence`が現在のdigestと一致し、openのblockerが無いときだけ記録する。blockerを読めないときも記録しない。REQUEST_CHANGES / REVOKEはいつでも記録できる。
人ごとに最新の判断を使い、現在のdigestに対するAPPROVEが1件あればGateを通る。`--reviewer`は無く、OSのユーザーが記録者になる。

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
