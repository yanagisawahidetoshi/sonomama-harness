# SONOMAMA Local Harness

SBI単位で「実装 → 検証 → 修正」を回し、Security・Risk・人間の承認からマージ可否まで判定するローカル基盤。

Rails API + Expo + React adminの将来構成に向けた、ローカルLoop Engineering基盤。
アプリ本体はplaceholder。クラウドFactory、CI/CD、PR作成、実際のmergeは実装しない。
このリポジトリはHarness専用。既存の動画PoC・参照ファイル・実行履歴・秘密情報は含めない。

## 実行

Node.js 22以上、pnpm 8以上、Git 2.28以上が必要。レビューZIPの作成にはzip、テストにはunzipも使用する。

```sh
pnpm install --frozen-lockfile
pnpm harness:check
pnpm harness:test
pnpm harness:demo
```

fakeは認証・外部通信なしで、次の流れを実行する。

```text
SBI → 意図的な誤実装 → Verifier FAIL
    → 修正 → Verifier PASS → Security PASS → Policy Review PASS
    → Semantic Review（有効時のみ）→ Completion Judge → Execution DONE
    → Risk Classifier: LEVEL 2 → WAITING_FOR_HUMAN_REVIEW
```

デモは実装完了とリスク判定まで確認してexit 0。通常のrun/resumeはMERGE_ALLOWEDでexit 0、
承認待ち・停止はexit 2、入力やCLI操作のエラーはexit 1。
**Execution DONEはマージ承認ではない。** このサンプルはruntime変更のため既定LEVEL 2。
承認を自動生成せず、実際のmergeも行わない。

## 構成

| 場所 | 役割 |
| --- | --- |
| apps/api・mobile・admin | Rails / Expo / Reactのアプリ |
| packages/api-schema | 将来のOpenAPI SSOT |
| .harness/config/harness.json | provider、閾値、Verifier Registry、Semantic Review設定 |
| .harness/state/sample-sbi.json | Gherkin、AC、許可ファイル、risk |
| .harness/rules/policy.json | Human Gateと変更許可のポリシー |
| .harness/rules/pr-risk.json | Default Risk、最低Risk、安全な降格候補 |
| docs/security/ | 人間向けSecurity Requirements / PolicyのSSOT |
| .harness/rules/security.json | Rule ID・検知・必須検証・Security最低Risk |
| .harness/rules/human-gates.json | 事前承認が必要なSecurity rule IDへの参照 |
| .harness/skills/implement.md | agentへの実装手順 |
| .harness/skills/plan.md | PlannerへのPBI → SBI分割手順 |
| .harness/skills/api-schema.md | API Schema PlannerへのAPI契約提案の手順 |
| .harness/api-schema/ | API Schema Proposal（Issue番号別）。Git管理対象 |
| .harness/state/runs/ | run別の状態保存 |
| .harness/state/human/ | 信頼する人間用CLIの承認台帳と署名鍵。Git管理対象外 |
| .harness/state/api-schema/ | API Schema Plannerが署名した生成記録。Git管理対象外 |
| .harness/runs/ | 実行証跡と元リポジトリを共有するGit worktree |
| tools/harness/ | 実行ループ・分類・承認・マージ可否の判定、PBI → SBI Planner、API Schema Planner |
| docs/ | 人間向けの設計・方針・ADR・運用の概要（[docs/README.md](docs/README.md)） |
| .ai/ | AIが実装・レビュー時に読む前提・制約・作業手順 |

AIへの開発指示の入口は[AGENTS.md](AGENTS.md)。詳細は.ai/にある。
設定・SBI・リスクポリシー・agentレスポンス・承認レコードはZodで検証する。

## 同じworkspaceを実装・検証・レビューする

cleanな元リポジトリのHEADから、各runにdetached Git worktreeを作成する。
元フォルダは変更せず、baseline SHAは元のHEADそのもの、各iterationのHEADはその子孫になる。
.npmrc / .ruby-version / .tool-versions / tsconfig等も、Git管理された設定をそのまま引き継ぐ。
開始前に未commit・未追跡の入力変更があれば停止する。設定とSBIも先にcommitする。
Agentの変更、Verifierのcwd、Policy Review、Security Check、差分取得は同じworkspaceを使う。
信頼するテストと検証スクリプトはagentの書き込み領域の外で管理する。

agentは許可されたファイルのJSONを返し、Harnessが検査して適用する。
`.git`、`.harness`、`.ai`、`tools`、`sources`、`.github`、`.githooks`、AGENTS.mdは書き込み不可。
apps / packages / prototypesのApplication TestはSBI.allowedFilesに明記すればTDDで変更できる。
CLIが直接ファイルを変更した場合も停止する。差分をローカルcommitしてから検証する。

