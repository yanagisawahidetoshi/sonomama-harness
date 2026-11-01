# ADR-0009: SBIの仕様承認とPBIの構成承認を、GitHub Issueのラベルで行う（MVP）

- 状態: Accepted（2026-11-01、柳沢英俊が承認）
- 日付: 2026-11-01
- 判断者: 柳沢英俊（方針は Issue #239 で決定）
- 関連Issue: #239、#147、#166
- 関連SBI: なし
- 関連Design Docs: [.ai/workflows/pbi-sbi-planner.md](../../.ai/workflows/pbi-sbi-planner.md)
- Supersedes: [ADR-0005](0005-generated-trusted-acceptance.md) の「仕様の承認の正本」と「`spec-approved` label は表示用」の2点だけ
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。Proposedの間は、AIはこのADRを決まったものとして実装や提案の根拠にしない。

## 背景

SBI の仕様承認と PBI の構成承認には、人が `pnpm harness:spec-approve` / `pnpm harness:pbi-plan-approve` を打ち、承認コメントを投稿する必要があった。
#166 の Golden Path では、承認のたびに人が CLI を打つことが開発の流れを止めた。今は merge 権限を持つ人が1人で、承認者の本人性や監査証跡を厳密に求める段階ではない。

## 判断ドライバー

- 人の操作を「Issue を読んでラベルを変える」だけにする
- 承認した仕様と生成した Trusted Acceptance の結びつき（spec digest）は保つ
- 監査基盤は、必要になった時点で別に作る

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 承認コメントを正本のまま、ラベルの付与で GitHub Actions がコメントを書く | 作者が bot になり、今の判定では承認として数えない。数えるには identity adapter の作り直しが要り、MVP の範囲を超える |
| GitHub Projects の Status で承認する | Projects への依存が増える。Issue 単体で状態が分からない |

## 決定

- SBI の仕様承認は、SBI Issue の `spec-approved` ラベルにする。人は GitHub 上で `needs-review` を外して `spec-approved` を付ける。`needs-review` が残っていれば run は始まらない。
- PBI の構成承認は、PBI Issue の `plan-approved` ラベルにする。`## SBI構成` と GitHub 上の SBI Issue が一致しなければ、ラベルがあっても PBI は完了しない。
- ラベルを付けた人・時刻は確かめない。`harness-spec` / `harness-pbi-plan` のコメントは承認として数えない。
- run は開始時点の Issue から spec digest を計算して Trusted Acceptance を生成する。生成後に仕様を編集すると、CI で生成済みの Trusted Acceptance が無効になる（ADR-0005 のまま）。
- ラベルは Planner がリポジトリに作るが、どの Issue にも付けない。CLI（`harness:spec-approve` / `harness:pbi-plan-approve`）は同じラベル操作をするものとして残す。
- 手書きの Trusted Acceptance（version 1）で使う `ready` の判定（付けた人の権限と、付けた後の編集の検出）は変えない。

## 理由

承認の手間を減らすことが今の目的で、承認者が1人の間は、付けた人を確かめなくても判断の主体は変わらない。生成したテストは spec digest に結びついたままなので、run の開始後に仕様が変われば検出できる。

## 影響

### Positive

- 人は Issue を読んでラベルを変えるだけで、次の工程へ進められる。

### Negative / Trade-offs

- write 権限のない人（triage）や、ユーザーの token を使う Agent がラベルを付けても承認になる。
- ラベルを付けた後、run を始める前に仕様を編集しても、承認は無効にならない。
- 承認と撤回の履歴は、GitHub の Issue timeline にしか残らない。

## 実装・運用への影響

- `harness:run` と Completion Judge（SBI source）は、生成方式の SBI で `spec-approved` ラベルを承認として読む。
- `harness:pbi-status` は `plan-approved` ラベルを PBI plan の承認として読む。
- 生成方式の SBI は、Agent を含め人以外がラベルを付けないことを運用で守る。

## 検証方法

- `spec-approved` が無い、または `needs-review` が残っている SBI では run が始まらない。
- `plan-approved` が無い PBI は完了しない。
- 承認コメントだけでは、どちらも承認にならない。

## 再検討条件 / 撤回条件

次のどれかになったら、承認者・時刻・digest を改ざんに強い形で記録する仕組みを別 Issue で作り、このADRを見直す。

- merge 権限を持つ人が増える
- L3 で異なる2人の承認を厳密に求める
- bot や Agent が merge や承認に関わる
- 監査要件が生じる

## 関連資料

- Issue #239
- [ADR-0005](0005-generated-trusted-acceptance.md)
