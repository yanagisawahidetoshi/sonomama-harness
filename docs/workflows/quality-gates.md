# ローカル開発とPR品質ゲート

1. Nodeは.node-version、pnpmはpackageManagerの版を使う。
2. pnpm install --frozen-lockfileで依存とpre-push hookを準備する。再設定はpnpm hooks:install。
3. BDDテストを先に書き、失敗確認・テストcommit後に実装する。
4. harness:checkとharness:testの成功後、cleanなcommitからharness:demo --fullを実行する。
5. push時にもcheck/testが自動実行される。PRとmainのCIでinstall/check/test/demoを再確認する。
6. 元リポジトリのHEADを変える前にrunをレビューする。変更後は承認を再利用せず、新規runで再検証する。
7. 人間が最終mergeする。現在はMERGE_ALLOWED判定まで。Rulesetの必須チェック指定は別途設定する。

Application Testは許可scopeで修正可能。Trusted Acceptanceは.harness/verificationまたはtools/harnessで保護する。
Verifierは差分のappliesToとlaneで選び、AC・Security・明示必須指定を優先する。任意の非該当だけSKIPできる。

Prototypeはprototypes/web・mobileのダミーデータ画面で、typecheck/lint/format/build/secret検査。
Productionはapps・packages。試作から本番へ採用するときは新しいProduction SBIにpromotion.sourceを指定し、
独立したDesign Approvalを得てからapps実装、本番検証、Merge Approvalへ進む。Security影響はlaneより常に優先。
詳しい設定例と承認・cleanup手順はREADMEに記載する。
