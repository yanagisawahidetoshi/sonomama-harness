# ADR-0008: 実行は PR 側の workflow に残し、Completion Judge を main の workflow で動かして専用 GitHub App の check として出す

- 状態: Accepted（2026-10-31、柳沢英俊が承認）
- 日付: 2026-10-31
- 改訂: 2026-10-31、柳沢英俊の決定で、実行 job を `pull_request_target` から `pull_request` に戻した（この改訂の PR の merge で承認）
- 判断者: 柳沢英俊
- 関連Issue: #168、#147、#148、#100
- 関連SBI: なし
- 関連Design Docs: [.ai/workflows/ci.md](../../.ai/workflows/ci.md)
- Supersedes:
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。

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
| 実行 job も `pull_request_target` の workflow に置く | PR のコードが base の文脈と同じ runner で動く（GitHub が警告する pwn request の形）。runner 上の PR のコードが Actions の runtime token に届き、main の scope の cache や同じ run の artifact を書き換える手法が知られている |
| judge の trigger を `workflow_run` にする | 判断者の決定を優先した。実行の run の完了は、judge が poll して待てば足りる |
| ruleset の承認レビューを必須にして人の Review で防ぐ | 偽装を検出する仕組みにならず、L1 / L2 の自動判定の意味が無くなる |

## 決定

- **実行と判定の trust boundary を分ける。**
  - 実行: 今の `pull_request` の workflow（`harness.yml`）が PR のコードを checkout し、Verifier・harness-test・harness-demo・maestro・Trusted Acceptance を動かす。その結果は信用しない証拠（untrusted evidence）として扱う。`pull_request` の cache は PR の merge ref の scope に閉じ、main の cache を書き換えない。
  - 判定: `pull_request_target` の workflow（2025-12-08 以降、default branch の workflow だけが使われる）で、main の `tools/harness` と `.harness` を使う。PR の code・依存・script・artifact を install も実行もしない。PR から得るもの（metadata・差分・artifact・job の結果）は判定用のデータとしてだけ扱う。
  - 例外: 手書きの Trusted Acceptance（`trustedScript`）は、今と同じく judge の中で Node の permission model（環境変数なし、PR の tree と信頼側の helper の読み取りだけ、子プロセス不可）で動かす。`ci-matrix` のように PR のコードを import するものがあるので、App の鍵は check run を出す job だけに置き、判定する job には secret を置かない。判定する job は結果だけを渡し、check run を出す job は PR の tree を checkout しない。
- **judge は実行の run を待ってから、独立に検証する。**
  - 同じ head SHA・event が `pull_request`・workflow が `harness.yml` の run を探し、完了まで poll する（maestro の上限に合わせて timeout を決める）。同じ PR の古い judge は `concurrency` で取り消す。取り消されて check が出なくても BLOCKED なので fail-closed。
  - impact は main のコードで PR の差分から計算し直す。要求した verifier ごとに、その run の jobs API で `verifiers (<name>)` の success を求める。head SHA の check run の一覧は使わない（同じ名前の check を別の workflow から出せるため）。PR 側の impact が verifier を減らしても、要求は減らない。
  - artifact（`acceptance-results-*`、`maestro-results`）はその run から API で取り、Zod の schema と head SHA の照合を通す。欠落・schema の不一致・head SHA の不一致・要求したのに skipped は FAIL。
  - PR の差分は API か `git fetch` でデータとして読む。fork からの PR は判定しない（`trustedScript` の sandbox で fork のコードが動くのを避ける）。check run は failure になり、BLOCKED のまま。
- **証拠の作り手（producer）を変えた PR は、自分の証拠だけでは PASS しない。** producer は、実行の workflow が読んで動かすもの: `.github/**`、`tools/harness/**`、`.harness/**`、root の `package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml`・`.node-version`・`.npmrc`。lockfile を外すと、依存を差し替えて `harness:verify` を乗っ取れる。ただし、judge が main のコードでデータとして検査するもの（SBI の JSON `.harness/state/sbi-*.json` と、生成した Trusted Acceptance の登録 `.harness/acceptance/sbi-<N>.json`）は除く。除かないと、SBI の PR がすべて自動で PASS しなくなる。判定は main のコードで差分のパスを見て行い、producer の変更があれば、すべての job が success でも Completion Judge は理由のコードを付けて failure にする。
  - Team / Production では、producer を変えた PR の PASS 条件を「同じ head SHA への、ADR-0001 の GitHub Review が L3 の人数（異なる2人以上）」にする。
  - Bootstrap では PR の作成者しかおらず、自分の PR は承認できない。ruleset に repo admin の bypass（pull request 経由だけ）を置き、producer を変えた PR は repo owner が内容を確かめて bypass で merge する。
- **judge の結果は、専用 GitHub App の check run `Completion Judge` として出す。** ruleset の必須チェックをこの App の integration_id に固定し、`harness`@15368 は外す。
  - App の権限は checks: write だけ。run・jobs・artifact・Issue の読み取りは、判定する job の読み取り専用の `GITHUB_TOKEN` で行う。
  - 秘密鍵は environment secret に置き、environment の deployment branch を main に限る。
