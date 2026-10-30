# ADR-0004: Risk別の承認と実装前Gateを、main側で計算するrequired check `merge-approval`でGitHubに強制する

- 状態: Proposed
- 日付: 2026-10-30
- 判断者: 柳沢英俊（判断点は Issue #148 で決定済み。状態を Accepted にするのは判断者）
- 関連Issue: #148、#168、#144、#147
- 関連SBI: なし
- 関連Design Docs: [docs/workflows/github-ruleset.md](../workflows/github-ruleset.md)、[.ai/workflows/ci.md](../../.ai/workflows/ci.md)
- Supersedes: ADR-0001 の一部（「API Schema Approval、Design Approval、実装前Gateは、ローカル台帳のまま変えない」）
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。

## 背景

main の Ruleset は、PR を経由することと `harness` チェックの成功を必須にしている。一方で `required_approving_review_count` は 0 で、Risk ごとの承認人数（LEVEL 1 は0人、LEVEL 2 は1人、LEVEL 3 は異なる2人以上）と実装前 Gate は、ローカルの Harness の Merge Policy だけが確かめている。
そのため、merge できる権限を持つ人が GitHub の画面や API から直接 merge すると、必要な承認を迂回できる。

さらに次の事情がある。

- `harness` チェックは PR 側の `tools/harness` で動く。承認判定をこの job に足すと、PR が判定を書き換えられる（この問題自体は #168 で扱う）。
- 実装前 Gate と API Schema Approval の記録は、ローカルの HMAC 台帳にある。鍵はローカルの対称鍵なので、CI からは読めず、検証もできない。
- 今の write 権限者は1人だけで、PR の作成者もその人になる。作成者の Approve は数えないので、強制するとすぐには LEVEL 2・3 の PR を merge できない。

## 判断ドライバー

- GitHub の画面や API から直接 merge しても、必要な承認を迂回できないこと
- 判定を PR の内容（コード・ルール・本文・label）で変えられないこと
- 承認を、対象の SHA・内容（digest）に結びつけ、撤回できること
- 今の開発を止めないこと（write 権限者が1人の間）

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 既存の `harness` job に承認判定を足す | PR 側のコードで動くので、PR が判定を書き換えられる |
| `GITHUB_TOKEN`（GitHub Actions の App）で `merge-approval` を報告する | PR 側の workflow が同じ名前の check を同じ App 名義で報告できる。Ruleset の `integration_id` で区別できない |
| GitHub の必要承認数を1か2に固定する | Risk ごとの人数（LEVEL 1 は0人）を表せない |
| ローカルの HMAC 台帳を証跡として PR に入れる | CI で検証するには鍵を共有するしかなく、共有すれば偽造できる |
| PR への「承認済み」コメントや label で判定する | 内容（digest）に結びつかない。label は誰が付けたかを判定に使えない |

## 決定

- 品質の `harness` とは別に、承認判定の check `merge-approval` を新しく作る。
  - main の checkout にあるコードとルールだけで動く workflow が計算する。PR のコードは実行せず、PR の差分はデータとして読む。
  - 報告は専用の GitHub App の名義で行う。PR 側の Actions と同じ App にはしない。Ruleset ではその App の `integration_id` に固定する。
  - App の鍵は Environment の secret に置き、deployment branch を main に限る。
- Risk は main 側のルールで、PR の差分（`merge-base..head`）から計算し直す。PR 本文・label・AI の Risk は使わない。SBI snapshot は、CI と同じ照合で現在の SBI Issue と一致したときだけ使う。
- Review は、今の `reviewApprovals`（ADR-0001）と同じ規則で数える。現在の PR HEAD への、write 以上の権限を持つ異なる人の Approve だけを数え、PR 作成者・bot・権限を読めない人は数えない。
- PR の種類ごとの扱い。どれも承認ルールを黙って免除しない。

  | 種類 | Gate の記録を置く場所 |
  | --- | --- |
  | Product（SBI snapshot） | SBI Issue |
  | Engineering（`Engineering-Issue` trailer） | Engineering Issue |
  | source なし（Harness 本体・docs・prototype） | 置く場所が無い。Gate が必要なら FAIL（必要なら Engineering Issue を作ってから再実行する） |
  | trusted dependency bot | 同上。承認人数は Risk どおり |

