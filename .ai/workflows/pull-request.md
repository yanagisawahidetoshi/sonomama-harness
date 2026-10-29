# GitHub PR Adapterの運用

Harnessが検証したcommitを、そのままGitHub PRとして公開する。実装後のMerge Approvalは、そのPRへのGitHub Reviewで判定する（[ADR-0001](../../docs/adr/0001-github-review-merge-approval.md)）。
Harnessが出すのは`MERGE_ALLOWED`まで。mergeは人間がGitHubで行う。

```text
harness:run → executionStatus=DONE
  → Harnessが続けてPRを作成（`harness:pr --run RUN_ID`は障害復旧用。ゲート待ちのrunは`harness:approve`の後に作成）
      origin/main の先頭が run baseline と一致するか確認 → 差分とPR本文の秘密値を検査
      → tested SHAを harness/<run-id> にpush（force pushしない）→ PRを作成（同じbase向けの既存open PRがあれば再利用）
  → GitHub上で CI と Review
  → pnpm harness:resume --run RUN_ID（保守用。実行のたびにGitHubから取り直して判定）
      PR open かつ base = run baseline かつ tested SHA = PR HEAD SHA かつ 必須CI PASS
      かつ CHANGES_REQUESTEDなし かつ Riskごとの人数のApproveあり → MERGE_ALLOWED
```

## 2つのモード

| モード | 実装後Merge Approvalの正本 |
| --- | --- |
| GitHub PR mode（PRを作成したrun） | GitHub Review。`harness:approve --phase merge`は拒否する |
| Local mode（PRを作っていないrun、demo） | ローカル署名台帳（`harness:approve --phase merge`） |

2つの方式を同時には要求しない。API Schema Approval、Design Approval、実装前Gateは、どちらのモードでもローカル署名台帳を使う。

## 判定

- **PR**: closeまたはmergeされていればBLOCKED。Harnessが`MERGED`を生成することはない。
- **base**: PRのbase branchが`github.base`で、PRのbase SHAとそのbranchの現在の先頭がどちらもrunのbaselineのときだけ進む。違えばBLOCKED（`base_not_baseline`）。
  baseがbaselineのままなら、mergeの結果はtested SHAと同じコードになる。mainが進んだら、`harness:reverify`で再検証する（下記）。
  PRのbase SHAはmainの更新に追従しない場合があるため、現在のbranchの先頭も`git ls-remote`で確かめる。
  これはRulesetの`strict_required_status_checks_policy`より強い条件なので、その設定は読まない。
- **SHA**: PR HEADがtested SHAと違えばBLOCKED（`tested_sha_mismatch`）。PRへ追加pushした場合は、新しいrunで検証し直す。
- **CI**: 必須checkは、`.harness/config/harness.json`の`github.requiredChecks`と、base branchのRulesetにあるrequired status checksの和集合。
  Rulesetのcheckに`integration_id`があれば、そのGitHub Appが報告したcheck runだけを数える。同じ名前でも別のAppのcheckは数えない。
  PR HEADに対する最新のcheck runがすべてsuccessのときだけPASSとする。skipped / neutral / cancelled、またはcheckがない場合はPASSにしない。
  必須checkが1つもなければNOT_CONFIGUREDとしてBLOCKEDにする。
- **Review**: userごとに最新のReviewを使う。
  - APPROVEDは、tested SHAに対するものだけを数える。
  - CHANGES_REQUESTEDは、対象SHAにかかわらず、再レビューされるかdismissされるまでブロックする（REJECTED）。
  - COMMENTEDは判定を変えない。botとPR作成者は数えない。
  - GitHubと同じく、リポジトリのwrite以上の権限（write / maintain / admin）を持つ人のReviewだけを数える。read / triageの人のAPPROVEDもCHANGES_REQUESTEDも判定に使わない。
    権限を読めなかった人のAPPROVEDは数えず、CHANGES_REQUESTEDはブロックとして扱う。読んだ権限は`github-state.json`の`reviews.permissions`に残す。
- **人数**: LEVEL 1は0人、LEVEL 2は1人、LEVEL 3は異なる2人以上。PR作成者（Harnessを実行した`gh`のアカウント）以外がReviewする。
- GitHubを読めなければBLOCKED（`github_state_unavailable`）とする。runはESCALATEDにしないので、`harness:resume`で再判定できる。