承認・resume時はHEAD、未commit変更、Gitで無視されたファイルを含むsource fingerprint、
入力設定、SBI、rules、スキル、信頼するHarnessコードの一致を確認する。
いずれか変われば以前の検証・承認を使わずESCALATED。新しいrunで再検証・再承認する。
実装DONE後のmerge判定で止まってもexecutionStatusはDONEのまま残し、merge.failureに理由（code・retryable）を記録する。
元のcheckoutの未commitファイルだけ（信頼する入力は一致）や一時的なGit/IOエラーはmerge.state=RETRYABLEとし、
原因を解消して同じrunを`harness:resume`で再判定できる。上記の不一致はESCALATEDで、原因が消えてもそのrunは再開しない。
node_modulesはworktreeへ持ち込まず、fingerprintの対象外。アプリを接続する際は同じworkspaceに必要な実行環境を準備する。
検証コマンドによるsource変更も拒否する。アプリのverifierは先頭で`pnpm install --frozen-lockfile --filter <app>`を実行し、
build出力はnode_modules配下へ出してsnapshotを変えない。

## Verifier Registry

組み込みsample-bddとharness.jsonのverifiersをIDで登録する。
SBIの各ACは登録済みverifierとacceptanceIdsに対応させる。未知のIDはcheckで拒否する。
Application Test用コマンドは全てexit 0でPASSとなるが、ACの合格証拠には使わない。
ACは組み込みsample-bddまたは`trust: "acceptance"`と`trustedScript`で登録した
`.harness/verification/*.mjs`の独立したassertionで検証する。スクリプトは第1引数のworktreeを検証し、
成功時に`{"acceptance":["AC-ID"]}`をJSON出力する。Agentが変更できるテストへの委譲や自己申告は不可。

| adapter | 未生成判定marker | 接続予定 |
| --- | --- | --- |
| rails | apps/api/Gemfile | 接続済み: Docker Compose経由でbuild / db:prepare / RSpec / RuboCop / Brakeman / Bundler Audit / Zeitwerk。ACは`api-acceptance`。OpenAPI contractは未接続 |
| expo | apps/mobile/package.json | 接続済み: install / TypeScript / Biome / Jest + RNTL / expo-doctor。ACは`mobile-acceptance`。Maestroはローカルのみ |
| admin | apps/admin/package.json | 接続済み: install / TypeScript / Biome / Vitest + RTL / build。ACは`admin-acceptance` |

markerなしでallowMissing=trueかつそのACを要求しないアプリだけ、対象外としてSKIPできる。
lockfile等のroot共有ファイルだけが変わった場合も、未生成アプリはSKIP。アプリ配下の変更があればFAIL。
allowMissing=false、またはACがそのadapterを要求する場合は必須なのでFAIL。
markerあり・commands未設定もFAIL。**対象となる必須チェックはすべてPASSが必要。**

commandsは引数配列で指定する。例は`[["bundle", "exec", "rspec"]]`。
cwdは常に`<run>/workspace/<directory>`。将来のアプリを生成したら必要な全検証を登録する。
SBI固有のテストは任意のverifier IDとacceptanceIdsで追加できる。

## ReviewerとSecurity Check

Policy Reviewerは、許可ファイルの存在・空ファイル・サイズ・TODO/FIXMEを確認する。
Security Checkはsecurity.jsonとSBIから必要なSecurity Verifierを決めて実行する。
秘密情報・禁止パターンの基本検査は全runで必須。Security条件は承認人数で上書きできない。

Semantic Reviewは既定で無効。有効ならPASSが必須で、adapter未設定はFAIL。
`runHarness` / `resumeRun`のsemanticReviewer引数が信頼するadapterの接続点。
返すstatusはPASS/FAIL、追加リスクはriskLevel=1/2/3で指定する。
AIの判断はRiskを上げる方向にだけ使い、人間の承認人数には数えない。
失敗結果は次iterationへ渡し、再実装→再検証→再レビューする。

## Security Enforcement

人間向けの要件は[docs/security/README.md](docs/security/README.md)をSSOTにする。
Harnessは誰がどのデータを見られるか、PIIの定義、retention期間、匿名化要件、
業務上の権限モデルを決めない。docs/security・docs/product・ADRで人間が決める。
今回作成したSecurity文書は未決事項とRule IDの対応を示す最小テンプレート。

security.jsonの各ルールはSEC-AUTH-001、SEC-RLS-001、SEC-PII-001などのIDで文書に紐付く。
checkはrule ID、参照文書、事前GateのID一覧、Registryの整合性を検証する。
Security Impact Classifierは、パス、変更行、SBI、AC、明示的securityImpact、保護された設計を評価する。
AuthN/AuthZ/RLS/PII/Secret/Migration/schema/role・permission/Security Config/CI/CD/Infrastructure/
破壊的操作/削除・匿名化・retention/API認証・認可/PIIログを検知する初期ルールを用意している。
分類はパターンと宣言に基づき、未知の意味上の影響を完全に推論する仕組みではない。

