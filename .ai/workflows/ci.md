# CI: SBIに応じたVerifierの選択と並列実行

`.github/workflows/harness.yml` は次の順に動く。Verifierの定義は `.harness/config/harness.json` だけにあり、workflowはVerifier名もコマンドも持たない。

| job | 内容 |
| --- | --- |
| `impact` | `pnpm harness:impact` でrequired verifierとFull Gateの要否を決め、理由をログに出す |
| `verifiers` | required verifierごとのmatrix。`pnpm harness:verify --verifier <id>` を並列に実行する（`fail-fast: false`） |
| `harness-test` / `harness-demo` | Full Gateのときだけ、`harness:test` と `harness:demo` を並列に実行する。実アプリVerifierまで回す `--full`（`HARNESS_DEMO_SCOPE`）はPR以外、つまりmainへのpushだけに付く |
| `maestro` | `impact` の `maestro` が空でないときだけ、Android EmulatorでMaestroを実行する（下記）。mainへのpushではDevelopment BuildのAPK cacheだけを作る |
| `harness` | Completion Judge。変更されたSBIのTrusted AcceptanceとSecurity Verifierを実行し、各jobの結果を集約する。必須チェック名なのでjob idを変えない |

## Maestro（mobile E2E）

Maestroは通常の`expo` Verifierに入れない。Impact Analysisの`maestro`（lane）は、PRのSBIから決める（`tools/harness/maestro.mjs`）。

| SBI | 条件 | lane |
| --- | --- | --- |
| implementation | `apps/mobile`が範囲にあり、Issueの`## 検証方法`の`E2E:`が「不要」でない（`E2E:`の行が無い場合も必要とみなす） | `mock`（承認済みOpenAPIのPrism） |
| validation | `apps/mobile`が範囲にある | `real`（Rails + DB） |

SBIの無いmobileの変更ではMaestroを実行しない。laneがあるとき、Completion Judgeは`maestro` jobの成功と、laneごとの結果ファイル（`HARNESS_MAESTRO_RESULTS/<lane>.json`、`node tools/harness/maestro.mjs`がMaestroのJUnit reportから作る）を求める。
jobが無い・失敗・skip、結果ファイルが無い・読めない・別のlaneや別のcommitのもの、flowが0件、失敗したflowがある、ログやスクリーンショットのartifactが無い、のどれかでFAILする。
`maestro` jobは、`tools/harness/maestro-build.sh` でDevelopment Build（`expo-dev-client` のdebug APK）を作り、`tools/harness/maestro-ci.sh` でlaneごとにPrism（mock）かRails + DB（real）とMetroを起動して、`apps/mobile/.maestro/<lane>/` を実行する。
APKはExpoのnative fingerprintをkeyにcacheし、fingerprintが同じなら作り直さない。cacheを保存するのはmainへのpushだけ。結果ファイルは `maestro-results`、JUnit report・ログ・スクリーンショットは `maestro-evidence` のartifactになり、harness jobが `maestro-results` をダウンロードしてCompletion Judgeに渡す。書き込みもダウンロードもcheckoutの外（`runner.temp`）で行うので、PRがコミットした結果ファイルは使われない（#188）。
mock laneは `packages/api-schema/openapi.yaml` が無いと起動できず、FAILする。この jobはDocker隔離の例外で、条件は[threat-model](../../docs/security/threat-model.md)にある。

## Verifierの選び方

PRで追加・変更された `.harness/state/sbi-*.json`（Harness Runのsnapshotと手書きのSBI JSON）と、base branchとの差分から決める。

| 根拠 | 選ばれるVerifier | 必須か |
| --- | --- | --- |
| SBIの `requiredVerifiers` | そのVerifier | 必須 |
| SBIの `affectedAreas` | `areas` にその領域を持つVerifier（api→rails、mobile→expo、admin→admin、prototype-web、prototype-mobile） | 必須 |
| 差分 | `appliesTo` に一致するVerifier。SBIが挙げていなければ `diff-not-in-sbi` を付けて追加する | 任意 |
| 領域の組み合わせ | `impact.crossLayer`。apiとmobile / adminが同時に変わるとapi-contractを追加する | 任意 |

必須のVerifierは、アプリが無い・コマンドが未設定ならFAILする。任意のVerifierは、対象がまだ作られていなければ「missing app (placeholder)」としてSKIPする。

## Production変更の起点

Production（`apps/`・`packages/`と`.harness/config/lanes.json`の`productionPaths`）を変更するPRは、diffのchange-typeでSBIの要否を決める（[ADR-0006](../../docs/adr/0006-change-type-classification.md)、`tools/harness/change-type.mjs`）。

