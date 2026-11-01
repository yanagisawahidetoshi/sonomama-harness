# ADR-0008: 実行は PR 側の workflow に残し、Completion Judge を main の workflow で動かす。証拠の作り手を変える PR は人が確認する

- 状態: Accepted（2026-10-31、柳沢英俊が承認）
- 日付: 2026-10-31
- 改訂: 2026-10-31、柳沢英俊の決定で、実行 job を `pull_request_target` から `pull_request` に戻した。同日、専用 GitHub App を見送り、証拠の作り手を変える PR は人が確認する構成にした（この改訂の PR の merge で承認）。同日、ruleset の切替後の偽装の確認（#234、#235）で API による偽装が通ることがわかり、既知の制約と merge の前の確認を追記した（柳沢英俊の指示。この PR の merge で承認）
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
- base 側に置いた `pull_request_target` の workflow は動かなかった。2025-12-08 以降、`pull_request_target` は base ではなく default branch の workflow を使うため。したがって「同じ SHA に `pull_request` と `pull_request_target` の同名 check があるときの優劣」は未検証。
- fork からの PR で job 名の偽装が成り立つかは未検証（API での偽造は token が read-only なので不可のはず）。

## 判断ドライバー

- 通常の変更はできるだけ自動で判定し、workflow・Harness・Security など判定の基盤を変える変更だけ人が確認する（最優先）
- PR のコードを、権限のある文脈（`pull_request_target`）で実行しない
- ADR-0005: PR のコードは secret なし・network 遮断のコンテナで動かす
- 数人規模の運用の開始時点で、運用・課金・設定・デバッグの複雑さを先に増やさない

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 今の `pull_request` の workflow の中で main を checkout して判定する | workflow 自体が PR 側なので、PR がその job を差し替えられる |
| 実行 job も `pull_request_target` の workflow に置く | PR のコードが base の文脈と同じ runner で動く（GitHub が警告する pwn request の形）。runner 上の PR のコードが Actions の runtime token に届き、main の scope の cache や同じ run の artifact を書き換える手法が知られている |
| judge の trigger を `workflow_run` にする | 判断者の決定を優先した。実行の run の完了は、judge が poll して待てば足りる |
| 専用 GitHub App の check を必須にして、出し手を固定する（今は見送り） | 同名 check の偽装を機械的に防げるが、App・environment・鍵の運用と設定・デバッグが先に増える。数人規模では、判定の基盤を変える PR を人が確認すれば足りる。下の導入条件で別 Issue にする |
| ruleset の承認レビューを必須にして人の Review で防ぐ | PR の作成者は自分の PR を承認できず、今は作成も同じアカウントで行うため、全 PR が止まる |

## 決定

- **実行と判定の trust boundary を分ける。**
  - 実行: 今の `pull_request` の workflow（`harness.yml`）が PR のコードを checkout し、Verifier・harness-test・harness-demo・maestro・Trusted Acceptance を動かす。その結果は信用しない証拠（untrusted evidence）として扱う。`pull_request` の cache は PR の merge ref の scope に閉じ、main の cache を書き換えない。
  - 判定: `pull_request_target` の workflow（2025-12-08 以降、default branch の workflow だけが使われる）で、main の `tools/harness` と `.harness` を使う。PR の code・依存・script・artifact を install も実行もしない。PR から得るもの（metadata・差分・artifact・job の結果）は判定用のデータとしてだけ扱う。
  - 例外: 手書きの Trusted Acceptance（`trustedScript`）は、今と同じく judge の中で Node の permission model（環境変数なし、PR の tree と信頼側の helper の読み取りだけ、子プロセス不可）で動かす。`ci-matrix` のように PR のコードを import するものがあるので、判定する job には secret も書き込み権限も置かない。check run を書く job は PR の tree を checkout せず、判定する job の結果だけを受け取る。
- **judge は実行の run を待ってから、独立に検証する。**
  - 同じ head SHA・event が `pull_request`・workflow が `harness.yml` の run を探し、完了まで poll する（maestro の上限に合わせて timeout を決める）。同じ PR の古い judge は `concurrency` で取り消す。取り消されて check が出なくても BLOCKED なので fail-closed。
  - impact は main のコードで PR の差分から計算し直す。要求した verifier ごとに、その run の jobs API で `verifiers (<name>)` の success を求める。head SHA の check run の一覧は使わない。PR 側の impact が verifier を減らしても、要求は減らない。
  - artifact（`acceptance-results-*`、`maestro-results`）はその run から API で取り、Zod の schema と head SHA の照合を通す。欠落・schema の不一致・head SHA の不一致・要求したのに skipped は FAIL。
  - PR の差分は API か `git fetch` でデータとして読む。fork からの PR は判定しない（`trustedScript` の sandbox で fork のコードが動くのを避ける）。check run は failure になり、BLOCKED のまま。
