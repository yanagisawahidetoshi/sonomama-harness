# CI: SBIに応じたVerifierの選択と並列実行

`.github/workflows/harness.yml` は次の順に動く。Verifierの定義は `.harness/config/harness.json` だけにあり、workflowはVerifier名もコマンドも持たない。

| job | 内容 |
| --- | --- |
| `impact` | `pnpm harness:impact` でrequired verifierとFull Gateの要否を決め、理由をログに出す |
| `verifiers` | required verifierごとのmatrix。`pnpm harness:verify --verifier <id>` を並列に実行する（`fail-fast: false`） |
| `harness-test` / `harness-demo` | Full Gateのときだけ、`harness:test` と `harness:demo --full` を並列に実行する |
| `harness` | Completion Judge。変更されたSBIのTrusted AcceptanceとSecurity Verifierを実行し、各jobの結果を集約する。必須チェック名なのでjob idを変えない |

## Verifierの選び方

PRで追加・変更された `.harness/state/sbi-*.json`（Harness Runのsnapshotと手書きのSBI JSON）と、base branchとの差分から決める。

| 根拠 | 選ばれるVerifier | 必須か |
| --- | --- | --- |
| SBIの `requiredVerifiers` | そのVerifier | 必須 |
| SBIの `affectedAreas` | `areas` にその領域を持つVerifier（api→rails、mobile→expo、admin→admin、prototype-web、prototype-mobile） | 必須 |
| 差分 | `appliesTo` に一致するVerifier。SBIが挙げていなければ `diff-not-in-sbi` を付けて追加する | 任意 |
| 領域の組み合わせ | `impact.crossLayer`。apiとmobile / adminが同時に変わるとapi-contractを追加する | 任意 |

必須のVerifierは、アプリが無い・コマンドが未設定ならFAILする。任意のVerifierは、対象がまだ作られていなければ「missing app (placeholder)」としてSKIPする。

## SBIが必須の変更

Production（`apps/`・`packages/`と`.harness/config/lanes.json`の`productionPaths`）を変更するPRは、承認済みSBI Issueを起点にしたHarness Runから作られていることが必須。Completion Judge（`harness` job）が次をすべて確かめ、1つでも欠ければFAILする。

| 確認 | 内容 |
| --- | --- |
| snapshot | PRで追加・変更された `.harness/state/sbi-<Issue番号>.json` が `sbiSnapshotSchema` を満たす。source Issue（repo / number / url）、Run開始時のtitle / body digest、Run ID、RunのSBIを持つ |
| source Issue | GitHub APIで読んだ現在のIssueが、このリポジトリのもので、open・`sbi`・`ready`あり・`needs-review`なし。読めなければFAIL |
| 現在のIssueとの一致 | 現在のIssue本文と、そのIssueのTrusted Acceptance登録（`.harness/acceptance/sbi-<番号>.json`）からSBIを組み立て直し、snapshotのSBIと完全に一致する。title / body digestも現在のIssueから計算し直して一致する。組み立てられない・1項目でも違えばFAILし、違う項目名を出す |
| Run の紐付け | PRのcommitのどれかが、snapshotと同じ値の `Harness-Run: <Run ID>` と `SBI-Issue: <Issue URL>` trailerを持つ |

snapshotとtrailerはHarnessがRunとPR作成のときに書く。人間はSBI JSONを書かない。snapshotのSBIは手書きのSBI JSONと同じくImpact AnalysisとTrusted Acceptanceに使う。Issue本文からSBIへの組み立ては `tools/harness/sbi-issue.mjs` の `sbiFromIssue` で、Runの開始とCIで同じ処理を使う。
保証するのは「CIを実行した時点で、PRのsnapshotが承認済みSBI Issueの現在の内容と完全に一致し、snapshotが改変されていない」こと。Run開始後にIssueを編集した（チェックボックスを付けただけでも）PRはFAILする。編集を残すなら、そのIssueから新しいRunを始める。
snapshotをHarnessが書いたことの暗号学的な証明ではない。Issueと完全に一致するsnapshotとtrailerを手で作ることはできる。防ぐにはGitHub ActionsのOIDCなどによるRunの実行attestationが要る（未実装）。
source Issueを持たない手書きの `sbi-*.json`（`sbi-admin-env.json` など）はProduction変更の根拠にならない。触らないPRには影響しない。
それ以外（`prototypes/`、docs、Harness本体など）だけを変更するPRはSBIなしで通り、Verifierは差分だけで選ぶ。mainへのpushでも確認しない。
判定理由はimpact jobとharness jobのログの `SBI required:` 行と、harness jobの `SBI source` 行に出る。harness jobはIssueを読むため `issues: read` と `GH_TOKEN` を持つ。

