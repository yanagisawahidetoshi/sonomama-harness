# Security rules

人間向けの要件はdocs/security。機械可読ルールは.harness/rules/security.json・human-gates.json・pr-risk.json。
ここには、AIが実装・レビュー時に守る制約だけを置く。

## Security Enforcement

- Security RequirementsのSSOTはdocs/security・docs/product・ADR。Harness内で業務権限・PII定義・retention期間・匿名化要件を決めない。未決事項をAIが推測して確定しない。
- Security rule IDを文書・security.json・human-gates.jsonで対応させる。harness:checkはIDと文書参照の整合性だけを検証し、意味の妥当性は人間がレビューする。
- Security-sensitiveは必須Verifierを強制する。matched ruleが要求する検証は、SBI側で省略しても強制される。
- 最低LEVELと承認人数はrule単位。`preImplementationGate: true`のrule（AuthN / AuthZ / RLS / PII / Secret / RolePermission / Infrastructure / 破壊的操作 / DataLifecycle / PIILogging）は最低LEVEL 3と実装後の異なる2人以上のReviewを強制する。Migration / DBSchema / CICDSecurity / SecurityConfig / SecurityDesignは最低LEVEL 2・1人承認。
- Security影響の判断はSBI承認で人間が行う（#175）。承認済みSBIに対して実装前Gateは置かない。security.jsonの`preImplementationGate: true`とhuman-gates.jsonの`preImplementationRuleIds`は「SBI承認で人間が判断し、LEVEL 3・2人のReviewを要するrule」を示す（Rule IDの対応を保つため名前は変えない）。承認済みSBIが宣言していないruleへの一致は、実装前にNEEDS_HUMAN_DECISIONで止める。
- secret-scanとforbidden-pattern-checkはalwaysRequiredVerifiersで、Risk Levelに関係なく全変更で走る。ここを条件実行にしない。
- security.jsonでappliesToを持つ実装Verifier（rails-authz-test等）は、ルールに一致したファイルがappliesToに入るとき、またはSBIがそのルールを宣言したときだけ必須にする。docs・ADRだけの変更でも、そのruleの最低LEVEL・承認人数は変わらない。
- required Security VerifierのFAIL/SKIP/NOT_CONFIGURED、rule violationではDONEもMERGE_ALLOWEDも禁止。NOT_CONFIGUREDはFAIL/SKIPと区別し、必須なら停止する。
- AI Review（Semantic Review）や承認人数だけで検証失敗を上書きしない。
- 破壊的Migrationは、expand/contractのcontract段階で`apps/api/db/migrate/exceptions/<version>.json`を置き、2人の承認Review（COMMENTED。Approveはmerge承認なので数えない）が揃ったときだけ通る（docs/workflows/database-migrations.md）。mainへのmergeを本番反映とみなさない。AIは承認Reviewを投稿しない。
- 新しいSecurity影響と秘密値の提案は、workspaceへ適用する前に止める。新しいSecurity影響はNEEDS_HUMAN_DECISION（SBI更新・再承認後に新しいrun）、秘密値はGateではなく安全策として止める。
- 秘密ファイルはworktree・export・Gitから除外する。trackedで検出した場合はcheckout前に停止する。実値をログや会話へ出さない。
- ログ・prompt・JSON・例外はredactionを通す。workspace・prompt・ログ・レビューZIPの秘密情報保護はevidence-protection.mjsを経由する。レビューZIPはharness:exportで再検査して生成する。
- 外部CLIの生レスポンスをrun配下へ直接書かせない。
- .env.*の保護は維持する。trackedのexample/sample/templateだけ、秘密値がないことを内容検査してworktreeへ取り込む。Agentの書込許可やexport許可には転用しない。

## Verifier isolation

