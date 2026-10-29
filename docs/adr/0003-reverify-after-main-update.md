# ADR-0003: main更新後は再実装せず、再検証runで既存PRを更新する

- 状態: Proposed
- 日付: 2026-10-30
- 判断者: 未定（設計案はIssue #144で柳沢英俊が承認済み。Acceptedへの変更は人が行う）
- 関連Issue: #144、#148
- 関連SBI: なし
- 関連Design Docs: [.ai/workflows/pull-request.md](../../.ai/workflows/pull-request.md)
- Supersedes: なし（[ADR-0001](0001-github-review-merge-approval.md)の「runを作り直す」を読み替える）
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。

## 背景

ADR-0001は、PRのbaseをrunのbaselineに固定し、mainが進んだら`base_not_baseline`でBLOCKEDにして、最新のmainからrunを作り直すと決めた。
旧runは`sourceIntegrity`と入力のdigestで固定されているため、resumeでは追従できない。新しいrunは実装工程から始まるので、
複数人が同じmainから開発すると、他のPRがmergeされるたびに完成済みの実装をAgentに作り直させることになる。
未検証の組み合わせ（mainとPR HEADのmerge結果）をmerge可能にしない点は維持したい。

## 判断ドライバー

- mergeされるコードとHarnessが検証したコードが一致すること（ADR-0001の条件を緩めない）
- 完成済みのコードと既存PRのReview・議論を捨てないこと
- force pushと承認の使い回しをしないこと
- 新しいrunとPR HEADの関連を、PR本文の記載だけでなく、Gitから検証できること（#148の`merge-approval`チェックが読む）

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 候補を新しいmainへrebaseする | PRブランチの更新にforce pushが必要になる。既存Reviewとcommitの対応も失われる |
| 旧runをresumeしてbaselineだけ差し替える | 署名済みstateとinputsを書き換えることになり、旧runの改ざんにあたる |
| PRを閉じて新しいPRを作る | Review・議論の文脈が切れる。重複PRの抑止とも相反する |
| base一致条件を外し、GitHubの「branchを最新に」に任せる | Harnessが検証していないmerge結果をmerge可能にしてしまう |

## 決定

- mainが進んだPRは、`pnpm harness:reverify <PR URL>`で再検証する。入口の正本はPR。旧runのローカル証跡は任意の参照で、あれば署名済みstateとtested SHAの一致を記録する。
- 新しいrun（`kind: reverify`）を作り、最新のmain（新baseline）からdetached worktreeを作って、PR HEADを`git merge --no-ff`で取り込んだcommitを候補にする。
  候補はPR HEADの子孫なので、PRブランチへは通常のpush（fast-forward）で更新できる。rebaseとforce pushは使わない。
- PR HEADがすでに新baselineを含む場合（人がPRブランチで競合を解消した場合）は、PR HEADのtreeをそのまま使い、関連付けのための空commitだけを上に足す。
  承認された設計案の「PR HEADをそのまま候補にする」に対する追加で、下記の関連付けを候補HEADに必ず持たせるために足した。
- 候補のcommitは`Harness-Reverify-Run: <新run>`と`Harness-Parent-Run: <SBIを実装したrun>`のtrailerを持つ。
  `verifyReverifyLink`（`tools/harness/reverify.mjs`）は、Gitのobjectだけから次を確かめる。#148の`merge-approval`はこれをmain側のコードで呼ぶ想定。
  - trailerがそれぞれ1つだけあり、run IDとして正しい
  - merge commitなら第1親が`merge-base(main, HEAD)`で、treeが両親のclean mergeと一致する。空commitなら親と同じtreeで、親がbaselineを含む
  - commitされたSBI snapshotの`runId`が`Harness-Parent-Run`と一致し、`Harness-Run`/`SBI-Issue` trailerを持つcommitが範囲内にある
  trailerはどちらもないHEADは「再検証ではない」（`NONE`）として扱い、通常のPRを失敗させない。
  この関連付けは改ざんを検出するためのもので、認証ではない。承認の根拠は引き続き、そのHEADへのGitHub Review。
