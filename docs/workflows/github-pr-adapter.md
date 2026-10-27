# GitHub PR Adapterの運用

Harnessが検証したcommitを、そのままGitHub PRとして公開する。実装後のMerge Approvalは、そのPRへのGitHub Reviewで判定する（[ADR-0001](../adr/0001-github-review-merge-approval.md)）。
Harnessが出すのは`MERGE_ALLOWED`まで。mergeは人間がGitHubで行う。

```text
harness:run → executionStatus=DONE
  → pnpm harness:pr --run RUN_ID
      run baselineが origin/main に含まれるか確認 → 差分とPR本文の秘密値を検査
      → tested SHAを harness/<run-id> にpush（force pushしない）→ PRを作成（既存のopen PRがあれば再利用）
  → GitHub上で CI と Review
  → pnpm harness:resume --run RUN_ID（実行のたびにGitHubから取り直して判定）
      PR open かつ tested SHA = PR HEAD SHA かつ 必須CI PASS
      かつ CHANGES_REQUESTEDなし かつ Riskごとの人数のApproveあり → MERGE_ALLOWED
```

## 2つのモード

| モード | 実装後Merge Approvalの正本 |
| --- | --- |
| GitHub PR mode（`harness:pr`を実行したrun） | GitHub Review。`harness:approve --phase merge`は拒否する |
| Local mode（PRを作っていないrun、demo） | ローカル署名台帳（`harness:approve --phase merge`） |

2つの方式を同時には要求しない。API Schema Approval、Design Approval、実装前Gateは、どちらのモードでもローカル署名台帳を使う。

## 判定

- **PR**: closeまたはmergeされていればBLOCKED。Harnessが`MERGED`を生成することはない。
- **SHA**: PR HEADがtested SHAと違えばBLOCKED（`tested_sha_mismatch`）。PRへ追加pushした場合は、新しいrunで検証し直す。
- **CI**: 必須checkは、`.harness/config/harness.json`の`github.requiredChecks`と、base branchのRulesetにあるrequired status checksの和集合。
  PR HEADに対する最新のcheck runがすべてsuccessのときだけPASSとする。skipped / neutral / cancelled、またはcheckがない場合はPASSにしない。
  必須checkが1つもなければNOT_CONFIGUREDとしてBLOCKEDにする。
- **Review**: userごとに最新のReviewを使う。
  - APPROVEDは、tested SHAに対するものだけを数える。
  - CHANGES_REQUESTEDは、対象SHAにかかわらず、再レビューされるかdismissされるまでブロックする（REJECTED）。
  - COMMENTEDは判定を変えない。botとPR作成者は数えない。
- **人数**: LEVEL 1は0人、LEVEL 2は1人、LEVEL 3は異なる2人以上。PR作成者（`harness:pr`を実行した`gh`のアカウント）以外がReviewする。
- GitHubを読めなければBLOCKED（`github_state_unavailable`）とする。runはESCALATEDにしないので、`harness:resume`で再判定できる。

`github-state.json`は、判定に使ったGitHubの状態の要約（PR・CI・Review）。正本はGitHub。APIのレスポンスそのものは保存しない。

## PR本文

SBI（ID・タイトル・Issue URL・目的・受け入れ要件）、Run ID、tested SHA、Verifier・Securityの結果、Risk Level、必要なApproval人数、Evidenceの場所を載せる。
SBIの`issueUrl`は任意項目。秘密値が含まれていれば公開しない。raw prompt・Agentの生レスポンス・ログは載せない。
EvidenceはHarnessを実行したPCの`.harness/runs/<run-id>/`にあり、PRには添付しない。

## 制約

- `harness:resume`は、元のcheckoutのHEADがrunのbaselineのままの間だけ動く（既存の`sourceIntegrity`）。待っている間に別のPRをpullしてHEADが動いたら、新しいrunを作る。
- 実装Agent（codex / claude CLI）が人間と同じ`gh`の認証で動くと、人間名義でReviewできてしまう。Harnessではこれを検出できない。Agentを動かす環境には、GitHubの認証情報を渡さない。
- GitHub上のbranch protectionとRulesetは変更しない。mergeを機械的に止めたい場合は、GitHub側で設定する。

## やらないこと

自動merge、`MERGED`の生成、Reviewの自動承認、Branch Protection / Rulesetの変更、PR作成後のコード自動修正。
