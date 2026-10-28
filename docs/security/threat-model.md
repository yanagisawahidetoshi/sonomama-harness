# 脅威モデルのテンプレート

## 人が明確にすること

守るべき資産、利用者、信頼できる範囲の境目、外部との接続、想定する攻撃、守る手段、残るリスクを記録する。
本番データへの影響と復旧の手順を確認し、重要な設計はADRに残す。

## Harnessで守らせるルール

次の変更には、実装前の人の承認、レベル3のリスク判定、決めた検証の実行が必要になる（詳しくは[README](README.md)）。

| ルールID | 対象となる変更 | 必ず実行する検証 |
| --- | --- | --- |
| SEC-MIGRATION-001 | データベースのマイグレーション | マイグレーションの安全性検査（migration-safety） |
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

Rails（Docker Compose）はコンテナの中から入れ子で起動できない。trusted HarnessがComposeを起動し、その前にworkspaceのCompose fileを検査する。workspace外やHarness状態のbind mount、`privileged`等の特権設定、`env_file`、environment以外での環境変数展開は拒否する。Composeの環境変数はDocker CLIに必要なものだけにする。Railsコンテナ内はrootのまま動く。

`api-contract`のようにHarnessのスクリプトがworkspaceのファイルを読むだけのverifierは、`isolation: harness`としてホストで動かす。対象は`tools/harness/*.mjs`だけで、環境変数は`PATH`と`HARNESS_BASE_REF`に限る。

対象外: Agent CLI自体の実行環境、OS全体を悪意あるローカルユーザーから守ること、GitHub Actions Runnerの設計。
