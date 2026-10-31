# ADR-0008: Completion Judge を main の workflow で動かし、専用 GitHub App の check として出す

- 状態: Proposed
- 日付: 2026-10-31
- 判断者: 柳沢英俊
- 関連Issue: #168、#147、#148、#100
- 関連SBI: なし
- 関連Design Docs: [.ai/workflows/ci.md](../../.ai/workflows/ci.md)
- Supersedes:
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。Proposedの間は、AIはこのADRを決まったものとして実装や提案の根拠にしない。

## 背景

今の必須チェックは、ruleset の `harness`（integration_id 15368 = GitHub Actions）だけ。`harness` job は `pull_request` で動き、PR head の `tools/harness` で判定している。
`pull_request` では workflow ファイル自体も PR 側のものが使われるので、PR は判定コードも workflow も差し替えられる。

2026-10-31 に、`spike/168-base` だけを対象にした一時 ruleset（`probe`@15368 を必須）で確かめた（PR #208〜#213、確認後に ruleset とブランチは削除済み）。

| PR | PR 側が出した `probe` | 結果 |
| --- | --- | --- |
| #208 / #209 | なし | BLOCKED |
| #210 / #211 | `pull_request` の workflow を追加し、job 名 `probe` で SUCCESS | CLEAN |
| #212 | 同じく job 名 `probe` で FAILURE | BLOCKED |
| #213 | `checks: write` の `GITHUB_TOKEN` で、API から check run `probe` を SUCCESS で作成 | CLEAN |

- PR 側の workflow から出した check は、job 名でも API でも app.id が 15368 になり、ruleset で区別できない。main の `harness`@15368 にも同じことが成り立つ（今の ruleset は承認レビュー数 0）。
- base 側に置いた `pull_request_target` の workflow は動かなかった。2025-12-08 以降、`pull_request_target` は base ではなく default branch の workflow を使うため。したがって「同じ SHA に `pull_request` と `pull_request_target` の同名 check があるときの優劣」は未検証。下の決定では Actions 由来の check を必須に数えないので、この結果に依存しない。
- fork からの PR で job 名の偽装が成り立つかは未検証（API での偽造は token が read-only なので不可のはず）。

## 判断ドライバー

- PR が判定コード・ルール・workflow・check を変えても、その PR 自身の合否を変えられない（最優先）
- ADR-0005: PR のコードは secret なし・network 遮断のコンテナで動かす
- 判定コードを変える PR も、判定前に検証できる
- 必須チェックの出し手を、ruleset で1つに固定できる

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 今の `pull_request` の workflow の中で main を checkout して判定する | workflow 自体が PR 側なので、PR がその job を差し替えられる |
| `pull_request_target` / `workflow_run` で判定し、GitHub Actions の check（15368）として出す | spike のとおり、PR 側の同名 check と区別できない |
| PR 側の `pull_request` の job が作った artifact を、main 側の judge が読む | PR が workflow ごと差し替えて、結果ファイルを書き換えられる |
| ruleset の承認レビューを必須にして人の Review で防ぐ | 偽装を検出する仕組みにならず、L1 / L2 の自動判定の意味が無くなる |

## 決定

未決定。以下を提案する。

- **判定と実行を、main の workflow ファイルが握る。** trigger は main の workflow だけが使われるもの（下の表）にする。その中で job を分ける。
  - 実行 job: PR head を checkout し、Verifier・harness-test・Trusted Acceptance を ADR-0005 の隔離コンテナで動かす。`permissions: {}`、secret なし。結果は同じ run の artifact で渡す。
  - judge job: main の `tools/harness` と `.harness` で判定する。PR のツリーは checkout せず、install も実行もしない。PR の差分（変更ファイルと内容）は API か `git fetch` でデータとして読み、impact も main のコードで計算し直す。artifact は Zod で検証して読む。