- **証拠の作り手（producer）を変えた PR は、自動では通さず人が確認する。** producer は、実行の workflow が読んで動かすもの: `.github/**`、`tools/harness/**`、`.harness/**`（Security policy と判定ロジックを含む）、root の `package.json`・`pnpm-lock.yaml`・`pnpm-workspace.yaml`・`.node-version`・`.npmrc`。lockfile を外すと、依存を差し替えて `harness:verify` を乗っ取れる。ただし、judge が main のコードでデータとして検査するもの（SBI の JSON `.harness/state/sbi-*.json` と、生成した Trusted Acceptance の登録 `.harness/acceptance/sbi-<N>.json`）は除く。
  - 判定は3つにする。`PASS`（success）、`MANUAL_REVIEW_REQUIRED`（neutral）、`FAIL`（failure）。producer の変更があり、ほかがすべて通っていれば `MANUAL_REVIEW_REQUIRED`。ほかに失敗があれば `FAIL` が優先する。
  - neutral は GitHub の必須チェックを満たすので、人が確認して merge できる。Harness の merge 判定（`MERGE_ALLOWED`・`autoMergeEligible`）は success だけを数えるので、自動 merge の対象にはならない。repo の auto-merge は無効のままにする。
  - 通常の L1 / L2 の変更は、今までの条件を満たせば今までどおり自動で判定する。
- **check run は、判定の結果だけを書く job が `checks: write` の `GITHUB_TOKEN` で出す。** 名前は `Completion Judge`。ruleset の必須チェックを `harness` からこれに切り替える（GitHub Actions、integration_id 15368）。専用 GitHub App・environment・App の秘密鍵は、今は導入しない。
  - 既知の制約（ruleset の切替後に #234、#235 で確認）: PR の `pull_request` の workflow から `checks: write` の `GITHUB_TOKEN` で同じ名前の check run を後から作ると、本物の `Completion Judge` の FAIL を必須チェックの上で隠せる。API で作った check run は本物と同じ check suite に入り、GitHub は同じ suite の同じ名前のうち新しい方を使う。PR の画面も SUCCESS になり、merge できる状態（UNSTABLE）になった。job 名を `Completion Judge` にする偽装は別の suite に入るので、本物の failure が残り BLOCKED のままだった。どちらの偽装も PR が `.github/**` を変える必要がある。機械的には防がない。
  - 暫定の運用: `.github/**` か `.harness/**` を変える PR は、PR の画面の必須チェックの表示を信用しない。merge の前に、`Completion Judge` の workflow run（`pull_request_target`、main の workflow）の `judge` と `publish` の結論を確かめてから、人が merge する。
- **判定コードを変える PR**: 合否は main の判定コードで出す。PR 側の `tools/harness` は harness-test（実行）で検証する。PR の `.harness/rules` の変更は merge 後に効く。main 側のルールが要求する検証を PR が消しても、その PR では要求され続ける。
- **版ずれ**: impact と judge を同じ main のコードで動かすので、要求する verifier と判定の版ずれは起きない。実行の run が古い workflow で動いて job が足りなければ FAIL にする。
- **不変条件: judge の workflow・判定コード・ルールの変更は、main に merge されるまで、どの PR の判定にも影響しない。** その PR 自身の判定も、変更前の main のもので行う。実行の workflow の変更はその PR の run で動くが、judge はその PR を `MANUAL_REVIEW_REQUIRED` にする（producer の変更）。
- **Actions の event policy**: この repo は public で、2026-12-02 から event policy の無い public repo では `pull_request_target` が既定で無効になる。event policy で `pull_request_target` を許可し、対象は judge の workflow ファイルだけに限る。
- **専用 GitHub App を導入する条件**（どれかが起きたら、別 Issue で check の出し手を App に固定し、`Completion Judge` の check の identity を分ける。上の暫定の運用はそれまでのもの）: merge の権限を持つ人が増える。bot や Agent に merge を任せる。auto-merge を有効にする。`.github/**`・`.harness/**` の変更を人が毎回は精査しなくなる。PR の画面の必須チェックだけで merge の可否を機械的に決めたくなる。AI Agent が大量の PR を自動で作る。auto-merge の範囲を Security・workflow・Harness の変更まで広げたい。
- **運用の段階（bootstrap policy）**: 今の bypass の穴は、次の段階の方針として受け入れる。一時的な例外とはしない。
  - Personal / Bootstrap（今）: collaborator は実質1人。承認レビュー数は 0 のまま（PR の作成者は自分の PR を承認できず、作成も同じアカウントで行うため）。`MANUAL_REVIEW_REQUIRED` の PR は repo owner が内容を確かめて merge する。
  - Team / Production: 承認レビュー数を 1 以上にし、L3 は異なる2人にする。CODEOWNERS と ruleset を有効にする。admin の bypass は置かないか、break-glass として扱う。`.github/workflows/**` と Security 系の変更は高リスクとして扱う。provider の identity と権限を個人のアカウントから切り離す。
  - 移行の条件は日付ではなくイベントにする。repository の owner / organization が変わる、collaborator が2人以上になる、外部の contributor を受け入れる、本番運用を始める、GitHub App / bot が merge の判定に加わる、のどれかが起きたら Team / Production に移る。