`github-state.json`は、判定に使ったGitHubの状態の要約（PR・CI・Review）。正本はGitHub。APIのレスポンスそのものは保存しない。

## mainが進んだPRの再検証（`harness:reverify`）

他のPRがmergeされて`base_not_baseline`になったPRは、実装を作り直さずに再検証する（[ADR-0003](../../docs/adr/0003-reverify-after-main-update.md)）。

```text
元checkoutで最新のmainをpull（HEAD = origin/main の先頭 = 新baseline）
pnpm harness:reverify <PR URL>
  前提: PRがopen・同じrepository・branchがharness/<run-id>・baseがgithub.base
        PR HEADのSBI snapshotが、現在のSBI Issueと新baselineのTrusted Acceptance登録から組み立てたSBIと一致
        （一致しなければ停止。SBIが変わったので、新しいrunで実装する）
  → 新しいrun（kind: reverify）を新baselineから作り、PR HEADをmerge commitで取り込む（PR HEADが新baselineを含めば空commitだけ足す）
  → 差分（baseline..候補）のscope検査 → lane・Security・Risk・Gateを新baselineのルールで判定（Gate対象は承認を取り直す）
  → 実装Agentなしで Verifier → Security → Policy Reviewer → Completion Judge を1回
  → 新baselineがorigin/mainの先頭のまま、PR branchの先頭が取り込んだHEADのままなら、同じbranchへ通常push
  → GitHubから取り直してmerge判定 → PR本文を新run・新tested SHAへ更新
```

- 競合したら`REVERIFY_CONFLICT`で止まり、競合パスを表示する。PR branchで競合を解消してpushし、同じコマンドを再実行する。解消後のHEADは新しいrunで検証し直す。
- 検証に失敗したら`FAILED`で止まる。実装には戻らず、PRも更新しない。
- 候補commitは`Harness-Reverify-Run`と`Harness-Parent-Run`のtrailerを持つ。`verifyReverifyLink`がGitのobjectだけで、PR HEADと再検証runの関連を確かめる（#148の`merge-approval`が読む）。再検証runのmerge判定でもこの確認を必須にする。
- SBI snapshotとHarness-Run trailerは、SBIを実装したrun（親run）のまま。CIの`harness`の判定は変わらない。
- 旧runとその証跡・承認は変更しない。旧HEADへのApproveは数えないので、更新後のHEADでReviewを取り直す。
- 同じPR HEADと同じbaselineで再実行すると、同じrunを続ける。push後にPR本文の更新だけ失敗した場合も、再実行でpushを飛ばして本文の更新から続ける。

## PR本文

SBI（ID・タイトル・Issue URL・目的・受け入れ要件）、Run ID、tested SHA、Verifier・Securityの結果、Risk Level、必要なApproval人数、Evidenceの場所を載せる。
再検証したPRは、親run・旧tested SHA・baselineも載せる。本文は説明のためのもので、再検証runとPR HEADの関連の証明には使わない。
SBIの`issueUrl`は任意項目。秘密値が含まれていれば公開しない。raw prompt・Agentの生レスポンス・ログは載せない。
EvidenceはHarnessを実行したPCの`.harness/runs/<run-id>/`にあり、PRには添付しない。

## 制約

- `harness:resume`は、元のcheckoutのHEADがrunのbaselineのままの間だけ動く（既存の`sourceIntegrity`）。待っている間に別のPRをpullしてHEADが動いたら、`harness:reverify`で新しいrunを作る。
- 実装Agent（codex / claude CLI）が人間と同じ`gh`の認証で動くと、人間名義でReviewできてしまう。Harnessではこれを検出できない。Agentを動かす環境には、GitHubの認証情報を渡さない。
- `harness:pr`のpushは、リポジトリのpre-push hookを通さない。hookが検査するのは操作者のcheckoutで、pushするcommitではないため。pushするcommitは、Harnessが検証したSHAそのもの。
- GitHub上のbranch protectionとRulesetは変更しない。mainのRulesetは人が適用する（[docs/workflows/github-ruleset.md](../../docs/workflows/github-ruleset.md)）。

## やらないこと

自動merge、`MERGED`の生成、Reviewの自動承認、Branch Protection / Rulesetの変更、PR作成後のコード自動修正（再検証での競合解消を含む）、force push。