SBIで次のmetadataを指定できる。

```json
{
  "securityImpact": ["RLS", "PII"],
  "requiredSecurityRules": ["SEC-RLS-001", "SEC-PII-001"],
  "requiredVerifiers": ["rails-rls-test", "pii-log-check"],
  "preImplementationGate": true,
  "minimumRiskLevel": 3
}
```

Security-sensitiveな変更は事前Gate・最低LEVEL 3を強制する。
Gate承認はそのSBIと検知した変更範囲に対するもの。agentが新しいSecurity影響を提案したら、
適用前に止め、新しいSBI/承認を要求する。実装後の2人承認で事前Gateを代用できない。
既存のgate.state=WAITING_FOR_HUMAN_GATEは維持し、approvalState=WAITING_FOR_HUMAN_APPROVALを併記する。

Security Verifierは次の状態を区別する。

| 状態 | 意味 |
| --- | --- |
| PASS | 対象の検証を実行して成功 |
| FAIL | 対象の検証を実行して失敗 |
| SKIP | この変更では対象外 |
| NOT_CONFIGURED | 必須だがコマンド・必要なツールが未設定／未導入 |

requiredな検証はすべてPASSが必要。FAIL・SKIP・NOT_CONFIGURED、未承認Gate、rule violationがあれば
Completion JudgeもMerge Policy Judgeも拒否する。未設定の必須検証は修正ループで解決できないため即Escalation。

組み込みはsecret-scan / forbidden-pattern-check / pii-log-check。
Rails Brakeman / bundler-audit / authz / RLS / OpenAPI security、dependency-audit、migration-safety、
authz-ui-test、sensitive-storage-check、data-lifecycle-testは接続用placeholderを用意する。
必要になったplaceholderはSKIPにせずNOT_CONFIGUREDにする。
harness.jsonのsecurityVerifiersにid、workspace内directory、信頼するcommandsを登録して接続する。
組み込みの必須検査は置き換えられない。実ツール本体の導入・本番の権限検証はまだ行っていない。

Security / Human Gateの強制 → minimumRiskLevel → protected path → deterministic → AIによる上方提案
→ 明示的なLOW候補の順に優先する。DefaultはLEVEL 2。
docs/securityとdocs/adrはdocs-onlyのLOW候補より保護ルールを優先する。

## Secret保護とレビューZIP

.env / .env.* / pem / key / p12 / pfx / credentials* / secrets* / .upload-access-keyは
Git管理しない。未追跡・ignoredの秘密ファイルはworktreeに現れず、レビューexportからも除外する。
仕様で必要なdocs/security/secrets.mdだけは文書として残し、内容は検査する。
trackedファイルに秘密パスやcredentialを検知した場合は、worktree作成前に停止する。
例外は`.env.example` / `.env.sample` / `.env.template`と`.env.development.example`のように同じ接尾辞を持つdotenvテンプレート。
64 KiB以下のテキストを検査し、キーやパスワードは空欄・`${ENV_VAR}`・`<your-token>`・`your_api_key_here`・`replace-me`等の既知placeholderだけを許可する。
トークン形式、鍵、認証情報入りURL、実値のある機密項目、コメント内の秘密は拒否する。
実運用の`.env` / `.env.local`や機密ディレクトリ内のテンプレートは引き続き拒否する。
この例外はtrackedファイルの取込専用で、Agent書込やレビューexportの許可には使わない。
保護されたHarnessテストに含まれる検出用文字列は一般ソースの代入検出と分け、実際のトークン形式と鍵を検査する。
共有Git object DBの過去履歴を秘密情報の隔離境界にはできないため、秘密をcommitした履歴の除去は人間が別途行う。
Agentは読取専用／ツール無効のproviderからJSONだけを返す。これは信頼したローカルOSでの実行であり、敵対プロセスのOS隔離ではない。

agentが秘密値を提案した場合は、workspaceへの適用・Git commitより前に停止する。
prompt・JSON・ログ・例外出力にredactionを適用し、外部CLIの生レスポンスはrun外の一時領域で受けて削除する。
redactionExtensionsで固有の伏せ字処理を追加できる。公開値の許可やPIIの業務定義は人間が別途定める。

```sh
pnpm harness:export --run RUN_ID
# 必要なら --out 出力先.zip を指定。既存ファイルへの上書きは拒否する。
```