| changeType | 条件 | requiresSbi |
| --- | --- | --- |
| `engineering` | Production配下の変更ファイルが、すべて`.harness/rules/change-types.json`のルールに当たる | false |
| `ambiguous` | 1ファイルでもルールに当たらない。symlink・バイナリ・mode変更、内容ルールを証明できない`package.json`・`Gemfile`も含む | true |

- 判定は変更ファイルのパスと内容だけで行う。commit message・PR本文・ブランチ名・trailer・Engineering Issueは使わない。
- `ambiguous`は「Engineeringと証明できなかった」を表し、productに変換しない。
- trusted dependency bot（Renovate）のPRは、`ambiguous`でも下記のbot例外でSBIを外せる。
- change-typeが決めるのはSBIの要否だけ。Verifier・Security・Risk・Human Reviewは通常どおり行う。

### SBI source: SBI Run snapshot

SBI sourceはchange-typeとは別の軸で判定する。`requiresSbi = true`のPRと、`.harness/state/sbi-*.json`を追加・変更・削除したPR（change-typeを問わない）に、次の検査を行う。`Harness-Run:` / `SBI-Issue:` trailerだけでは有効なSBI sourceにならない。

Completion Judge（`harness` job）が次をすべて確かめ、1つでも欠ければFAILする。

| 確認 | 内容 |
| --- | --- |
| snapshot | PRで追加・変更された `.harness/state/sbi-<Issue番号>.json` が `sbiSnapshotSchema` を満たす。source Issue（repo / number / url）、Run開始時のtitle / body digest、Run ID、RunのSBIを持つ |
| source Issue | GitHub APIで読んだ現在のIssueが、このリポジトリのもので、open・`sbi`・`ready`あり・`needs-review`なし。最後に`ready`を付けたのがwrite以上の人間でない、または`ready`を付けた後に本文・titleの編集があればFAIL（#194・#200）。読めなければFAIL。生成したTrusted Acceptance（version 2の登録）のPRでは、`ready`の代わりに現在のspec digestへの`harness-spec`承認（write以上・未編集）を求める。`ready`だけでは通らない |
| 現在のIssueとの一致 | 現在のIssue本文と、そのIssueのTrusted Acceptance登録（`.harness/acceptance/sbi-<番号>.json`）からSBIを組み立て直し、snapshotのSBIと完全に一致する。title / body digestも現在のIssueから計算し直して一致する。組み立てられない・1項目でも違えばFAILし、違う項目名を出す |
| Run の紐付け | PRのcommitのどれかが、snapshotと同じ値の `Harness-Run: <Run ID>` と `SBI-Issue: <Issue URL>` trailerを持つ |
| 変更ファイル数 | 実装SBI（`kind: implementation`）のPRは、snapshotと生成したTrusted Acceptance（登録とテスト）を除いた変更ファイル数（削除を含む）が、目安10ファイルとIssueの `## 想定変更ファイル数` の両方を超えたらFAIL。想定が書かれていないIssueもFAIL。最終確認SBIは数えない。通すにはPRを分けるか、Issueの想定を直して新しいRunを始める |

snapshotとtrailerはHarnessがRunとPR作成のときに書く。人間はSBI JSONを書かない。snapshotのSBIは手書きのSBI JSONと同じくImpact AnalysisとTrusted Acceptanceに使う。Issue本文からSBIへの組み立ては `tools/harness/sbi-issue.mjs` の `sbiFromIssue` で、Runの開始とCIで同じ処理を使う。
保証するのは「CIを実行した時点で、PRのsnapshotが承認済みSBI Issueの現在の内容と完全に一致し、snapshotが改変されていない」こと。Run開始後にIssueを編集した（チェックボックスを付けただけでも）PRはFAILする。編集を残すなら、そのIssueから新しいRunを始める。
snapshotをHarnessが書いたことの暗号学的な証明ではない。Issueと完全に一致するsnapshotとtrailerを手で作ることはできる。防ぐにはGitHub ActionsのOIDCなどによるRunの実行attestationが要る（未実装）。
trusted dependency botのPRは、作成者・全commitの作成者と署名・変更ファイル（`.harness/rules/dependency-bots.json`の許可パスだけ）・head SHA・head repositoryをGitHub APIで確かめられたときだけ、上の確認を外す（[dependency-updates.md](../../docs/workflows/dependency-updates.md)）。外すのはSBI Issueの要件だけで、Verifier・Security・Riskは通常どおり判定する。確かめられなければSBI必須のまま。ログの `SBI source` 行に結果が出る。
source Issueを持たない手書きの `sbi-*.json`（`sbi-admin-env.json` など）はProduct implementationの根拠にならない。