- PR mode の実装前 Gate と API Schema Approval の正本を、ローカル台帳から GitHub 上の記録に移す。ADR-0001 の該当部分をこの ADR で置き換える。
  - write 以上の権限を持つ人が、対象の Issue に `harness-gate: <digest>`（API Schema は `harness-api-schema: <digest>`）の行だけを書いたコメントを投稿する。撤回は `…-revoke: <digest>`。
  - 人ごとに最新の記録を使う。bot と権限を読めない人は数えない。編集されたコメントは無効、削除は撤回として扱う。
  - digest は CI でも計算し直せる形（v2）にする。
  - Design Approval は #155 で廃止したので、対象に含めない。
  - Local mode（PR を作らない run）は、今までどおりローカル台帳を使う。
- 再評価のきっかけ: PR の作成・再 open・HEAD の更新、Review の投稿・dismissal、Issue のコメントや本文・label の変更、15分ごとの掃引。PR ごとに直列に評価し、報告の直前に PR HEAD を確かめ直す。
- 適用の順番。
  1. 判定ロジック・専用 App・digest 付きの承認方式を実装する。この間、`merge-approval` は報告するだけで、required にしない。
  2. write 権限者が2人以上になり、#144（main が進んだ後の再検証）が入ったら、Ruleset で `merge-approval` を required にし、`strict_required_status_checks_policy` と `dismiss_stale_reviews_on_push` を有効にする。Ruleset の適用は人が行う。
- 実際の merge は人が行う。自動 merge はしない。

## 理由

承認判定を、PR が変えられないコード（main 側）と、PR 側が名乗れない報告元（専用 App）に置けば、GitHub の required check として強制できる。
Gate の正本を GitHub 上の記録にすれば、CI から検証でき、別の PC の開発者も記録できる。digest に結びつけるので、内容が変われば記録は無効になる。

## 影響

### Positive

- GitHub の画面や API から直接 merge しても、Risk ごとの承認と Gate を迂回できなくなる（required にした後）。
- 実装前 Gate を、別の PC の開発者も記録できる。

### Negative / Trade-offs

- 完全な強制ではない。HEAD が変わらない変化（Approve の dismissal、REQUEST_CHANGES、Gate の撤回・削除、Issue の編集）は、評価が終わるまで古い success が残る。Actions の障害やイベントの欠落では、次の掃引（15分）まで残る。将来 merge queue などで縮める。
- GitHub App の作成と Environment secret の管理という運用が増える。
- write 権限者が1人の間は、強制できない（報告だけ）。

## 実装・運用への影響

- 新しい workflow（main 側で動く）と判定モジュール、専用 GitHub App が要る。App の作成・権限付与・secret の登録は人が行う。
- `harness:approve` は、PR mode では Gate の記録を GitHub に投稿する。
- `.github/rulesets/main.json` と適用手順（`docs/workflows/github-ruleset.md`）を更新する。
- 関連する Security rule: SEC-CICD-001（`.github` の変更）、SEC-DESIGN-001（この ADR）。

## 検証方法

- LEVEL 2 で0人、LEVEL 3 で1人の Approve では、品質 CI が成功しても `merge-approval` が FAIL する。
- HEAD の更新、Approve の dismissal、REQUEST_CHANGES、Gate の撤回で、古い success を使わない。
- 同じ人の複数の Approve、PR 作成者・bot の Approve では人数を満たさない。
- GitHub API の失敗、Risk を判定できない、承認の記録が無い、のどれでも FAIL する。
- PR 側で workflow・判定コード・ルール・JSON を変えても、判定が変わらない。
- Ruleset を適用した後、実際のリポジトリで未承認の PR が merge できないことを確かめる。

## 再検討条件 / 撤回条件

- merge queue が使えるようになったとき（競合窓を縮める）
- GitHub がネイティブで Risk に応じた承認人数を表せるようになったとき
- 専用 App の運用が負担になり、代わりの信頼できる報告元が見つかったとき

## 関連資料

- Issue #148（設計案と判断点）、#168（`harness` チェックの信頼の問題）
- [ADR-0001](0001-github-review-merge-approval.md)

ADRへの変更はHuman Gate対象。AIだけで確定しない。