export時にも再検査し、旧run内の秘密ファイルから伏せるべき値を取得する。
.gitの全オブジェクト、鍵、node_modules、バイナリを含めず、伏せ字化したレビュー用ZIPを作る。
出力は既定で.harness/exports配下。以前作ったZIPを自動修正する機能ではない。
既知値・検知パターンによる保護なので、任意の未知の値の意味を完全に判別するものではない。
秘密情報を入力しない運用と、用途に応じたredaction/scannerの追加を前提とする。

## Risk LevelとMerge Policy

**Default Risk Levelは2。** ファイル名・拡張子・diff・SBI・AC・Human Gateを使って分類する。

| LEVEL | 必要な実装後Human Approval | autoMergeEligible |
| --- | --- | --- |
| 1 / LOW | 0人 | 必須チェック合格、Human Gateなし、Prototype以外の場合のみtrue |
| 2 / MEDIUM | 1人 | false |
| 3 / HIGH | 異なる2人以上 | false |

LEVEL 1への降格には明示的なsafe ruleが必要。
安全なdocsの追加・更新と、後述の条件を満たす非機密prototypeを候補とする。バイナリ、rename、削除は降格しない。
テストのみ、Storybookのみ、コメントのみ、refactor、feature flag付きという理由だけでは降格しない。
意味上の安全性を機械的に確認できない変更はLEVEL 2に留める。

AuthN/AuthZ/RLS/PII、Migration、schema、権限モデル、本番データ、secret、Security、
CI/CD、deploy、Infrastructure、破壊的操作、ADR、API互換性破壊、データ削除・匿名化・retentionはLEVEL 3。
既定のpath/metadata/contentルールで検出し、SBIのrisksでも宣言する。
未知のコードから意味上の影響を完全推論する仕組みではない。人間が影響をSBIに記録する。
OpenAPI SSOTとHarnessポリシー自体も保護対象とする。

candidateLevelは降格候補、minimumLevelは下限。混在変更は最も高い判定を採用する。
Human Gateなら最低LEVEL 3。AIのLOWで既定LEVEL 2や強制LEVEL 3を下げられない。
AIが追加リスクを検出した場合は引き上げられる。分類根拠・該当パス・判定元を証跡に保存する。

Merge Policy Judgeは別モジュール。Verifier・Policy・Security・Completionと、
有効時のSemantic Reviewを必須条件として、SHAと承認を評価する。
LEVEL 3はMerge Judge側でも最低2人を強制する。Human GateをLOWとして扱う入力も許可しない。
`MERGE_ALLOWED`と`autoMergeEligible`は可否情報だけで、実際のmerge・Auto Mergeは実行しない。
MERGED状態を生成するコードやGitHub merge APIは持たない。

## Human GateとMerge Approvalは別の承認

- 試作採用時の設計承認: designApproval.state = NOT_REQUIRED / WAITING_FOR_DESIGN_APPROVAL / APPROVED / REJECTED
- 実装前: gate.state = NOT_REQUIRED / WAITING_FOR_HUMAN_GATE / APPROVED / REJECTED
- 実装: executionStatus = PENDING / IMPLEMENTING / VERIFYING / REVIEWING / JUDGING / FAILED / DONE / ESCALATED
- 実装後: merge.state = NOT_ASSESSED / RISK_ASSESSING / WAITING_FOR_DESIGN_APPROVAL / WAITING_FOR_HUMAN_GATE / WAITING_FOR_HUMAN_REVIEW / MERGE_ALLOWED / REJECTED / BLOCKED / RETRYABLE

Human Gate未充足ならMerge JudgeもWAITING_FOR_HUMAN_GATEを返す。
Design Approval未充足（未承認・撤回後）ならMerge JudgeはWAITING_FOR_DESIGN_APPROVALを返し、WAITING_FOR_HUMAN_GATEを流用しない。
ゲート対象のSBIはagentを一度も動かさず停止し、人間が着手範囲・設計を確認して承認する。
ゲート承認のpurposeはimplementation-gate。baseline SHAとSBI/設計/Rulesのdigestに紐付ける。

実装後の承認はpurpose=merge。現在HEAD SHAと検証・リスク・入力のdigestに紐付ける。
**ゲート承認はマージ承認人数に一切カウントしない。** AI、重複人物、旧SHA、旧context、
取り消された承認も人数に入れない。修正要求はREJECTEDにする。
新しいcommitや入力変更で失効した承認は再利用しない。

```sh
# ゲート待ちのrunに、人間が着手を承認
pnpm harness:approve --run RUN_ID --phase gate
pnpm harness:resume --run RUN_ID

# 実装DONE後、人間が現在の差分をレビューして承認
pnpm harness:approve --run RUN_ID --phase merge
pnpm harness:resume --run RUN_ID

# 承認の取り消し・修正要求
pnpm harness:approve --run RUN_ID --phase merge --decision revoke
pnpm harness:approve --run RUN_ID --phase merge --decision request-changes
pnpm harness:resume --run RUN_ID
```