- 実行境界は3つ。trusted Harness（ホスト、Credential・承認鍵・証跡を扱う）、trusted acceptance（ホストのNode permission model、読み取りはworkspaceとHarnessのnode_modulesだけ・環境変数なし）、untrusted application（verifier・security verifierのコマンド。Dockerコンテナ）。詳細はdocs/security/threat-model.md。
- untrusted applicationをホストで実行しない。Dockerが使えない、image・コンテナを用意できないときはFAIL（isolation unavailable）にし、PASS・SKIP・NOT_CONFIGUREDにしない。
- コンテナにはworkspaceだけをmountする。HOME・Docker socket・`.harness/state/**`・run証跡・`.git`・秘密ファイルを見せない。環境変数はallowlistだけ。非rootで動かす。CHOWN・DAC_READ_SEARCHはvolume準備のroot execだけが使い、検証コマンドのユーザーはcapabilityを持たない。
- networkは既定で無効。必要なverifierだけharness.jsonで`network: true`を宣言する。
- Composeのverifierはtrusted HarnessがCompose fileを検査してから起動する。workspaceから`build`するサービスは、Harnessのoverrideでホストのuid:gid（non-root）として動かす。Compose fileの`user`では変えられない。`isolation: harness`はtools/harnessのスクリプトだけに使う。

## Risk / Human Approval

- Default Risk Levelは1。ルールは水準を上げるだけで、下げる仕組みは持たない。通常のUI / API / test / refactor / docsはLEVEL 1。
- LEVEL 2は通常のMigration・schema・OpenAPI・CI / GitHub Actions・Dockerfile・ADR・Harness実装。LEVEL 3は重大な影響に限る（AuthN / AuthZ / RLS / PII、権限モデル、Secret / Credential、docs/security、本番Infrastructure / Deployment、破壊的・不可逆なデータ / schema操作、`.harness/rules/`・`.harness/state/`・`.github/rulesets/`・`.githooks/`）。
- ポリシー自身（`.harness/rules/`等）はLEVEL 3のまま据え置く。自分の承認要件を下げたPRが、その緩めたルールで自分をmergeする経路を作らない。
- 最低ルールとHuman Gate riskは常に優先する。AIはRiskを下げられない。
- 変更内容、検証対象、レビュー対象、SHAは同じrun workspaceに固定する。
- 実装開始の人間判断はSBI承認だけ（#175）。実装前gate（implementation-gate）は記録しない。merge approvalはSBI承認と別のpurpose・contextで管理する。
- AI Review（Semantic Review）は全LEVELで必須。PASSしなければMERGE_ALLOWEDにもautoMergeEligibleにもしない。adapter未接続はNOT_CONFIGURED、実行失敗・不明な結果はFAIL。fake adapterはfake provider（demo・test）だけが使い、PRでは数えない。
- 承認は信頼するidentity adapter経由だけ。agentのJSONや証跡ファイルを承認の正本にしない。
- LEVEL 2は1人、LEVEL 3は異なる2人以上。重複、AI、旧SHA、撤回済みの承認は無効。
- 必須チェックはすべてPASS。任意の非該当チェックと未生成placeholderだけSKIP可能。
- 出力はMERGE_ALLOWEDとautoMergeEligible。LEVEL 1でautoMergeEligibleがtrue（必須CI・Verifier・Security・AI ReviewがtestedSHAでPASS）のときだけ自動mergeしてよい。LEVEL 2・3は人間がmergeする。
- 承認待ちのresumeと実装の再試行は分離し、Plannerより実行・判定の整合性を優先する。
- laneだけで承認数を減らさない。prototypeもLEVEL 1なら他と同じ条件で自動mergeしてよい。

## Lane

- VerifierのappliesToとlaneで変更範囲を選ぶ。AC・Security・明示必須指定はlane/pathより優先し、必須検証をSKIPしない。
- prototypes/web、prototypes/mobileは軽量ゲート。apps/**とpackages/**は常にProduction。認証・PII・本番API等への影響はSecurity Gateへ昇格する。
- 試作でも本番データ・本番API・Cognito User Poolに影響するなら、SBI.securityImpactにProductionData / ProductionAPI / CognitoUserPoolを宣言する（SEC-DESTRUCTIVE-001）。本番環境の接続先に応じて.harness/config/lanes.jsonのsecurityPatternsを拡張する。
- 試作の本番移行は新しいProduction SBIで行い、本番検証を省略しない。実装の承認はSBI Issueのレビューと`ready`で、別のDesign Approval Gateは無い。

## run workspace

- runは元のHEADからdetached Git worktreeで実行する。元リポジトリはcleanで開始し、証跡と承認台帳をrunのGit履歴に入れない。
- cleanupはcleanなworktreeだけを削除し、証跡とrefs/harness/runs/<run-id>を保持する。force/remove/resetは使わない。
