# 実装ワークフロー（ローカルHarness）

## run の流れ

1. SBIにGherkin、AC、許可ファイル、riskを記載する。ACを信頼するVerifier Registryへ対応付ける。
2. pnpm harness:checkで検証する。
3. pnpm harness:demoまたはpnpm harness:runを実行する。
4. WAITING_FOR_HUMAN_GATEなら、人間が設計・作業範囲を確認し、approve --phase gateを実行する。
   WAITING_FOR_DESIGN_APPROVALなら、試作採用の設計を確認し、approve --phase designを実行する。
5. resume --run IDで着手する。失敗は修正→再検証。連続3回失敗などはESCALATED。
6. executionStatus=DONE後、risk-assessmentとHEADの差分を人間が確認する。
7. GitHubで共有するなら`harness:pr --run ID`でPRを作り、GitHub Reviewで承認する（[pull-request.md](pull-request.md)）。
   PRを作らないLocal modeでは、LEVEL 2は1人、LEVEL 3は異なる2人以上がapprove --phase mergeで承認する。
8. resume --run IDで再評価し、MERGE_ALLOWEDとautoMergeEligibleを確認する。
   merge判定の一時エラーはRETRYABLE（executionStatusはDONEのまま）。原因を解消してresumeし直す。
9. 実際のmergeは人間または別の将来adapterが行う。このHarnessはmergeしない。

ゲート承認とマージ承認は別purpose・別context。使い回せない。
証跡approvals.jsonを編集しても承認にならない。人間用CLIの署名付き台帳を使う。
OSユーザーの別名は別人として数えない。複数人の本運用には認証済み承認adapterを接続する。

SHA・source・SBI・Rules・検証コードが変わったら新規runで再検証・再承認する。
途中iterationはresumeしない。承認待ちだけを再開・再評価する。
承認撤回後もresumeでMERGE_ALLOWEDを取り消せる。
PBI → SBI Plannerは[pbi-sbi-planner.md](pbi-sbi-planner.md)。API変更を伴うSBIは実装前に[api-schema.md](api-schema.md)でAPI契約を承認する。Ruleset・CODEOWNERSの設定と実mergeは対象外。

## ローカル開発とPR品質ゲート

1. Nodeは.node-version、pnpmはpackageManagerの版を使う。
2. pnpm install --frozen-lockfileで依存とpre-push hookを準備する。再設定はpnpm hooks:install。
3. BDDテストを先に書き、失敗確認・テストcommit後に実装する。
4. harness:checkとharness:testの成功後、cleanなcommitからharness:demo --fullを実行する。
5. push時にcheckと、差分に応じたVerifier（Full Gate対象ならtest全件）が自動実行される。CIはSBIと差分から必要なVerifierだけを並列実行する（[ci.md](ci.md)）。
6. 元リポジトリのHEADを変える前にrunをレビューする。変更後は承認を再利用せず、新規runで再検証する。
7. 人間が最終mergeする。現在はMERGE_ALLOWED判定まで。Rulesetの必須チェック指定は別途設定する。

Application Testは許可scopeで修正可能。Trusted Acceptanceは.harness/verificationまたはtools/harnessで保護する。
Verifierは差分のappliesToとlaneで選び、AC・Security・明示必須指定を優先する。任意の非該当だけSKIPできる。

Prototypeはprototypes/web・mobileのダミーデータ画面で、typecheck/lint/format/build/secret検査。
Productionはapps・packages。試作から本番へ採用するときは新しいProduction SBIにpromotion.sourceを指定し、
独立したDesign Approvalを得てからapps実装、本番検証、Merge Approvalへ進む。Security影響はlaneより常に優先。
詳しい設定例と承認・cleanup手順はルートのREADMEに記載する。

## SBIとacceptance verifier

SBIの項目は人間向けのdocs/product/sbi-template.md、実行用JSONの例は.harness/state/sample-sbi.json。
acceptance verifierは、組み込みのsample-bddと、harness.jsonで`trust: acceptance`と`trustedScript`（.harness/verification/*.mjs）を指定したもの。
別のSBIを実行する前に、信頼する検証adapterとACの対応を追加する。
SBIのSecurity metadata（securityImpact・requiredSecurityRules・requiredVerifiers・preImplementationGate・minimumRiskLevel）は強制ルールを弱められない（[security-rules.md](../security-rules.md)）。