`pnpm harness:pr --run RUN_ID`でPRを作ったrun（GitHub PR mode）では、実装後の承認はGitHub Reviewで判定し、`--phase merge`は使わない。
base branchの先頭がrunのbaselineのままであること、tested SHAとPR HEADの一致、必須CIのPASS、CHANGES_REQUESTEDがないことも条件にする。Approveはwrite以上の権限を持つ人のものだけを数える。手順は[.ai/workflows/pull-request.md](.ai/workflows/pull-request.md)。

実装前承認は1人、実装後はRisk別の人数を要求する。承認待ちは連続失敗に数えない。
実装前の仕様曖昧・未決の重要設計はESCALATED。agentが未宣言のHIGH変更を提案した場合も、
適用前に停止してSBI更新と新しいゲートを要求する。
実装・検証・レビューの失敗は既定3回、総iteration上限は5回。
resumeは未着手のゲート待ちと実装DONE後の承認再評価だけに対応し、中断iterationの再開はしない。

### ローカル承認の信頼境界

人間用CLIはOSユーザーを識別子にし、任意の--reviewer名を受け付けない。
承認はworkspace外の署名付き台帳に保存する。agentはJSONレスポンス経由でここへ書けない。
証跡のapprovals.jsonを書き換えても承認にならず、台帳改ざんも署名検証で拒否する。

同じOSアカウントで名前だけ変えて2人に見せる運用はできない。
現行ローカルCLIは単一OSユーザーの識別であり、同じアカウントを共有する実際の人数は認証しない。
LEVEL 3を複数人で承認する本運用には、認証済みの別人を返すidentityProvider/承認adapterが必要。
テストでは信頼する模擬adapterで2人を確認する。ローカルのファイル所有者そのものを敵とする隔離ではない。
`recordDecision`のidentityProviderと、純粋なRisk/Merge Judgeを将来のGitHub等の接続点にする。
署名鍵を含む.harness/state/humanは共有物やリポジトリに含めない。

## Evidence

```text
.harness/runs/<run-id>/
  inputs.json                   # SBI / 設定 / Rules / スキル / tool fingerprint
  summary.json                  # 3つの状態、HEAD、遷移履歴
  human-gate.json
  security-assessment.json      # impacts / rule IDs / Gate / 最低Risk / 必須検証
  security-verification.json    # 必須Security checksのPASS/FAIL/SKIP/NOT_CONFIGURED
  workspace-exclusions.json     # 互換用の空配列。trackedの秘密はcheckout前に停止
  risk-preflight.json           # ゲート対象時
  risk-assessment.json          # preflightかpost-executionかを明記
  changes.json                  # baseline → HEADの差分情報（実装後）
  approvals.json                # 署名付き台帳からの投影。承認の正本ではない
  merge-decision.json
  escalation.json               # 異常停止時。reasonCodeを併記
  health-metrics.json           # Observer用の観測データ。判定には使わない
  workspace/                    # 独立Git、アプリplaceholder、生成成果物
  iteration-N/
    prompt.txt
    agent.log
    verify.log
    security.json
    security-verification.json
    review.json
    semantic-review.json
    result.json
```

未実行のフェーズはNOT_RUNとし、成功結果を捏造しない。ゲート待ちでも初期リスクと承認・マージ未評価を保存する。
Stateは.harness/state/runsにも保存する。resume時には同じrunを再評価する。
実行証跡・ローカル承認はGit管理対象外。

## Health MetricsとHarness Observerの責務分離

各runは`health-metrics.json`（schema `version: 1`）をEvidence配下へ保存する。summary.jsonから派生した
機械集計用の観測データで、run基本情報、iteration、Verifier件数、Security、承認3種、Review、escalationを持つ。
`durationMs`は開始から最終更新までのlifecycle経過時間で、人間の承認待ちを含む。実装・検証・判定だけの
時間は`executionDurationMs`で見る。最初のIMPLEMENTING遷移から最後のexecution phase遷移までを測り、
実装前のGate / Design Approval待ちは含めない。実装に入らず停止したrunではnull。

- Signal Collection（今回）: Harnessが各runのMetricsを保存するところまで。Completion / Risk / Merge Judgeは
  この値を読まない。壊れていても判定は変わらず、次のsaveで再生成する。
- Harness Observer（将来・別コンポーネント）: 複数runのMetricsを横断集計し、改善候補を人間へ提示する。
  Harnessの自動変更・自動Issue作成・自動mergeは行わない。