Engineering Issueは起点の判定に使わない（[docs/workflows/engineering-changes.md](../../docs/workflows/engineering-changes.md)）。

それ以外（`prototypes/`、docs、Harness本体など）だけを変更するPRはchange-typeを持たずSBIなしで通り、Verifierは差分だけで選ぶ。mainへのpushでもsource確認は行わない。
判定理由はimpact jobとharness jobのログに出る。`Change type: engineering / SBI not required`か`Change type: ambiguous / SBI required (fail-closed)`の行に続けて、ファイルごとに当たったルール（`Change type rule <id>: <path>`）か、証明できなかった理由（`Change type ambiguous: <path> (<reason>)`）を出す。harness jobの `SBI source check:` 行にSBI sourceの結果が出て、検査に通ったときだけ`Source: SBI #<番号>`を出す。harness jobはIssueを読むため `issues: read` と `GH_TOKEN` を持つ。

`impact.fullGate` のパス（`tools/harness/`、`.harness/config|verification|rules|skills/`、`.github/`、`.githooks/`、`AGENTS.md`、`.ai/`）が変わったときはFull Gateも実行する。
`impact.toolchain` のパス（`.node-version`、`.tool-versions`、root の `package.json`、`pnpm-workspace.yaml`、`.npmrc`）が変わったときは、全Application VerifierとFull Gateを実行する。ログの理由は`toolchain:<path>`になる。workflowはこの判定の出力を使うだけで、pathを持たない。
mainへのpushでは全Verifierを実行し、Full Gateも実行する。
Full Gateの`harness-demo`は、PRでは`harness:demo`（fake providerの自己修復ループだけ）、mainへのpushでは`harness:demo --full`（lane内の全アプリVerifierをrun worktreeで再実行）になる。PRで約7分かかっていたのは`--full`の分で、ループ自体の検証には要らない（#192）。

## Completion Judgeの判定

`harness` jobは次の3つがすべてPASSのときだけPASSにする。ログの`Application:` / `Acceptance:` / `Security:`行にそれぞれの結果が出る。

| 区分 | 内容 |
| --- | --- |
| Application | `verifiers` matrixと、Full Gateなら`harness-test` / `harness-demo`のjob結果 |
| Acceptance | 変更されたSBIのTrusted Acceptance（`trust: acceptance`）をjudge内で実行した結果。生成したTrusted Acceptanceは下記 |
| Security | `classifySecurity()`がdiffとSBIから決めたrequired verifierを`verifySecurity()`で評価した結果。`alwaysRequiredVerifiers`（secret-scan・forbidden-pattern-check）は常に含む。`appliesTo`を持つ実装Verifierは、ルールに一致したファイルがその範囲に入るときだけ含む |

- 生成したTrusted Acceptance（#147）はPRのコードを動かすため、judgeでは実行しない。Impact Analysisが`generated-acceptance-sbi-<番号>`を必須の`verifiers` matrixに入れ、そのlegが生成specをDocker Compose経由で実行して、RSpecの結果を`HARNESS_ACCEPTANCE_RESULTS/sbi-<番号>.json`（head SHA付き）に残し、`acceptance-results-<verifier>` artifactにする。judgeはそれをダウンロードし、現在のIssueのspec digest・生成テストとspec supportのdigestを登録と照合してから、結果ファイルでACを判定する。結果ファイルが無い・形が違う・別SHA・Issueを読めない、のどれもFAIL。実装前の検出（G）のCIでの再検証はまだ無い（#168まではL3のまま）。
- SecurityはFAIL・NOT_CONFIGURED・SKIP・未実行をPASS扱いしない。Security ruleが追加したverifierのコマンドが未設定なら、そのPRはFAILする。
- SBIの`requiredVerifiers`にあるapplication verifierは、matrix jobの結果をSecurityの判定にも使う。
- secret-scanとforbidden-pattern-checkは、変更ファイルの追加行を検査する。`tools/harness/*.test.mjs`はredactionのfixtureを含むため、Harness worktree作成時と同じくcredential形式の値だけを秘密値とみなす。
- mainへのpush（`--all`）は差分が無いので、Securityの検査対象も無い。PRの判定で検査済みの前提。
- 実装前Gate・Human Approvalの要否はCIでは判定しない。Harness runとGitHub Reviewで扱う。

## expo-doctor