- SBI snapshot（`runId`は実装run）とCIのsnapshot/trailer契約は変えない。PR HEADのsnapshotが、現在のSBI Issueと新baselineのTrusted Acceptance登録から組み立てたSBIと一致しなければ、再検証せずに停止し、新しいrunでの実装に戻す。
- 差分の判定対象は`baseline..候補`。上流mainの変更は含まない。人が競合解消で触れたファイルも含めて、SBIのscope外や予約パスがあれば検証前に停止する。
- 入力（config・rules・policy・Trusted Acceptance・Harnessのコード）は新baselineの元checkoutから取る。lane・Security・Risk・Gate要否も新baselineのルールで計算し直す。
- 実装前GateとDesign Approvalは、既存の束縛（`baselineSha`と新runの`inputsDigest`を含むcontext）どおり**毎回取り直す**。SBI・scope・Securityが変わらなくても引き継がない。
- 検証は実装Agentを呼ばずに1回だけ行う（Verifier → Security → Policy Reviewer → Completion Judge）。失敗したら`FAILED`で止め、実装に戻らず、PRも更新しない。
- 公開は、新baselineが`origin/main`の先頭のまま、かつPRブランチの先頭が取り込んだPR HEAD（または候補）のときだけ行う。
  push前に`PUSHING`を署名付きstateへ保存し、push後に`PUSHED`、merge判定とPR本文の更新後に`PR_UPDATED`とする。再実行は記録した段階から続ける。
- PR本文のmarker・Run ID・tested SHA・検証結果・Riskを新runの値に更新し、親run・旧tested SHA・baselineを足す。SBI・Issue・`Closes #N`・元PBIは維持する。
- 以後のmerge判定はADR-0001のまま。base=新baseline、PR HEAD=候補、候補への必須CI、候補へのApprove、有効なCHANGES_REQUESTEDなしがそろったときだけ`MERGE_ALLOWED`。旧HEADへのApproveは数えない。
  再検証runのmerge判定は、候補HEADの`verifyReverifyLink`がこのrunを指していることも必須checkにする。

## 理由

実装済みのコードを捨てずに、Harnessが検証していないmerge結果を許可しない状態を保てる。候補はPR HEADの子孫なので、force pushとPRの作り直しが要らない。
旧runは書き換えず、新runが新baselineの入力と承認で独立に判定するため、旧SHA・旧contextの検証結果や承認が新しい候補の合格根拠になることはない。

## 影響

### Positive

- 他のPRがmergeされても、Agentで再実装せずに同じPRを更新できる。
- PR HEADの関連付けをGitだけで確かめられるので、#148のrequired checkがローカルの証跡なしで再検証runを確認できる。

### Negative / Trade-offs

- mainが進むたびに、CIとApproveを取り直す点は変わらない。Gate対象のSBIは実装前承認も毎回取り直す。
- `assertBaseIsBaseline`の直後からpushまでの間にmainが進むと、候補はpushされるが`base_not_baseline`でMERGE_ALLOWEDにならない。この窓は閉じられない（候補自体は検証済み）。
- 操作者は先にmainをpullしておく必要がある（元checkoutのHEADが`origin/main`の先頭と一致しなければ開始しない）。
- trailerは誰でも書けるため、関連付けは認証にならない。Harnessが書いたことの証明はできない。

## 実装・運用への影響

- `pnpm harness:reverify <PR URL>`を追加する。手順は[pull-request.md](../../.ai/workflows/pull-request.md)。
- GitHub PR Adapterに、PR本文の更新（`PATCH /pulls/{number}`）を追加する。
- run stateに`kind: reverify`と`reverify`（親run、旧tested SHA、snapshot digest、公開の段階、競合パス、旧runの照合結果）を追加する。escalation codeに`REVERIFY_CONFLICT`を追加する。
- API Schema Approvalは、`harness:run`の実行・merge判定の経路では参照していない（`api:mock`と旧API Schema Plannerだけが読む）。再検証でも同じで、契約の差分は`api-contract` Verifierが候補に対して実行し直す。
- GitHubのPRの`base.sha`は、mainが進んだ後にHEADがpushされると更新される（PR #131の観測による推定。GitHubの文書では未確認）。そのため`pull.baseSha === baseline`の条件は変えていない。

## 検証方法

`tools/harness/reverify.test.mjs`で、実GitとGitHub adapter（`gh`のstub）を使って次を確かめる。
AとBが同じmainから始めてAだけがmergeされた後、Bが実装Agentなしで再検証され同じPRへfast-forwardで更新されること、
mainの無関係な変更がBのscope判定に入らないこと、競合で停止し人の解消後に改めて検証されること、
Verifier失敗・古い承認・SHA不一致・CHANGES_REQUESTEDでMERGE_ALLOWEDにならないこと、検証中のmain・PR HEADの更新でpushしないこと、
再実行とpush後の記録失敗から復旧できること、`verifyReverifyLink`が偽のtrailerを拒否すること。

## 再検討条件 / 撤回条件

- #148で`merge-approval`の設計が決まり、関連付けの形式に追加の要件が出たとき。
- GitHubのPR `base.sha`がpush後に更新されないことが分かったとき（`mergeDecision`の条件をADRの修正として見直す）。

## 関連資料

- Issue #144（設計案と承認コメント）、#148（merge-approval）
- [ADR-0001](0001-github-review-merge-approval.md)

ADRへの変更はHuman Gate対象。AIだけで確定しない。
