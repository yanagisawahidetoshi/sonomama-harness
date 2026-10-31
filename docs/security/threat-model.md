# 脅威モデルのテンプレート

## 人が明確にすること

守るべき資産、利用者、信頼できる範囲の境目、外部との接続、想定する攻撃、守る手段、残るリスクを記録する。
本番データへの影響と復旧の手順を確認し、重要な設計はADRに残す。

## Harnessで守らせるルール

次の変更には、実装前の人の承認、レベル3のリスク判定、決めた検証の実行が必要になる（詳しくは[README](README.md)）。

| ルールID | 対象となる変更 | 必ず実行する検証 |
| --- | --- | --- |
| SEC-MIGRATION-001 | データベースのマイグレーション | マイグレーションの安全性検査（migration-safety）。破壊的な操作はexpand/contractの例外承認だけで通す（[手順](../workflows/database-migrations.md)） |
| SEC-SCHEMA-001 | データベースのスキーマ | マイグレーションの安全性検査（migration-safety） |
| SEC-CICD-001 | CI/CDのセキュリティ設定 | 禁止パターンの検査（forbidden-pattern-check） |
| SEC-INFRA-001 | インフラのセキュリティ設定 | 禁止パターンの検査（forbidden-pattern-check） |
| SEC-DESTRUCTIVE-001 | 破壊的な操作、本番データ | データの保存と削除のテスト（data-lifecycle-test） |
| SEC-DESIGN-001 | セキュリティに関わる重要な設計、ADR | 禁止パターンの検査（forbidden-pattern-check） |

汎用のパターン検査だけでは、業務上の安全性は証明できない。必要な個別のテストを用意し、Harnessに登録する。

SEC-DESTRUCTIVE-001は、本番データ、本番API、Cognito User Poolへの接続も対象にする。試作であっても、これらに影響する場合はSBIでその影響を宣言し、実装前の人の承認とデータの保存と削除のテストを必要とする。本番環境の接続先が増えたら、試作の変更から本番への影響を見つけるためのパターンも広げる。

## Harnessの実行境界

Agentが書いたコードとapplication testは信頼しない。Harnessは処理を次の3つに分けて実行する。

| 区分 | 何が動くか | 実行場所 | 見えるもの |
| --- | --- | --- | --- |
| trusted Harness | tools/harness、git、gh、承認・証跡の記録 | ホスト | Credential、承認鍵`.harness/state/human/.key`、API Schema署名状態`.harness/state/api-schema/**`、run証跡 |
| trusted acceptance | `.harness/verification/*.mjs` | ホストのNode permission model（読み取りはworkspaceとHarnessのnode_modulesだけ、子process禁止、環境変数なし） | workspace |
| untrusted application | verifier・security verifierのコマンド（pnpm、Jest、Vitest、RSpec等） | Dockerコンテナ | workspaceだけ |

untrusted applicationのコンテナは次の条件で起動する。ローカルでもCIでも同じ条件になる。

- ホストからmountするのはworkspaceだけ。HOME、Docker socket、ホストのnode_modulesはmountしない。
- workspaceがリポジトリそのもの（`harness:verify`、CI）でも、`.git`・`.harness/state`・`.harness/runs`・`.harness/exports`と秘密ファイルは空のmountで隠す。
- 環境変数は`HOME=/tmp/home`、`CI`、`LANG`、`TZ`、XDG、pnpm storeの場所だけ。Harnessの環境変数は引き継がない。
- 非rootのユーザー、`no-new-privileges`、読み取り専用のroot filesystemで動かす。capabilityはCHOWNとDAC_READ_SEARCHだけ残し、volumeを準備するrootのexecだけが使う。検証コマンドのユーザーはcapabilityを持たない。
- networkは既定で無効。依存のinstallやExpo Doctorで外部接続が必要なverifierだけ、`harness.json`で`network: true`を宣言する。
- node_modulesとpnpm storeはverifierごとの使い捨てvolumeに置き、コンテナ内でinstallする。
- Dockerが使えないとき、imageを作れないとき、コンテナを起動できないときは`FAIL`（`isolation unavailable`）にする。ホストで代わりに実行しない。