ESCALATEDはsummary.escalation.codeとescalation.json.codeに機械集計可能なreasonCodeを持つ。
人間向けのreason文はsummary.jsonとescalation.jsonにだけ残し、Metricsにはcodeだけを載せる。
redactionは秘密値をマスクするがメールアドレス等のPIIは除去しないため、自由文をMetricsへ載せない。
Reviewer名・prompt・agent応答・秘密値もMetricsに含めず、他のEvidenceと同じredactionを通す。Gate / Design Approvalの拒否はescalationではなく各approvalのstateで追う。

| code | 発生点 |
| --- | --- |
| SPEC_AMBIGUOUS / DESIGN_DECISION_REQUIRED | SBIの曖昧・設計判断フラグ |
| AGENT_ESCALATION | agentが人間の判断を要求 |
| SECRET_PROPOSAL / NEW_SECURITY_SCOPE / NEW_HIGH_RISK | 適用前の提案内容を拒否 |
| SECURITY_VERIFIER_NOT_CONFIGURED | 必須Security VerifierがNOT_CONFIGURED |
| VERIFIER_NOT_CONFIGURED / CONSECUTIVE_FAILURE | 連続失敗。最終iterationに必須VerifierのNOT_CONFIGUREDがあれば前者 |
| ITERATION_LIMIT | iteration上限 |
| SCOPE_VIOLATION / LANE_ESCALATION | 許可範囲外のpath、prototype範囲の逸脱 |
| SOURCE_CHANGED / WORKSPACE_CHANGED | 元リポジトリ・入力・worktreeの変化 |
| UNKNOWN | 上記に分類できない実行時エラー |

## provider切り替え

```sh
pnpm harness:run --provider fake
pnpm harness:run --provider codex
pnpm harness:run --provider claude
pnpm harness:run --provider fake --sbi .harness/state/sample-sbi.json
```

既定値はharness.jsonのprovider。demoは常にfake。
Codex CLI / Claude Codeはインストール・ログイン済みでPATHから起動できることが必要。
実際のモデル通信を検証済みなのはfakeのみ。実CLIは模擬プロセスでプロトコルを確認している。

