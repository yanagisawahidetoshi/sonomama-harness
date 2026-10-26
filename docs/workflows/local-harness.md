# ローカルHarnessの運用

1. SBIにGherkin、AC、許可ファイル、riskを記載する。ACを信頼するVerifier Registryへ対応付ける。
2. pnpm harness:checkで検証する。
3. pnpm harness:demoまたはpnpm harness:runを実行する。
4. WAITING_FOR_HUMAN_GATEなら、人間が設計・作業範囲を確認し、approve --phase gateを実行する。
   WAITING_FOR_DESIGN_APPROVALなら、試作採用の設計を確認し、approve --phase designを実行する。
5. resume --run IDで着手する。失敗は修正→再検証。連続3回失敗などはESCALATED。
6. executionStatus=DONE後、risk-assessmentとHEADの差分を人間が確認する。
7. LEVEL 2は1人、LEVEL 3は異なる2人以上がapprove --phase mergeで承認する。
8. resume --run IDで再評価し、MERGE_ALLOWEDとautoMergeEligibleを確認する。
9. 実際のmergeは人間または別の将来adapterが行う。このHarnessはmergeしない。

ゲート承認とマージ承認は別purpose・別context。使い回せない。
証跡approvals.jsonを編集しても承認にならない。人間用CLIの署名付き台帳を使う。
OSユーザーの別名は別人として数えない。複数人の本運用には認証済み承認adapterを接続する。

SHA・source・SBI・Rules・検証コードが変わったら新規runで再検証・再承認する。
途中iterationはresumeしない。承認待ちだけを再開・再評価する。
承認撤回後もresumeでMERGE_ALLOWEDを取り消せる。
Planner、GitHub PR、Ruleset、CODEOWNERS、実mergeは今回の対象外。
