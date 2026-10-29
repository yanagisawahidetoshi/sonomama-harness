# データベースのマイグレーション

マイグレーションは、データを消さない追加だけを基本にする。列やテーブルの削除・型の変更・名前の変更は、expand/contractの手順で段階に分ける。
Harnessの`migration-safety`は、破壊的な操作（`drop_table`・`remove_column`・`rename_column`・`change_column`・`execute`など）を含むマイグレーションを失敗にする。

## expand/contractの手順

列`probes.legacy_code`を消す場合の例。

1. expand: 新しい列やテーブルを追加し、アプリケーションを新しい側へ移す。古い列を使わないモデルには`self.ignored_columns += ["legacy_code"]`を書く。このPRはmainへmergeする。
2. 移行: 本番があれば、expandを本番へ反映し、必要ならデータを移す。
3. contract: 古い列を消すマイグレーションを、別のPRで出す。このPRだけが、下の例外承認の対象になる。

## 例外承認（contractのPR）

contractのマイグレーションの隣に、`apps/api/db/migrate/exceptions/<マイグレーションのversion>.json`を置く。

```json
{
  "version": 1,
  "migration": "apps/api/db/migrate/20261029000000_remove_legacy_code_from_probes.rb",
  "operations": [{ "line": 3, "operation": "remove_column" }],
  "expand": { "migration": "apps/api/db/migrate/20261028000000_create_probes.rb", "commit": "<expandをmainへmergeしたcommitのSHA>" },
  "removes": [{ "table": "probes", "column": "legacy_code" }],
  "rollback": { "possible": true, "procedure": "db:rollbackで列を戻し、退避したCSVから値を戻す" },
  "dataBackup": { "taken": true, "location": "<退避先>" },
  "productionState": { "state": "not_provisioned" }
}
```

`migration-safety`が機械で確かめること（1つでも満たさなければ失敗）:

- `operations`が、マイグレーションの破壊的な操作と行番号まで一致する。後から操作を足すと一致しなくなる。
- `expand.commit`がmainにmerge済みで、そのcommitに`expand.migration`がある。
- `removes`の列名（列が無ければテーブル名）が、`apps/api/app`・`apps/api/lib`・`apps/api/config`・`packages/api-schema`のどこにも残っていない。`ignored_columns`の行だけは数えない。単語で探すだけなので、別の意味で同じ名前を使っていても失敗になる。
- `rollback.possible`は`true`だけを受け付ける。`migration-safety`は全マイグレーションを`VERSION=0`まで戻すので、戻せないマイグレーション（`drop_table`だけ、`up`だけなど）はどのみち失敗する。
- `productionState`は次の2つのどちらか。mainへのmergeを本番への反映とはみなさない。
  - `deployed`: expandを本番へ反映した。`deploymentRef`・`deployedAt`（ISO 8601、UTC）・`confirmedBy`が必要。
  - `not_provisioned`: 本番環境がまだ無い。

条件を満たすと`migration-safety`は通り、ログに`EXCEPTION REQUESTED`と出る。ただし、承認が揃うまでCIの`harness`チェックは失敗する。

### 承認

1. `node tools/harness/migration-exception.mjs apps/api/db/migrate/exceptions/<version>.json`で、承認用の文面を出す。最後の行が`harness-migration-exception: <digest>`。このコマンドは何も投稿しない。
2. write以上の権限を持つ2人が、それぞれ自分のGitHubアカウントで、その文面をPRのReviewとして投稿する（Commentでも Approveでもよい）。PRの作成者、botは数えない。
3. CIのCompletion Judgeが、Harnessが検証したcommit（PRのhead）へのReviewであること、digestが今のマイグレーションと申請の内容に一致することを確かめる。

digestは、マイグレーションファイルの内容と申請の全項目（操作、expandのcommit、rollback、データの退避、productionState）から計算する。どれかが変われば、それまでの承認は数えない。
headが変わったときも、新しいcommitへのReviewが必要になる。承認を取り消すには、最後の行を`harness-migration-exception-revoke: <digest>`にしたReviewを投稿する。dismissされたReviewも数えない。

この承認は、mergeの承認（[ADR-0001](../adr/0001-github-review-merge-approval.md)）とは別の目的として扱う。mergeにはLEVEL 3の通常のReviewも必要になる。
