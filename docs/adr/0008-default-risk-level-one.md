# ADR-0008: 通常の変更の既定Risk LevelをLEVEL 1にし、LEVEL 3を重大リスクに限る

- 状態: Proposed
- 日付: 2026-10-31
- 判断者: 未決定
- 関連Issue: #157
- 関連SBI: なし（Harness本体の変更）
- 関連Design Docs: [docs/security/README.md](../security/README.md)、[docs/security/threat-model.md](../security/threat-model.md)
- Supersedes: なし
- Superseded by: なし

状態の意味とAIの扱いは[README](README.md)を参照する。Proposedの間は、AIはこのADRを決まったものとして実装や提案の根拠にしない。

## 背景

人間のタッチポイントは「PBIを作る」「SBIをレビュー・承認する」「本当に危険なPRをレビューする」の3つに絞りたい。
実装前Gateの廃止は#155・#175で扱ったが、Risk Policy自体は次の状態だった。

- `pr-risk.json`の`defaultLevel`が2。LEVEL 1へ降りるには明示的な`safeRules`（docs-onlyと非機密prototype）への一致が必要で、通常のUI変更やAPI実装は必ず人1人のレビュー待ちになる。
- `security.json`の15ルールすべてが`preImplementationGate: true` / `minimumRiskLevel: 3` / `requiredHumanApprovals: 2`。1つ当たれば実装前Gateと異なる2人の承認になる。
- SEC-CONFIG-001のpathPatternに`(^|/)config(/|$)`が入っており、`apps/api/config/routes.rb`のような通常の設定変更まで security-sensitive → LEVEL 3になる（リポジトリ内で21ファイルが該当）。
- `policy.json`の`protectedPathPatterns`に`migrate|migrations`と`docs/adr`が入っており、SBIの変更範囲にmigrationやADRが含まれるだけでHuman Gateになる。

結果として、人間の判断と重い検証の範囲が、意図した「本当に危険な変更」より大きく広がっていた。

## 判断ドライバー

1. 人間の判断回数を減らすこと。検証回数を減らすことではない。
2. 既存のSecret検知・Trusted Acceptance・必須CI・改ざん防止を弱めないこと。
3. 自己弱体化（PRが自分の承認要件を下げ、その緩めたルールで自分をmergeする）を塞ぐこと。
4. 判定が決定的で、根拠が証跡に残ること。

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| `defaultLevel`を2のままにし、`safeRules`を増やして通常変更をLEVEL 1候補にする | 「安全なものを列挙する」方式では通常変更の全パターンを列挙しきれず、増やすほどルールが壊れやすくなる。Issue #157は既定そのものを下げると決めている |
| ファイル種別だけでLEVEL 3を決める今の方式を維持し、対象パスを狭める | 通常のMigrationとDROP TABLEを区別できない。Issue #157が「ファイル種別だけで機械的に決めない」と明示している |
| Harness本体（`.harness/`・`tools/harness/`）も一律LEVEL 2にする | `.harness/rules/`は承認人数と自動mergeの条件そのものを決める。ここを1人レビューにすると、自分の要件を下げたPRがその要件で通る経路ができる |
| `secret-scan`・`forbidden-pattern-check`も条件実行にする | 秘密が入っているかは検査しないと分からないので、変更内容を見てから実行を決める順序が成立しない。#157のAC「既存のSecret検知を弱めない」にも反する |

## 決定

未決定（Proposed）。現時点の提案は次のとおり。

1. `defaultLevel`を1にする。ルールは下限（floor）を与えるだけで、水準を下げる仕組み（`safeRules`）は持たない。
2. LEVEL 3は重大リスクに限る。認証・認可・RLS・PII、権限モデル、Secret / Credential、`docs/security`、本番Infrastructure / Deployment、本番データの破壊・不可逆操作、`ALTER|CREATE|DROP POLICY|ROLE`、そしてポリシー自身（`.harness/rules/`・`.harness/state/`・`.github/rulesets/`・`.githooks/`）。
3. 通常のMigration・schema・OpenAPI / API Schema・CI / GitHub Actions・Dockerfile・ADR・Harness実装はLEVEL 2（人1人）。破壊的・不可逆な操作を変更内容から検知したときだけLEVEL 3へ上げる。
4. Security ruleのGateと最低LEVELをrule単位にする。SEC-MIGRATION-001・SEC-SCHEMA-001・SEC-CICD-001・SEC-CONFIG-001・SEC-DESIGN-001は`preImplementationGate: false` / 最低LEVEL 2 / 承認1人。残る10ルールは従来どおりGate・LEVEL 3・2人。
5. SEC-CONFIG-001のpathPatternから`(^|/)config(/|$)`を外し、セキュリティに関わる設定ファイル（`database.yml`、`credentials*`、`bundler-audit.yml`、`environments/production.rb`、`initializers/{cors,content_security_policy,permissions_policy,session_store,filter_parameter_logging}.rb`）だけに限定する。
6. `policy.json`のHuman Gate categoryをAuthN / AuthZ / RLS / PIIの4つにし、`protectedPathPatterns`からmigrationとADRを外す。
7. SBIは`riskCandidate`（L1 / L2 / L3）で自分の下限を宣言できるようにする。既定はL1、`securityImpact`があればL3。