## 理由

PR のコードは権限のない `pull_request` の文脈だけで動かし、judge はそれをデータとして読むだけにすれば、PR のコードが権限のある文脈で動かない。
実行の証拠は PR が workflow や Harness を変えれば偽れるので、その PR は自動で通さず人に回す。通常の変更は、main の judge がその証拠で判定できる。
check の偽装を機械的に防ぐ専用 App は、今の規模では運用の負担の方が大きい。偽装に必要な変更は producer の変更として人が見る。

## 影響

### Positive

- 判定コード・ルール・workflow を変える PR でも、合否は main のコードで出る。
- PR のコードが、main の文脈で動かない。
- 通常の変更は、人を介さずに判定できる。

### Negative / Trade-offs

- 同名 check の偽装は機械的には防げない。PR の画面の表示だけを見て merge すると、FAIL の PR が通る。`Completion Judge` の workflow run の結論を確かめる手間が、producer を変える PR の merge のたびにかかる。
- PR のコードは自分のテストの出力を偽れる（`spec_helper` や Gemfile は PR 側）。ADR-0005 と同じく、保護したテストの digest 照合と PR Review に残る。
- Harness 自身・workflow・root の依存を変える PR は、自動では通らない。Renovate の root の依存更新もここに入る。緩和（実行を固定した image のコンテナで動かすなど）は別の Issue で扱う。
- judge は実行の run が終わるまで runner を占有して待つ。実行の run を re-run したときは、judge も re-run が要る。

## 実装・運用への影響

- 人の作業:
  1. Actions の event policy で、judge の workflow ファイルにだけ `pull_request_target` を許可する。
  2. judge の workflow の PR を merge し、`Completion Judge` が出ることを確かめる。
  3. ruleset の必須チェックを `Completion Judge`（integration_id 15368）に変え、`harness` を外す。
- repo の auto-merge は無効のままにする（neutral でも merge されないように）。
- #147 の L3 の floor（生成した Trusted Acceptance を含む PR）は、この方式が動いてから外す。

## 検証方法

- 回帰テスト（実装 PR で先に書く）: 通常の変更は、要求した verifier の job がすべて success なら PASS。要求した verifier の job が実行の run に無いときは FAIL。producer のパスがあり、ほかが通っていれば `MANUAL_REVIEW_REQUIRED`（neutral）で、Harness の merge 判定は通さない。producer の変更とほかの失敗が重なれば FAIL。head SHA・event・workflow が違う run は使わない。artifact の欠落・head SHA の不一致・不明な skipped は FAIL。judge が PR の tree を判定コードとして読まず、PR の code を install も実行もしないこと。judge の workflow は `pull_request_target` だけで動くこと。
- 切替の前に、#227 で docs だけの変更が success、`.harness/rules` の追加が neutral になることを確かめた。
- 切替の後に、本物の judge が FAIL を出す PR で偽装を確かめた。job 名による偽装（#234）は BLOCKED、API による偽装（#235）は UNSTABLE（merge できる）。auto-merge の有効化は「Auto merge is not allowed for this repository」で拒否された。

## 再検討条件 / 撤回条件

- 専用 GitHub App を導入する条件（決定を参照）のどれかが起きたとき
- Actions の event policy の仕様が変わり、`pull_request_target` が使えなくなったとき
- Team / Production への移行の条件のどれかが起きたとき（ruleset とこの ADR の段階を見直す）
- judge の re-run の手間や、待つ間の runner の占有が問題になったとき（trigger を `workflow_run` にするかを見直す）

## 関連資料

- Issue #168、spike の PR #208〜#213、確認の PR #227、#234、#235
- [Actions pull_request_target and environment branch protections changes](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/)
- [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)
- [Workflow execution protections in GitHub Actions generally available](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/)

ADRへの変更はHuman Gate対象。AIだけで確定しない。
