# CI: SBIに応じたVerifierの選択と並列実行

`.github/workflows/harness.yml` は次の順に動く。Verifierの定義は `.harness/config/harness.json` だけにあり、workflowはVerifier名もコマンドも持たない。

| job | 内容 |
| --- | --- |
| `impact` | `pnpm harness:impact` でrequired verifierとFull Gateの要否を決め、理由をログに出す |
| `verifiers` | required verifierごとのmatrix。`pnpm harness:verify --verifier <id>` を並列に実行する（`fail-fast: false`） |
| `harness-test` / `harness-demo` | Full Gateのときだけ、`harness:test` と `harness:demo --full` を並列に実行する |
| `harness` | Completion Judge。変更されたSBIのTrusted AcceptanceとSecurity Verifierを実行し、各jobの結果を集約する。必須チェック名なのでjob idを変えない |

## Verifierの選び方

PRで追加・変更された `.harness/state/sbi-*.json` と、base branchとの差分から決める。

| 根拠 | 選ばれるVerifier | 必須か |
| --- | --- | --- |
| SBIの `requiredVerifiers` | そのVerifier | 必須 |
| SBIの `affectedAreas` | `areas` にその領域を持つVerifier（api→rails、mobile→expo、admin→admin、prototype-web、prototype-mobile） | 必須 |
| 差分 | `appliesTo` に一致するVerifier。SBIが挙げていなければ `diff-not-in-sbi` を付けて追加する | 任意 |
| 領域の組み合わせ | `impact.crossLayer`。apiとmobile / adminが同時に変わるとapi-contractを追加する | 任意 |

必須のVerifierは、アプリが無い・コマンドが未設定ならFAILする。任意のVerifierは、対象がまだ作られていなければ「missing app (placeholder)」としてSKIPする。

## SBIが必須の変更

Production（`apps/`・`packages/`と`.harness/config/lanes.json`の`productionPaths`）を変更するPRは、`.harness/state/sbi-*.json`の追加か変更が必須。無ければCompletion JudgeがFAILする。
それ以外（`prototypes/`、docs、Harness本体など）だけを変更するPRはSBIなしで通り、Verifierは差分だけで選ぶ。
判定理由はimpact jobとharness jobのログの`SBI required:`行に出る。

`impact.fullGate` のパス（`tools/harness/`、`.harness/config|verification|rules|skills/`、`.github/`、`.githooks/`、`AGENTS.md`、`.ai/`）が変わったときはFull Gateも実行する。
`impact.toolchain` のパス（`.node-version`、`.tool-versions`、root の `package.json`、`pnpm-workspace.yaml`、`.npmrc`）が変わったときは、全Application VerifierとFull Gateを実行する。ログの理由は`toolchain:<path>`になる。workflowはこの判定の出力を使うだけで、pathを持たない。
mainへのpushでは全Verifierを実行し、Full Gateも実行する。

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

`packages/api-schema/openapi.yaml` がOpenAPI 3.1として読めること、base branchのcontractに対して破壊的変更（endpoint・必須の解除・enum値の削除など）がないことを検査する。破壊的変更はFAILにする。今は意図した破壊的変更を通す手段がない。openapi.yamlが無い間はplaceholderとしてSKIPする。Rails実装やFrontendとの整合はendpointができてから追加する。

## ローカルで同じ判定を見る

```sh
pnpm harness:impact --base origin/main
pnpm harness:verify --verifier admin --base origin/main
```

## pre-pushとの分担

`.githooks/pre-push`は`harness:check`と`harness:push-gate`を呼ぶだけで、Verifierの一覧を持たない。`harness:push-gate`がgitから渡されたpush先のcommitをbaseに`harness:impact`と同じ判定を行い、required verifierを順に実行する。新しいbranchは`origin/main`と比べる。

次の場合はFull Gateとして`harness:test`全件を実行する。

- `impact.fullGate`か`impact.toolchain`のパスが変わった
- 複数のrefを同時にpushした、pushするcommitがHEADではない、push先のcommitが手元に無い、比較するbaseが無い、refを読めない

hookはローカルの早期検出用で、回避できる。SBI必須・Trusted Acceptance・Security・`harness:demo --full`はCIのCompletion Judgeが最終判定する。