- **判定コードを変える PR**: 合否は main の判定コードで出す。PR 側の `tools/harness` は harness-test（実行）で検証する。PR の `.harness/rules` の変更は merge 後に効く。main 側のルールが要求する検証を PR が消しても、その PR では要求され続ける。
- **版ずれ**: impact と judge を同じ main のコードで動かすので、要求する verifier と判定の版ずれは起きない。実行の run が古い workflow で動いて job が足りなければ FAIL にする。
- **不変条件: judge の workflow・判定コード・ルールの変更は、main に merge されるまで、どの PR の判定にも影響しない。** その PR 自身の判定も、変更前の main のもので行う。実行の workflow の変更はその PR の run で動くが、judge はその PR の証拠を数えない（producer の変更）。
- **Actions の event policy**: この repo は public で、2026-12-02 から event policy の無い public repo では `pull_request_target` が既定で無効になる。event policy で `pull_request_target` を許可し、対象は judge の workflow ファイルだけに限る。
- **運用の段階（bootstrap policy）**: 今の bypass の穴は、次の段階の方針として受け入れる。一時的な例外とはしない。
  - Personal / Bootstrap（今）: collaborator は実質1人。承認レビュー数は 0 のまま（PR の作成者は自分の PR を承認できず、作成も同じアカウントで行うため）。`.github/workflows/**` を変える PR は repo owner が目で確かめる。Completion Judge の実装を優先する。
  - Team / Production: 承認レビュー数を 1 以上にし、L3 は異なる2人にする。CODEOWNERS と ruleset を有効にする。必須チェックは `Completion Judge`@App に固定する。admin の bypass は置かないか、break-glass として扱う。`.github/workflows/**` と Security 系の変更は高リスクとして扱う。provider の identity と権限を個人のアカウントから切り離す。
  - 移行の条件は日付ではなくイベントにする。repository の owner / organization が変わる、collaborator が2人以上になる、外部の contributor を受け入れる、本番運用を始める、GitHub App / bot が merge の判定に加わる、のどれかが起きたら Team / Production に移る。

## 理由

check の出し手を、PR が token を持てない App に固定すれば、PR 側の workflow がどんな check を出しても必須チェックは満たせない。
PR のコードは権限のない `pull_request` の文脈だけで動かし、権限を持つ judge はそれをデータとして読むだけにすれば、PR のコードと App の鍵が同じ runner に載らない。
実行の証拠は PR が workflow や Harness を変えれば偽れるので、その PR の証拠は数えず、人の判断に回す。

## 影響

### Positive

- 判定コード・ルール・workflow を変える PR でも、合否は main のコードで出る。
- 必須チェックの偽装（spike の2つの方法）が効かなくなる。
- PR のコードが、main の文脈や App の鍵と同じ runner で動かない。

### Negative / Trade-offs

- PR のコードは自分のテストの出力を偽れる（`spec_helper` や Gemfile は PR 側）。App はこれを防がない。ADR-0005 と同じく、保護したテストの digest 照合と PR Review に残る。
- Harness 自身・workflow・root の依存を変える PR は、自動では PASS しない。Renovate の root の依存更新もここに入る。緩和（実行を固定した image のコンテナで動かすなど）は別の Issue で扱う。
- judge は実行の run が終わるまで runner を占有して待つ。実行の run を re-run したときは、judge も re-run が要る。
- GitHub App の作成・鍵の管理と、Actions の event policy の設定が人の作業として増える。

## 実装・運用への影響

- 人の作業（この順番で行う。逆にすると全 PR が BLOCKED になる）:
  1. environment を作り、deployment branch を main に限る（workflow が参照する environment が無いと、保護の無い environment が自動で作られるため、先に作る）。
  2. GitHub App を作り、repo に install する。environment に App id と秘密鍵を登録する。
  3. Actions の event policy で、judge の workflow ファイルにだけ `pull_request_target` を許可する。
  4. judge の workflow の PR を merge し、`Completion Judge` が出ることを確かめる。
  5. ruleset の必須チェックを `Completion Judge`@App に変え、`harness`@15368 を外す。Bootstrap の間は repo admin の bypass（pull request 経由だけ）を付ける。
- `tools/harness/github-pr.mjs` は ruleset の integration_id を読むので、id のハードコードは要らない。
- #147 の L3 の floor（生成した Trusted Acceptance を含む PR）は、この方式が動いてから外す。

## 検証方法

- 回帰テスト（実装 PR で先に書く）: producer を変えていない PR で、要求した verifier の job がすべて success なら PASS。要求した verifier の job が実行の run に無く、同じ名前の check run だけがあるときは FAIL。差分に producer のパスがあれば、すべて success でも PASS しない。head SHA・event・workflow が違う run は使わない。artifact の欠落・head SHA の不一致・不明な skipped は FAIL。judge が PR の tree を判定コードとして読まないこと。
- 切替後に、PR 側の workflow で job 名 `Completion Judge` の SUCCESS を出しても、`GITHUB_TOKEN` で同名の check run を作っても、BLOCKED のままであることを確かめる（spike と同じ2つの方法）。

## 再検討条件 / 撤回条件

- GitHub が、同じ App の check を workflow ファイル単位で区別して必須にできるようになったとき
- Actions の event policy の仕様が変わり、`pull_request_target` が使えなくなったとき
- Team / Production への移行の条件のどれかが起きたとき（ruleset とこの ADR の段階を見直す）
- judge の re-run の手間や、待つ間の runner の占有が問題になったとき（trigger を `workflow_run` にするかを見直す）

## 関連資料

- Issue #168、spike の PR #208〜#213
- [Actions pull_request_target and environment branch protections changes](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/)
- [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)
- [Workflow execution protections in GitHub Actions generally available](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/)
- [Available rules for rulesets（required status checks の source）](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

ADRへの変更はHuman Gate対象。AIだけで確定しない。
