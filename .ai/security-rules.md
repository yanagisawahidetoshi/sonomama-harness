# Security rules

人間向けの要件はdocs/security。機械可読ルールは.harness/rules/security.json・human-gates.json・pr-risk.json。
ここには、AIが実装・レビュー時に守る制約だけを置く。

## Security Enforcement

- Security RequirementsのSSOTはdocs/security・docs/product・ADR。Harness内で業務権限・PII定義・retention期間・匿名化要件を決めない。未決事項をAIが推測して確定しない。
- Security rule IDを文書・security.json・human-gates.jsonで対応させる。harness:checkはIDと文書参照の整合性だけを検証し、意味の妥当性は人間がレビューする。
- Security-sensitiveは事前Gate、最低LEVEL 3、必須Verifierを強制する。matched ruleが要求する検証は、SBI側で省略しても強制される。
- required Security VerifierのFAIL/SKIP/NOT_CONFIGURED、rule violation、未承認GateではDONEもMERGE_ALLOWEDも禁止。NOT_CONFIGUREDはFAIL/SKIPと区別し、必須なら停止する。
- Semantic Reviewや承認人数だけで検証失敗を上書きしない。
- 新しいSecurity影響と秘密値の提案は、workspaceへ適用する前に止める。
- 秘密ファイルはworktree・export・Gitから除外する。trackedで検出した場合はcheckout前に停止する。実値をログや会話へ出さない。
- ログ・prompt・JSON・例外はredactionを通す。workspace・prompt・ログ・レビューZIPの秘密情報保護はevidence-protection.mjsを経由する。レビューZIPはharness:exportで再検査して生成する。
- 外部CLIの生レスポンスをrun配下へ直接書かせない。
- .env.*の保護は維持する。trackedのexample/sample/templateだけ、秘密値がないことを内容検査してworktreeへ取り込む。Agentの書込許可やexport許可には転用しない。

## Verifier isolation

- 実行境界は3つ。trusted Harness（ホスト、Credential・承認鍵・証跡を扱う）、trusted acceptance（ホストのNode permission model、workspace読み取りのみ・環境変数なし）、untrusted application（verifier・security verifierのコマンド。Dockerコンテナ）。詳細はdocs/security/threat-model.md。
- untrusted applicationをホストで実行しない。Dockerが使えない、image・コンテナを用意できないときはFAIL（isolation unavailable）にし、PASS・SKIP・NOT_CONFIGUREDにしない。
- コンテナにはworkspaceだけをmountする。HOME・Docker socket・`.harness/state/**`・run証跡・`.git`・秘密ファイルを見せない。環境変数はallowlistだけ。非rootで動かす。CHOWNはvolume準備のroot execだけが使い、検証コマンドのユーザーはcapabilityを持たない。
- networkは既定で無効。必要なverifierだけharness.jsonで`network: true`を宣言する。
- Composeのverifierはtrusted HarnessがCompose fileを検査してから起動する。`isolation: harness`はtools/harnessのスクリプトだけに使う。

## Risk / Human Approval

- Default Risk Levelは2。明示的なsafe ruleのみLEVEL 1への降格を許可する。
- LEVEL 3の最低ルール、Human Gateは常に優先する。AIはRiskを下げられない。
- 変更内容、検証対象、レビュー対象、SHAは同じrun workspaceに固定する。
- 実装前gateと実装後merge approvalは別state・別purpose・別contextで管理する。
- 承認は信頼するidentity adapter経由だけ。agentのJSONや証跡ファイルを承認の正本にしない。
- LEVEL 2は1人、LEVEL 3は異なる2人以上。重複、AI、旧SHA、撤回済みの承認は無効。
- 必須チェックはすべてPASS。任意の非該当チェックと未生成placeholderだけSKIP可能。
- 出力はMERGE_ALLOWEDとautoMergeEligibleまで。実mergeとMERGED遷移は実装しない。
- 承認待ちのresumeと実装の再試行は分離し、Plannerより実行・判定の整合性を優先する。
- 通常prototypeのLEVEL 1候補はpr-risk.jsonの明示的safe ruleで定義する。laneだけで承認数を減らさない。prototypeのautoMergeEligibleは常にfalse。
- Design Approvalの待機はWAITING_FOR_DESIGN_APPROVALとして別phaseに記録する。Implementation Gateのstateを表示目的で流用しない。

## Lane

- VerifierのappliesToとlaneで変更範囲を選ぶ。AC・Security・明示必須指定はlane/pathより優先し、必須検証をSKIPしない。
- prototypes/web、prototypes/mobileは軽量ゲート。apps/**とpackages/**は常にProduction。認証・PII・本番API等への影響はSecurity Gateへ昇格する。
- 試作でも本番データ・本番API・Cognito User Poolに影響するなら、SBI.securityImpactにProductionData / ProductionAPI / CognitoUserPoolを宣言する（SEC-DESTRUCTIVE-001）。本番環境の接続先に応じて.harness/config/lanes.jsonのsecurityPatternsを拡張する。
- 試作の本番移行は新しいProduction SBIと実装前Design Approvalを必要とし、本番検証を省略しない。

## run workspace

- runは元のHEADからdetached Git worktreeで実行する。元リポジトリはcleanで開始し、証跡と承認台帳をrunのGit履歴に入れない。
- cleanupはcleanなworktreeだけを削除し、証跡とrefs/harness/runs/<run-id>を保持する。force/remove/resetは使わない。