`expo` と `prototype-mobile` の `pnpm run doctor`（expo-doctor）は `gatedCommands` で、依存・native・toolchainの変更があるときだけ実行する。expo-doctorは公開済みの最新Expoと比べるため、リポジトリが変わらなくてもExpoのpatch公開だけでFAILするから。
対象は各アプリの `package.json`・`app.json`・`app.config.*`・`eas.json`・`babel.config.*`・`metro.config.*`・`react-native.config.*`・`ios/`・`android/`と、rootの `package.json`・`pnpm-workspace.yaml`・`.npmrc`・`.node-version`・`.nvmrc`・`.tool-versions`。root `pnpm-lock.yaml` はAdminなど他アプリの依存更新でも変わるため起動条件に含めない。Mobileの依存更新は `apps/mobile/package.json`・`prototypes/mobile/package.json` の変更で起動する。
実行するときはimpact jobのログに `gate:pnpm run doctor:<path>` が出る。実行しなかったときは、Verifierの結果の `skippedCommands` に理由が残る。typecheck・Biome・Jest・architecture checkは従来どおり毎回実行する。
`--all`（mainへのpush）、`harness:demo --full`、SBIの `affectedAreas` では実行しない。SBIの `requiredVerifiers`・Security・ACで `expo` Verifierが選ばれても、doctorの実行条件は変わらない。変更パスが上の対象に該当したときだけ実行する。Expo/React NativeはRenovate対象外で、Expoの更新は専用の手動dependency更新PR（`expo install --fix` 等）で扱う。

## api-contract

`packages/api-schema/openapi.yaml` がOpenAPI 3.1として読めること、base branchのcontractに対して破壊的変更（endpoint・必須の解除・enum値の削除など）がないことを検査する。破壊的変更はFAILにする。今は意図した破壊的変更を通す手段がない。openapi.yamlが無い間はplaceholderとしてSKIPする。

Railsのrouteも照合する。Railsを起動せず、`apps/api/config/routes.manifest.json`（`bin/rails contract:routes` で生成し、RSpecが鮮度を検査する）を読む。

- 契約に無いmethod + pathのroute、任意segment付きのroute、methodを限定しないrouteはFAIL。path parameterは名前ではなく位置で比べ、`(.:format)` は無視する。
- `rails/` 等のframework controller（`/up` など）は対象外。
- 契約にあってRailsに無いoperationはFAILにせず `UNIMPLEMENTED` として出す。契約が実装SBIより先に承認されるため。
- api-onlyの変更ではapi-contractが選ばれないので、rails Verifierの最初のcommand（`api-contract.mjs --routes`）でも同じ照合をする。openapi.yamlが無ければ業務routeはすべてFAIL。
- `resources` が作るPUTも契約に無ければFAIL。契約にPUTを書くか、routeを `patch` で明示する。

request / response bodyは、rails Verifierの `bundle exec rspec` がrequest specの実データで照合する（apps/api/README.md「request specの契約検証」）。
rails Verifierは `API_CONTRACT_COVERAGE=required` でrspecを実行し、suiteの一部しか実行されなければFAILする。契約と実データが合わないexampleはFAILし、full suiteの最後に業務routeごとの照合状況（`COVERED` / `UNCOVERED` / `UNIMPLEMENTED`）を出す。業務routeに照合したspecが無い、または `openapi.yaml` が無いのに業務routeがあればFAILする。
`packages/api-schema/` の変更でもrails Verifierが選ばれるので、契約変更は既存のrequest specで検証される。

未実装: Admin / Mobileのrequest / response照合。

## ローカルで同じ判定を見る

```sh
pnpm harness:impact --base origin/main
pnpm harness:verify --verifier admin --base origin/main
```

## pre-pushとの分担

`.githooks/pre-push`は`harness:check`と`harness:push-gate`を呼ぶだけで、Verifierの一覧を持たない。`harness:push-gate`がgitから渡されたpush先のcommitをbaseに`harness:impact`と同じ判定を行い、required verifierを順に実行する。新しいbranchは`origin/main`と比べる。

検証はcheckoutのworking treeではなく、pushするcommitのdetached worktree（OSの一時ディレクトリ）で行う。未commitの修正でworking treeだけがPASSしても、壊れたcommitはpushできない。worktreeでは`pnpm install --frozen-lockfile --prefer-offline`を先に実行する。検証後は`git worktree remove`（forceなし）で消し、検証が未追跡ファイルを残して消せなかったときはパスをログに出して残す。

次の場合はFull Gateとして`harness:test`全件を実行する。

- `impact.fullGate`か`impact.toolchain`のパスが変わった
- 複数のrefを同時にpushした（pushするcommitごとに実行）、push先のcommitが手元に無い、比較するbaseが無い、refを読めない（HEADのcommitで実行）

hookはローカルの早期検出用で、回避できる。Production source・Trusted Acceptance・Security・`harness:demo`はCIのCompletion Judgeが最終判定する。
