# 実装ワークフロー（ローカルHarness）

## run の流れ

1. 通常は`pnpm planner:sbi <PBI URL>`で作ったSBI Issueをレビューし、ACごとのTrusted Acceptanceを`.harness/acceptance/sbi-<番号>.json`に登録して`ready`にする（[pbi-sbi-planner.md](pbi-sbi-planner.md)）。SBI JSONは書かない。
   新方式では`ready`の代わりに`pnpm harness:spec-approve`で仕様を承認する。runがIssueの仕様からRailsのrequest specを生成し、品質検査と検出（G）を通ったものだけを登録してから実装する。実装後は同じspecが全てPASSすることを確かめる（I）。
   Gは実装前のREDを求めない。Scenarioごとに、実装前にexpectationの失敗でFAILすればそれを証拠にし、実装前からPASSするScenarioには生成AIが提案したcontrolled violation（`apps/api/app/**`の既存ファイルだけ、2ファイル・20行まで）を使い捨てのコピーに当て、そのScenarioのexpectationがFAILすることを確かめる。load・構文・DB・timeoutなどの失敗は検出に数えない。
   違反を入れてもPASSする（`DETECTION_FAILED`）・判定できない（`DETECTION_UNDETERMINABLE`）ときは同じ承認済み仕様からテストを作り直し、`maxConsecutiveFailures`回続いたら止める。RSpecの結果が出ない環境の失敗は回数に数えず`ACCEPTANCE_RUN_FAILED`で止める。生成テストとcontrolled violationの実行は、ADR-0005どおりsecretなしで、外部へ出られないCompose network（`internal: true`。Rails ↔ DBなどCompose内の通信だけ通る）で行う。依存のインストールはimageのbuild時だけ。証跡`acceptance-detection.json`には各回のテストdigest・違反patchのdigest・結果だけを残し、patch本文は残さない。
2. pnpm harness:checkで検証する。
3. `pnpm harness:run <SBI Issue URL>`を実行する。IssueからSBIを組み立て、Run開始時のsnapshotを保存する。デモは`pnpm harness:demo`（サンプルSBI）。
4. WAITING_FOR_HUMAN_GATEなら、人間が設計・作業範囲を確認し、`pnpm harness:approve <SBI Issue URL> --phase gate`を実行する。
5. approveの記録後、Harnessがrunを自動で再開する（`harness:resume`は不要）。失敗は修正→再検証。連続3回失敗などはESCALATED。
6. executionStatus=DONEになると、Harnessがtested SHAでPRを作る（fake providerを除く）。GitHub Reviewで承認する（[pull-request.md](pull-request.md)）。
   PRを作らないLocal modeでは、LEVEL 2は1人、LEVEL 3は異なる2人以上がapprove --phase mergeで承認する。
7. 判定の更新が要るときだけ、保守用のresume --run IDでMERGE_ALLOWEDとautoMergeEligibleを確認する。
   merge判定の一時エラーはRETRYABLE（executionStatusはDONEのまま）。原因を解消してresumeし直す。
8. レビュー待ちの間にmainが進んだら、最新のmainをpullして`pnpm harness:reverify <PR URL>`を実行する。実装を保持したまま再検証し、同じPRを更新する（[pull-request.md](pull-request.md)）。
9. 実際のmergeは人間が行う。このHarnessはmergeしない。

ゲート承認とマージ承認は別purpose・別context。使い回せない。
証跡approvals.jsonを編集しても承認にならない。人間用CLIの署名付き台帳を使う。
OSユーザーの別名は別人として数えない。複数人の本運用には認証済み承認adapterを接続する。

SHA・source・SBI・Rules・検証コードが変わったら新規runで再検証・再承認する。
途中iterationはresumeしない。承認待ちだけを再開・再評価する。
承認撤回後もresumeでMERGE_ALLOWEDを取り消せる。
PBI → SBI Plannerは[pbi-sbi-planner.md](pbi-sbi-planner.md)。API変更を伴うSBIは実装前に[api-schema.md](api-schema.md)でAPI契約を承認する。Harnessは実mergeを行わず、GitHubのRuleset・CODEOWNERSも変更しない（mainのRulesetは人が適用済み）。

## ローカル開発とPR品質ゲート

1. Nodeは.node-version、pnpmはpackageManagerの版を使う。
2. pnpm install --frozen-lockfileで依存とpre-push hookを準備する。再設定はpnpm hooks:install。
3. BDDテストを先に書き、失敗確認・テストcommit後に実装する。
4. harness:checkとharness:testの成功後、cleanなcommitからharness:demo --fullを実行する。
5. push時にcheckと、差分に応じたVerifier（Full Gate対象ならtest全件）が自動実行される。CIはSBIと差分から必要なVerifierだけを並列実行する（[ci.md](ci.md)）。
6. 元リポジトリのHEADを変える前にrunをレビューする。変更後は承認を再利用せず、新規runで再検証する。
7. 人間が最終mergeする。HarnessはMERGE_ALLOWED判定まで。mainのRulesetは適用済みで、PR経由と`harness`の成功を必須にしている（[github-ruleset.md](../../docs/workflows/github-ruleset.md)）。

Application Testは許可scopeで修正可能。Trusted Acceptanceは.harness/verificationまたはtools/harnessで保護する。
Verifierは差分のappliesToとlaneで選び、AC・Security・明示必須指定を優先する。任意の非該当だけSKIPできる。

Prototypeはprototypes/web・mobileのダミーデータ画面で、typecheck/lint/format/build/secret検査。
Productionはapps・packages。試作から本番へ採用するときは新しいProduction SBIにpromotion.sourceを指定し、
通常のSBIと同じくapps実装、本番検証、Merge Approvalへ進む（Design Approval Gateは無い）。Security影響はlaneより常に優先。
詳しい設定例と承認・cleanup手順はルートのREADMEに記載する。

## SBIとacceptance verifier

SBIの項目は人間向けのdocs/product/sbi-template.md、実行用JSONの例は.harness/state/sample-sbi.json。
acceptance verifierは、組み込みのsample-bddと、harness.jsonで`trust: acceptance`と`trustedScript`（.harness/verification/*.mjs）を指定したもの、SBI Issueごとの`.harness/acceptance/sbi-<番号>.json`に登録したもの。
別のSBIを実行する前に、信頼する検証adapterとACの対応を追加する。
SBIのSecurity metadata（securityImpact・requiredSecurityRules・requiredVerifiers・preImplementationGate・minimumRiskLevel）は強制ルールを弱められない（[security-rules.md](../security-rules.md)）。