`impact.fullGate` のパス（`tools/harness/`、`.harness/config|verification|rules|skills/`、`.github/`、`.githooks/`、`AGENTS.md`、`.ai/`、root の `package.json`）が変わったときはFull Gateも実行する。mainへのpushでは全Verifierを実行し、Full Gateも実行する。

## Completion Judgeの判定

`harness` jobは次の3つがすべてPASSのときだけPASSにする。ログの`Application:` / `Acceptance:` / `Security:`行にそれぞれの結果が出る。

| 区分 | 内容 |
| --- | --- |
| Application | `verifiers` matrixと、Full Gateなら`harness-test` / `harness-demo`のjob結果 |
| Acceptance | 変更されたSBIのTrusted Acceptance（`trust: acceptance`）をjudge内で実行した結果 |
| Security | `classifySecurity()`がdiffとSBIから決めたrequired verifierを`verifySecurity()`で評価した結果。`alwaysRequiredVerifiers`（secret-scan・forbidden-pattern-check）は常に含む |

- SecurityはFAIL・NOT_CONFIGURED・SKIP・未実行をPASS扱いしない。Security ruleが追加したverifierのコマンドが未設定なら、そのPRはFAILする。
- SBIの`requiredVerifiers`にあるapplication verifierは、matrix jobの結果をSecurityの判定にも使う。
- secret-scanとforbidden-pattern-checkは、変更ファイルの追加行を検査する。`tools/harness/*.test.mjs`はredactionのfixtureを含むため、Harness worktree作成時と同じくcredential形式の値だけを秘密値とみなす。
- mainへのpush（`--all`）は差分が無いので、Securityの検査対象も無い。PRの判定で検査済みの前提。
- 実装前Gate・Human Approvalの要否はCIでは判定しない。Harness runとGitHub Reviewで扱う。

## api-contract

`packages/api-schema/openapi.yaml` がOpenAPI 3.1として読めること、base branchのcontractに対して破壊的変更（endpoint・必須の解除・enum値の削除など）がないことを検査する。破壊的変更はFAILにする。今は意図した破壊的変更を通す手段がない。openapi.yamlが無い間はplaceholderとしてSKIPする。

Railsのrouteも照合する。Railsを起動せず、`apps/api/config/routes.manifest.json`（`bin/rails contract:routes` で生成し、RSpecが鮮度を検査する）を読む。

- 契約に無いmethod + pathのroute、任意segment付きのroute、methodを限定しないrouteはFAIL。path parameterは名前ではなく位置で比べ、`(.:format)` は無視する。
- `rails/` 等のframework controller（`/up` など）は対象外。
- 契約にあってRailsに無いoperationはFAILにせず `UNIMPLEMENTED` として出す。契約が実装SBIより先に承認されるため。
- api-onlyの変更ではapi-contractが選ばれないので、rails Verifierの最初のcommand（`api-contract.mjs --routes`）でも同じ照合をする。openapi.yamlが無ければ業務routeはすべてFAIL。
- `resources` が作るPUTも契約に無ければFAIL。契約にPUTを書くか、routeを `patch` で明示する。

未実装: request / response bodyの照合（Rails・Admin / Mobileとも）。照合方法とライブラリは未決定。

## ローカルで同じ判定を見る

```sh
pnpm harness:impact --base origin/main
pnpm harness:verify --verifier admin --base origin/main
```