## 理由

「人間のタッチポイントを減らす」は「検証を減らす」ではない。必須CI・Application Test・Trusted Acceptance・Security検査はLEVEL 1でもそのまま走る。
人が見る回数を減らしたぶんは、決定的な機械判定が引き受ける。

通常のMigrationをLEVEL 2に落とせるのは、破壊的migrationに対する防御がRisk Levelとは独立に存在するため。
`migration-safety` verifierが`drop_table`・`remove_column`・`execute`等を静的に検知してFAILにし、通すにはexpand/contractの申請ファイルと**異なる2人のComment Review**が必要で、CIのCompletion Judgeがheadとdigestの一致を確かめる。
Risk Levelを下げても、この経路は変わらない。

ポリシー自身をLEVEL 3に据え置くのは、Issue #157の「Harness変更は変更しただけで一律L3にしない」と矛盾しない。
`tools/harness/`の実装はLEVEL 2に落とし、承認人数と自動mergeの条件を決める`.harness/rules/`だけを別格にしている。

## 影響

### Positive

- 通常のUI変更・API実装・テスト追加・内部リファクタが、必須チェックの成功だけでAuto Merge可能になる。
- Railsの通常の設定変更が security-sensitive と判定されなくなり、未接続のSecurity Verifier（`authn-test`等）によるNOT_CONFIGURED FAILも減る。
- Gateと最低LEVELがrule単位になり、「何がなぜ重いのか」が`security.json`を読めば分かる。

### Negative / Trade-offs

- LEVEL 1の変更は人間の目を通らずにmergeされうる。品質の最後の砦は`policy-review`（空ファイル・サイズ上限・`TODO|FIXME`の決定的検査）とTrusted Acceptanceになる。この2つを弱めてはいけない。
- 検知の取りこぼしが、以前は「人1人のレビュー」で拾えていたのが拾えなくなる。検知パターンの不足は、見つけたら`pr-risk.json`・`security.json`に足す。
- `safeRules`を削るので、prototype laneの明示的なLEVEL 1候補という概念はなくなる。prototypeも既定のLEVEL 1に落ちる（`autoMergeEligible`はprototypeでは従来どおりfalse）。

## 実装・運用への影響

- `.harness/rules/pr-risk.json`・`security.json`・`human-gates.json`・`policy.json`、`tools/harness/risk-classifier.mjs`・`schemas.mjs`・`check.mjs`・`sbi-issue.mjs`。
- Security rule: SEC-MIGRATION-001、SEC-SCHEMA-001、SEC-CICD-001、SEC-CONFIG-001、SEC-DESIGN-001のGate・最低LEVEL・承認人数を変える。他の10ルールは変えない。
- GitHub Rulesetは変えない。必須承認は0人のままで、人数はHarnessの`MERGE_ALLOWED`が決める（[ADR-0001](0001-github-review-merge-approval.md)、[docs/workflows/github-ruleset.md](../workflows/github-ruleset.md)）。
- このADR自身を含む`docs/adr/`の変更はLEVEL 2になる。

## 検証方法

- `tools/harness/risk-policy.test.mjs`のLEVEL 1 / 2 / 3の代表ケースが、代表的な変更をその水準に分類すること。
- 通常のProduction変更で`classifySecurity`の`matchedRules`が空になり、`requiredVerifiers`が`secret-scan`と`forbidden-pattern-check`だけになること。
- 運用では、LEVEL 1でAuto Mergeされた変更に起因する不具合が出ていないか、Health Metricsで追う。出るなら検知パターンを足すか、該当種別をLEVEL 2へ戻す。

## 再検討条件 / 撤回条件

- LEVEL 1でmergeされた変更が本番障害・セキュリティ事故につながった場合。
- `policy-review`とTrusted Acceptanceで拾えない品質問題が繰り返し出た場合。
- PR側のポリシーで自分を評価する構造（#168）が解消される前に、`.harness/rules/`以外のHarnessファイルから自己弱体化の経路が見つかった場合。

## 関連資料

- Issue #157（Human Touchpointを最小化し、通常変更をL1自動フローへ寄せる）
- Issue #155・#175・#193（Design Approval Gate・実装前Human Gateの廃止）
- Issue #168（Completion Judgeをmain側の判定コードで動かす）
- [docs/workflows/database-migrations.md](../workflows/database-migrations.md)（破壊的migrationの例外承認）

ADRの状態を変えるのは人間だけ。AIだけで確定しない。
