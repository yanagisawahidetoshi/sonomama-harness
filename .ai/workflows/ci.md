# CI: SBIに応じたVerifierの選択と並列実行

`.github/workflows/harness.yml` は次の順に動く。Verifierの定義は `.harness/config/harness.json` だけにあり、workflowはVerifier名もコマンドも持たない。

| job | 内容 |
| --- | --- |
| `impact` | `pnpm harness:impact` でrequired verifierとFull Gateの要否を決め、理由をログに出す |
| `verifiers` | required verifierごとのmatrix。`pnpm harness:verify --verifier <id>` を並列に実行する（`fail-fast: false`） |
| `harness-test` / `harness-demo` | Full Gateのときだけ、`harness:test` と `harness:demo --full` を並列に実行する |
| `harness` | Completion Judge。変更されたSBIのTrusted Acceptanceを実行し、各jobの結果を集約する。必須チェック名なのでjob idを変えない |

## Verifierの選び方

PRで追加・変更された `.harness/state/sbi-*.json` と、base branchとの差分から決める。

| 根拠 | 選ばれるVerifier | 必須か |
| --- | --- | --- |
| SBIの `requiredVerifiers` | そのVerifier | 必須 |
| SBIの `affectedAreas` | `areas` にその領域を持つVerifier（api→rails、mobile→expo、admin→admin、prototype-web、prototype-mobile） | 必須 |
| 差分 | `appliesTo` に一致するVerifier。SBIが挙げていなければ `diff-not-in-sbi` を付けて追加する | 任意 |
| 領域の組み合わせ | `impact.crossLayer`。apiとmobile / adminが同時に変わるとapi-contractを追加する | 任意 |

必須のVerifierは、アプリが無い・コマンドが未設定ならFAILする。任意のVerifierは、対象がまだ作られていなければ「missing app (placeholder)」としてSKIPする。SBIの無いPRは差分だけで選ぶ。

`impact.fullGate` のパス（`tools/harness/`、`.harness/config|verification|rules|skills/`、`.github/`、`.githooks/`、`AGENTS.md`、`.ai/`、root の `package.json`）が変わったときはFull Gateも実行する。mainへのpushでは全Verifierを実行し、Full Gateも実行する。

## expo-doctor

`expo` と `prototype-mobile` の `pnpm run doctor`（expo-doctor）は `gatedCommands` で、依存・native・toolchainの変更があるときだけ実行する。expo-doctorは公開済みの最新Expoと比べるため、リポジトリが変わらなくてもExpoのpatch公開だけでFAILするから。
対象は各アプリの `package.json`・`app.json`・`app.config.*`・`eas.json`・`babel.config.*`・`metro.config.*`・`react-native.config.*`・`ios/`・`android/`と、rootの `package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml`・`.npmrc`・`.node-version`・`.nvmrc`・`.tool-versions`。lockfileはどのimporterが変わったかを見ず、変更があれば実行する。
実行するときはimpact jobのログに `gate:pnpm run doctor:<path>` が出る。実行しなかったときは、Verifierの結果の `skippedCommands` に理由が残る。typecheck・Biome・Jest・architecture checkは従来どおり毎回実行する。
`--all`（mainへのpush）、`harness:demo --full`、SBIの `affectedAreas` では実行しない。SBIの `requiredVerifiers`・Security・ACでそのVerifierが指定されたときは、パスに関係なく実行する。依存の追従はRenovateとdependency更新PRで扱う。

## api-contract

`packages/api-schema/openapi.yaml` がOpenAPI 3.1として読めること、base branchのcontractに対して破壊的変更（endpoint・必須の解除・enum値の削除など）がないことを検査する。破壊的変更はFAILにする。今は意図した破壊的変更を通す手段がない。openapi.yamlが無い間はplaceholderとしてSKIPする。Rails実装やFrontendとの整合はendpointができてから追加する。

## ローカルで同じ判定を見る

```sh
pnpm harness:impact --base origin/main
pnpm harness:verify --verifier admin --base origin/main
```