Codexは非対話read-onlyと構造化出力、Claudeは組み込み/MCP toolsを無効にして構造化出力を要求する。
CLIの仕様は[Codex公式資料](https://developers.openai.com/codex/cli/reference)、
[Claude Code公式資料](https://code.claude.com/docs/en/cli-reference)を参照。
権限自動拡張、provider自動fallback、agent経由の承認は行わない。

実CLIのユーザー設定・hooksは各CLIに従う。信頼するローカルコードとCLIを動かす基盤であり、
敵対的コードを完全隔離する実行基盤ではない。

## PBI → SBI Planner

GitHub IssueのPBIをBDDベースのSBIへ分割し、レビュー待ちのSBI Issueとして登録する。

```sh
pnpm planner:sbi https://github.com/<owner>/<repo>/issues/<number> --provider claude
```

```text
GitHub Issue (PBI) → PBI Reader → SBI Decomposer（codex / claude）→ SBI Quality Judge
  → PASS: SBI Issue作成 [sbi][needs-review] → 元PBIへ一覧コメント → Human Review → ready
  → FAIL: Issueを作らずexit 1で修正理由を表示
```

GitHubアクセスは認証済みの`gh` CLIを使う。providerはcodexまたはclaudeを明示するか、harness.jsonのproviderを使う。
fakeは公開先がGitHubのため拒否する。`--dry-run`・`--publish`は設けない。
Quality Judgeは決定的なルールで、粒度（受け入れ要件6件・変更範囲4領域以内）、目的が2文以内、受け入れ要件の曖昧語、
Gherkinと受け入れ要件の対応、依存SBIの存在と循環、変更範囲・Risk/Security・検証方法の記載を検査する。
Security Impactを宣言したSBIのRisk candidateはL3。最終Risk判定はExecution Harnessが行う。

生成したSBI Issueの番号・タイトル・URLはCLI stdout、`GITHUB_STEP_SUMMARY`があればJob Summary、元PBIのコメントに表示する。
証跡は`.harness/runs/plan-<id>/`（pbi.json / prompt.txt / candidates.json / quality.json / issues.json / summary.json）。
PBI本文とprompt・証跡はredactionを通す。Issue本文は仕様データとして扱い、本文中の指示には従わない。
provider出力に秘密値らしき文字列があればGitHubへ書き込む前に停止する。
各SBI Issue本文には`<!-- sonomama-sbi pbi=<URL> id=<SBI-ID> digest=<内容のSHA-256> -->`、元PBIコメントにはPBI URLのmarkerを埋める。
再実行時は`sbi`ラベルの既存Issueをmarkerで探し、同じPBI・同じSBI ID・同じdigestに加えて、現在のIssueがopen、`needs-review`付き、
title・本文が今回の生成結果と完全一致する場合だけ再利用し、コメントは更新する。
digest不一致（PBIやモデル出力が変わった）、人間による本文・title編集、`ready`化、closeのいずれかがあれば書き込まずに停止し、人間が判断する。
途中失敗後の再実行で重複Issueを作らない。

Plannerは`needs-review`のSBIをExecution Harnessへ投入しない。人間がレビューして`needs-review`を外し`ready`を付ける。
Execution Harnessは引き続きSBI JSONを入力にし、Issueからの自動実行・`ready`への自動遷移・Risk確定・mergeは行わない。
手順は[.ai/workflows/pbi-sbi-planner.md](.ai/workflows/pbi-sbi-planner.md)。

## API Schema Planner

API変更を伴うIssueから、実装前に合意するOpenAPI 3.1の契約案を作る。Rails / Frontendの実装はしない。

```sh
pnpm planner:api-schema https://github.com/<owner>/<repo>/issues/<number> --provider claude
```

```text
GitHub Issue → 既存OpenAPI（packages/api-schema）→ API Schema Planner（codex / claude）→ API Schema Quality Judge
  → PASS: .harness/api-schema/<number>/{openapi.yaml, proposal.json, summary.md}
          Issueへ [api-schema][needs-api-schema-review] と要約コメント → Human Review → 署名付き承認（digest + commit SHA）
  → FAIL: ファイルもGitHubも書かずexit 1で理由を表示
```

providerはOpenAPIそのものではなく、閉じたJSON（endpoint・component・propertyの配列）を返す。
OpenAPIへの変換、Bearer JWTのsecurityScheme（認証Provider非依存）、共通Error schemaはHarnessが持つ。
Quality Judgeは決定的なルールで構造・認証認可・Security Impact・秘密値・既存endpointとの衝突を検査し、破壊的変更の候補を列挙する。

`modify`で既存の内容が消える場合は、既存OpenAPIとの構造差分から破壊的変更の候補として必ず表示する。

承認は`pnpm planner:api-schema-approve <Issue URL>`で署名付き台帳に記録し、Proposalのdigestとcommit SHAに紐づける。
判定は`pnpm planner:api-schema-status <Issue URL>`。Issueの`api-schema-approved`ラベルは目印で、承認の正本ではない。
Execution Harnessの実装前Gate・Merge Approvalとは別で、どちらの代わりにもならない。承認後に人間がpackages/api-schemaへ反映し、実装SBIを作る。
手順は[.ai/workflows/api-schema.md](.ai/workflows/api-schema.md)。

承認済みOpenAPIのMock Serverは`pnpm api:mock <Issue URL>`で`127.0.0.1:4010`に起動する。承認済みProposalと`packages/api-schema/openapi.yaml`のdigestが一致するときだけ起動する。
手順は[docs/workflows/api-mock.md](docs/workflows/api-mock.md)。

`packages/api-schema/openapi.yaml`は`pnpm api:docs`でSwagger UIに表示できる（`http://127.0.0.1:8080`）。閲覧専用で、Try it outは無効にしてある。
OpenAPIが契約（SSOT）、Swagger UIは契約を見るもの、Prismは契約からMock APIを提供するもの。手順は[docs/workflows/api-docs.md](docs/workflows/api-docs.md)。

## 変更範囲によるVerifier選択

`.harness/config/harness.json`の`appliesTo`は正規表現の配列。実際のbaseline→HEAD差分から選ぶ。
`lanes`でprototype / productionを指定できる。未指定のappliesToは全変更に適用する。
AC指定、SBI.requiredVerifiers、Security RuleのrequiredVerifiers、allowMissing:falseはパス・lane条件より優先する。
必須IDが未登録・未設定ならFAIL / NOT_CONFIGURED。必要なアプリが未生成でも必須検証はSKIPしない。
変更に無関係な任意チェックだけSKIPできる。各iterationのverifier-selection.jsonに選択理由を記録する。
Security Ruleから一般VerifierのIDを要求する場合も同じworktree上で実行し、その実測結果をSecurity証跡に反映する。

`pnpm harness:demo --full` / `pnpm harness:run --full`はlane内の全アプリVerifierを選択する。
このモードでも未生成の任意placeholderはSKIPできる。AC・Security必須チェックは引き続き省略不可。
CIはこのfullモードを使う。アプリ実装・依存環境ができたらcommandsを接続する。

## Prototype Lane / Production Lane

| 場所 | 責務・ゲート |
| --- | --- |
| prototypes/web | React画面試作。ダミーデータで軽量検証 |
| prototypes/mobile | React Native / Expo画面試作。ダミーデータで軽量検証 |
| apps/api・mobile・admin | Production。本番のAC、Application Test、Security検証 |
| packages/**（packages/ui含む） | Production共有資産。試作laneへの降格不可 |

機械設定は`.harness/config/lanes.json`。人物のroleではなく変更パスで決める。
混在・未知のパスはProduction。apps/**とpackages/**は設定でprototypeへ降格できない。
試作専用コンポーネントはprototypes配下に置く。Rails / Expo / React本体は今回も未生成。

通常の試作はtypecheck・lint・format:check・build・secret-scanが必須。
prototypeのpackage.jsonにはこの4スクリプトを用意する。mobileのbuildはExpo exportに接続する。
統合テスト・E2E・Maestro・VRT・本番向けSecurityコマンドは通常は必須にしない。
ただしACの独立検証と軽量の禁止パターン検査は行う。Riskの既定はLEVEL 2。通常の試作はpr-risk.jsonの`explicit_safe_prototype_only`に一致し、
非機密のprototype lane内・通常の追加/変更・許可拡張子・サイズ上限・通常ファイルmodeという条件を満たす場合だけLEVEL 1候補になる。
LEVEL 3の保護ルールやAIによる引き上げは常に優先する。LEVEL 1=0人、LEVEL 2=1人、LEVEL 3=異なる2人以上という承認契約は共通。
PrototypeはLEVEL 1でMERGE_ALLOWEDになってもautoMergeEligibleはfalseで、merge実行はしない。

認証・権限・PII・Secret/Credential・本番データ/API・Cognito User Pool・機密設定への影響は
試作でもProduction/Securityへ昇格し、実装前Human Gate・LEVEL 3・必須Security検証を強制する。
SBI.securityImpactで宣言し、既知の接続先はsecurityPatternsにも追加する。静的検出だけで全ての業務影響は推定できない。
packagesへの変更を含むSBIも常にProduction。本番共有packageの検証を試作profileで省略できない。

試作を本番へ移す場合は、新しいProduction SBIに`promotion: {"source":"prototypes/web"}`を設定する。
Design Approval待ちで実装を止め、`pnpm harness:approve --run RUN_ID --phase design`で人間が承認してからresumeする。
Design Approvalは`design-approval`という独立した署名済みstate。待機状態は`WAITING_FOR_DESIGN_APPROVAL`。
実装前Human Gateが不要なら、Design Approvalの待機・承認・拒否・撤回の間もgate.stateは`NOT_REQUIRED`を保つ。
証跡はdesign-approval.jsonとhuman-gate.jsonで分離する。SBIやSHAを変えたら取り直す。
その後apps配下で本番実装→Production検証→実装後のMerge Approval→MERGE_ALLOWED。
Design Approvalは実装前Human GateやMerge Approvalの代わりにはならない。
既存の本番SBI全てに試作を強制するものではない。試作の採用時にpromotionを宣言する。

## Git worktreeの保持と片付け

runのHEADを`refs/harness/runs/<run-id>`で保持するので、レビュー・将来のPR Adapterも同じSHAを参照できる。
元リポジトリのHEADが進んだ場合、dirty workspace、検証ソースの変更、入力の変更があれば承認を再利用しない。
現在のLocal Phaseではresume・merge可否の再判定もroot HEAD==baselineを要求する。
別PRをpullしただけでも既存runは無効になるため、新しいHEADでrunと承認を作り直す。
並行run / Factory向けのbase追跡は今後の拡張とする。
証跡・承認台帳・秘密値・node_modulesはiteration commitに含めない。

```sh
pnpm harness:cleanup --run RUN_ID
```

cleanで所有関係を確認できたworktreeだけを削除する。証跡・run参照は保持し、cleanup後は再開・merge可否の再利用を止める。
変更のあるworktreeを強制削除しない。履歴の自動削除・GC・mergeは行わない。
現在はsource全体の変更検出を厳格に行う。アプリ接続時はbuild/exportの生成物をsource外に出すなど、
検証中にsourceが変わらない実行方法を整える。node_modulesの依存内容はfingerprint対象外なので、lockfile固定で準備する。

## pre-push / CI

Nodeは`.node-version`、pnpmはpackage.jsonのpackageManagerに固定。`pnpm install --frozen-lockfile`後のprepareで
version管理された`.githooks/pre-push`を設定する。必要なら`pnpm hooks:install`で再設定できる。
push前にharness:check→harness:testを実行し、失敗するとpushを止める。

GitHub ActionsはPRとmainへのpushでfrozen install→harness:check→harness:test→harness:demo --fullを実行する。
いずれかの失敗でworkflowも失敗する。Actionsはcommit SHA固定、読取専用権限、checkout認証情報を保存しない。
ローカルhookは回避可能なので、チーム運用ではRuleset / branch protectionで成功チェックを必須にする。
これは次の設定段階。hook・CI・Harnessのどれにもmerge機能はない。