Rails・migration-safety・rails-authz-test（Docker Compose）はコンテナの中から入れ子で起動できない。trusted HarnessがComposeを起動し、その前にworkspaceのCompose fileを検査する。workspace外やHarness状態のbind mount、`privileged`等の特権設定、`env_file`、environment以外での環境変数展開は拒否する。Composeの環境変数はDocker CLIに必要なものと、CIが指定するBuildKit cacheの場所（`HARNESS_BUILD_CACHE_FROM`・`HARNESS_BUILD_CACHE_TO`）だけにする。Compose fileのcache設定はこの変数の参照だけを許し、ホストのパスをAgentに選ばせない。同じverifierに並ぶ`tools/harness/*.mjs`のスクリプトは、`isolation: harness`と同じ条件でホストで動かす。Composeの各コマンドには、workspaceのCompose fileの後にHarnessが作るoverrideを重ねる。workspaceから`build`するサービス（`api`）は、Compose fileに`user: root`と書いてあってもホストのuid:gid（rootではない）で動き、HOMEはコンテナの`/tmp`になる。`/rails/tmp`と`/rails/log`はimageの側で誰でも書けるようにしてある（sticky bit付き）。書けなければVerifierは失敗する。imageをpullするだけのサービス（`db`のpostgres）は、image自身が決めた実行ユーザー（起動処理の後に`postgres`ユーザーへ切り替わる）のまま動かす。

Mobile E2E の `maestro` CI job（#145）は、この隔離の例外として人が認めた（#68）。`expo prebuild`・Gradle の build・Metro・Android Emulator・Maestro を、GitHub-hosted runner のホストで直接動かす。そのため、Agent が変えられる設定（`app.json` の plugin、babel・metro の設定、native の依存）が runner の上で実行される。残るリスクを次の条件で抑える。

- GitHub-hosted runner だけで動かす（使い捨てで、ほかの run と共有しない）
- job の権限は `contents: read` だけで、secret を渡さない。checkout は認証情報を残さない（`persist-credentials: false`）
- `pull_request_target` を使わない。fork からの PR も、fork の権限のまま動く
- APK の共有 cache は main への push だけが保存する。PR は読むだけで書き換えない
- Maestro CLI は version を固定し、配布物の sha256 を照合してから使う
- Rails と DB を起動する前に、Compose file を Harness の検査に通す

KVM を渡したコンテナの中で動かし、この例外をなくす作業は #146 で行う。

AI Review の adapter（#187、`tools/harness/agents/ai-review-adapter.mjs`）は provider CLI（claude / codex）をホストで動かす。レビュー対象の変更から reviewer への経路を次の条件で絞る。

- 入力は Harness が計算した head SHA・committed diff・SBI・Verifier の結果だけ。workspace は渡さない。秘密ファイルは中身を除き、prompt 全体を redaction に通す。prompt は diff をデータとして扱うよう指示する。
- CLI は空の一時ディレクトリで、tool なし（claude）・read-only sandbox（codex）で動かす。workspace の `CLAUDE.md` / `AGENTS.md` を読ませない。
  codex の read-only sandbox は書き込みを止めるだけで、一時ディレクトリの外（workspace やホストのファイル）の読み取りは止めない。claude の tool なしと同じ隔離にはならない。
- 出力は Zod の strict schema（headSha・PASS/FAIL・riskLevel・reasons）で検証し、redaction を通したものだけを返す。生の応答・stdout・stderr は run 配下にもエラー文にも残さない。
- タイムアウト・異常終了・不正な応答・別 SHA への結果は FAIL。fake adapter は fake provider（demo・テスト）だけが使い、real provider の run で fake の結果は FAIL。

diff に仕込まれた指示で AI Review が PASS に誘導されても、ほかの必須チェック（Verifier・Security・Trusted Acceptance・CI）は残る。AI Review の riskLevel は Risk を上げる方向にだけ使い、人間の承認人数には数えない。

`api-contract`のようにHarnessのスクリプトがworkspaceのファイルを読むだけのverifierは、`isolation: harness`としてホストで動かす。対象は`tools/harness/*.mjs`だけで、環境変数は`PATH`と`HARNESS_BASE_REF`に限る。

対象外: Agent CLI自体の実行環境、OS全体を悪意あるローカルユーザーから守ること、GitHub Actions Runnerの設計。
