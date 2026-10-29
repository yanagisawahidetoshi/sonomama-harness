# mainのGitHub Ruleset

mainへの変更は、PRを通し、CIの`harness`チェックが成功したものだけにする。GitHubのRulesetでこれを強制し、ローカルのpre-push hookを外したpushや、CIが落ちたPRのmergeを止める。
変更のリスクに応じたレビュー人数はHarnessが判定するので、GitHub側では人数を要求しない。
設定内容は[.github/rulesets/main.json](../../.github/rulesets/main.json)にあり、リポジトリの管理者が下の手順で適用する。HarnessもAIエージェントもGitHubの設定は変更しない。

## HarnessとGitHubの分担

| 判定すること | 受け持つ側 |
| --- | --- |
| mainへの直接push、force push、mainの削除を止める | GitHub Ruleset |
| `harness`チェックが成功していないPRのmergeを止める | GitHub Ruleset |
| `harness`チェックの中身（変更範囲に応じた検証、Trusted Acceptance、Completion Judge） | CI上のHarness（[.ai/workflows/ci.md](../../.ai/workflows/ci.md)） |
| リスクのレベル（1〜3）と、必要なレビュー人数（0人、1人、別々の2人以上） | Harness |
| 検証したcommitとPRの先頭が一致しているか、mainが進んでいないか、修正依頼が残っていないか | Harness（`pnpm harness:resume`） |
| 実際のmerge | 人 |

GitHubはHarnessのMERGE_ALLOWEDを参照しない。Rulesetで止められるのは「PRを通していない」「`harness`が成功していない」の2つだけで、レビュー人数が足りないPRでもGitHub上ではmergeできる。mergeする人は、`pnpm harness:resume --run RUN_ID`でMERGE_ALLOWEDを確かめてからmergeする。Harnessの判定条件は[.ai/workflows/pull-request.md](../../.ai/workflows/pull-request.md)にある。

## 設定の内容

| ルール | 設定 | 理由 |
| --- | --- | --- |
| 対象 | `refs/heads/main`だけ | Harnessのbase branch（`.harness/config/harness.json`の`github.base`）に合わせる。`harness:pr`が作る`harness/<run-id>`のbranchは対象外 |
| deletion | 有効 | mainを削除できないようにする |
| non_fast_forward | 有効 | force pushで履歴を書き換えられないようにする |
| pull_request | 必要な承認は0人 | mainへの直接pushを止め、PR経由だけにする。人数は下の表のとおりHarnessに任せる |
| required_status_checks | `harness`（GitHub Actions、`integration_id: 15368`） | CIのCompletion Judgeが成功したPRだけmergeできるようにする |
| strict_required_status_checks_policy | 無効 | Harnessは、mainの先頭がrunのbaselineと一致することを自分で確かめる。これはGitHubの「branchを最新にする」より強い条件なので、二重には要求しない |
| bypass_actors | なし | 管理者も含めて例外を作らない。緊急時の扱いは下に書く |

`harness`は`.github/workflows/harness.yml`のjob idで、GitHubのcheck名もこの名前になる。job idを変えると、Rulesetの必須チェックと一致しなくなり、どのPRもmergeできなくなる。`integration_id`を指定しているので、GitHub Actions以外のGitHub Appが同じ名前のcheckを報告しても、必須チェックを満たしたことにはならない。Harnessも、Rulesetの必須チェックと`integration_id`を読んで判定に加える。

## レビュー人数をGitHubに設定しない理由

| 案 | 却下理由 |
| --- | --- |
| GitHubで承認を1人必須にする | LEVEL 1（承認0人）の変更でもレビューが必要になり、Harnessの判定と食い違う。今はリポジトリの書込権限を持つ人が1人だけで、GitHubは自分のPRを自分で承認できないため、どのPRもmergeできなくなる |
| GitHubで承認を2人必須にする | LEVEL 1・2で必要以上の人数を求める。上と同じく、今の人数ではmergeできない |
| リスクのレベルに応じて、GitHubの人数を変える | LEVEL 1〜3の判定をGitHub側でもう一度実装することになる。#50の対象外 |

採用: GitHubの必要な承認は0人にし、人数はHarnessのMERGE_ALLOWEDで判定する。

## 緊急時

bypass_actorsを空にしているので、管理者でもRulesetを迂回したmergeやpushはできない。障害対応などでどうしても必要な場合は、リポジトリの管理者がRulesetの`enforcement`を`disabled`にし、作業が終わったらすぐ`active`に戻す。止めた理由と期間は、関係するIssueに残す。

## 適用する（人が実行する）

適用済み（ruleset id 26088284）。`.github/rulesets/main.json`を変えたときは、下の更新コマンドで反映し直す。

リポジトリの管理者が、`gh`で認証した状態でリポジトリのルートから実行する。

```sh
# 既存のRulesetを確認する。mainという名前のRulesetがなければ作成する
gh api repos/yanagisawahidetoshi/sonomama-harness/rulesets
gh api -X POST repos/yanagisawahidetoshi/sonomama-harness/rulesets --input .github/rulesets/main.json

# 作成済みのRulesetを、.github/rulesets/main.jsonの内容に更新する
RULESET_ID=$(gh api repos/yanagisawahidetoshi/sonomama-harness/rulesets --jq '.[] | select(.name == "main") | .id')
gh api -X PUT "repos/yanagisawahidetoshi/sonomama-harness/rulesets/$RULESET_ID" --input .github/rulesets/main.json
```

privateリポジトリでRulesetを使うには、GitHub Pro以上のプランが必要。作成が403で失敗した場合は、プランを確認する。

## 適用を確認する

1. mainに効いているルールを読む。`deletion`、`non_fast_forward`、`pull_request`、`required_status_checks`の4つが出て、必須チェックが`harness`（`integration_id`は15368）であることを確かめる。

   ```sh
   gh api repos/yanagisawahidetoshi/sonomama-harness/rules/branches/main --jq '.[] | {type, parameters}'
   ```

2. mainへの直接pushが拒否されることを確かめる。設定が効いていなければ空のcommitがmainに入るので、最初の手順で4つのルールを確認してから行う。

   ```sh
   git fetch origin
   git worktree add --detach ../ruleset-check origin/main
   git -C ../ruleset-check commit --allow-empty -m "ruleset check"
   git -C ../ruleset-check push origin HEAD:refs/heads/main   # GH013 で拒否されれば正しい
   git worktree remove ../ruleset-check
   ```

3. CIが終わる前のPRをmergeできないことを確かめる。PRを作った直後、`harness`が実行中の間は`BLOCKED`になる。

   ```sh
   gh pr view PR_NUMBER --json mergeStateStatus
   ```

4. GitHub PR modeのrunで`pnpm harness:resume --run RUN_ID`を実行し、`.harness/runs/<run-id>/github-state.json`の`ci.requiredChecks`に、`harness`（`integrationId: null`）と`harness`（`integrationId: 15368`）の2つが入っていることを確かめる。前者は`harness.json`の`github.requiredChecks`、後者はRulesetから読んだもの。どちらも同じcheck runで満たされるので、CIが成功していれば判定は変わらない。