- **judge の結果は、専用 GitHub App の check run `Completion Judge` として出す。** ruleset の必須チェックをこの App の integration_id に固定し、`harness`@15368 は外す。
  - App の権限は checks: write、pull_requests: read、contents: read、issues: read（承認コメントの読み取り）だけ。
  - 秘密鍵は environment secret に置き、environment の deployment branch を main に限る。
- **判定コードを変える PR**: 合否は main の判定コードで出す。PR 側の `tools/harness` は harness-test（実行 job）で検証し、L3 の Review を必須にする。PR の `.harness/rules` の変更は merge 後に効く。main 側のルールが要求する検証を PR が消しても、その PR では要求され続ける。
- **版ずれ**: impact と judge を同じ main のコードで動かすので、producer と judge の版ずれは起きない。artifact が無い・schema に合わない・head SHA が違う・要求した verifier が skipped のときは FAIL にする。

trigger の候補（判断点）:

| 案 | 却下理由 / 条件 |
| --- | --- |
| `pull_request_target`（推奨） | この repo は public。2026-12-02 から、event policy が無い public repo では既定で無効になる。event policy で、この workflow ファイルだけを明示的に許可する必要がある |
| `workflow_run`（PR 側の workflow の完了で起動） | PR が元の workflow を消すか名前を変えると judge が動かない（BLOCKED なので fail-closed）。fork の PR では PR 番号の解決が要る。public repo の新しい既定ルールの対象かは未確認 |

## 理由

check の出し手を、PR が token を持てない App に固定すれば、PR 側の workflow がどんな check を出しても必須チェックは満たせない。
実行も main の workflow に入れれば、judge が読む artifact を作る手順を PR が変えられない。

## 影響

### Positive

- 判定コード・ルール・workflow を変える PR でも、合否は main のコードで出る。
- 必須チェックの偽装（spike の2つの方法）が効かなくなる。

### Negative / Trade-offs

- PR のコードは自分のテストの出力を偽れる（`spec_helper` や Gemfile は PR 側）。App はこれを防がない。ADR-0005 と同じく、保護したテストの digest 照合と PR Review に残る。
- GitHub App の作成・鍵の管理と、Actions の event policy の設定が人の作業として増える。
- PR が `.github` を変えても、その PR では変更後の workflow は動かない（merge 後に効く）。

## 実装・運用への影響

- 人の作業（この順番で行う。逆にすると全 PR が BLOCKED になる）:
  1. GitHub App を作り、repo に install する。
  2. environment（main 限定）に App id と秘密鍵を登録する。
  3. Actions の event policy で、trigger に使う workflow を許可する（`pull_request_target` を選んだ場合）。
  4. workflow の PR を merge し、`Completion Judge` が出ることを確かめる。
  5. ruleset の必須チェックを `Completion Judge`@App に変え、`harness`@15368 を外す。
- `tools/harness/github-pr.mjs` は ruleset の integration_id を読むので、id のハードコードは要らない。
- #147 の L3 の floor（生成した Trusted Acceptance を含む PR）は、この方式が動いてから外す。

## 検証方法

- 回帰テスト（実装 PR で先に書く）: judge job の checkout が main であること、judge が PR のツリーから `tools/harness` を読まないこと、PR が判定コードを変えた fixture で合否が変わらないこと、artifact の欠落・head SHA の不一致・不明な skipped が FAIL になること。
- 切替後に、PR 側の workflow で job 名 `Completion Judge` の SUCCESS を出しても BLOCKED のままであることを確かめる。

## 再検討条件 / 撤回条件

- GitHub が、同じ App の check を workflow ファイル単位で区別して必須にできるようになったとき
- Actions の event policy の仕様が変わり、選んだ trigger が使えなくなったとき

## 関連資料

- Issue #168、spike の PR #208〜#213
- [Actions pull_request_target and environment branch protections changes](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/)
- [Workflow execution protections in GitHub Actions generally available](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/)
- [Available rules for rulesets（required status checks の source）](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

ADRへの変更はHuman Gate対象。AIだけで確定しない。
