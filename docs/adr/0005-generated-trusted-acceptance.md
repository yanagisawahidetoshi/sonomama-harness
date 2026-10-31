# ADR-0005: Trusted Acceptanceを、人が承認した仕様からrunの中で生成・検査・登録し、実装PRに同梱する

- 状態: Accepted（2026-10-30、柳沢英俊が承認）
- 日付: 2026-10-30
- 改訂: Accepted（PR #200 のマージで承認。2026-10-31、#194の決定に合わせてspec digestの対象とlegacy `ready`の扱いを改めた）
- 判断者: 柳沢英俊（判断点は Issue #147 で決定済み。状態を Accepted にするのは判断者）
- 関連Issue: #147、#168、#194
- 関連SBI: なし
- 関連Design Docs: [.ai/workflows/pbi-sbi-planner.md](../../.ai/workflows/pbi-sbi-planner.md)、[.ai/workflows/implementation.md](../../.ai/workflows/implementation.md)
- Supersedes:
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。

## 背景

今は、人が SBI Issue の受け入れ要件と Gherkin をレビューした後、AC ごとの Trusted Acceptance（合否を判定するテスト）を人が書いて登録し、`ready` を付けてから実装が始まる。
人がテストを手書きすることが開発を始める前提になっていて、速度を落としている。一方で、実装 Agent が自分でテストを書いて合格を名乗る形にはしたくない。

## 判断ドライバー

- 人は仕様（受け入れ要件・Gherkin）の確定だけを行い、テストを手書きしない
- AI の自己申告や常に成功するテストで AC を満たしたことにしない
- テストの生成と実装を分け、実装 Agent が保護されたテストを変えられないこと
- 開発の速度（登録のための別 PR や一律の追加承認を作らない）

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 生成したテストを別の「登録 PR」で先に main へ入れる | `.harness/**` の変更なので L3 になり、すべての SBI で追加の承認が要る。速度の目的に反する |
| 生成 Agent に `.harness/verification` への書き込み権限を与える | 候補の生成と、信頼する登録を分けられない |
| 仕様の承認を `ready` label のまま使う | 「登録済み」と「仕様確定」を区別できず、順序が循環する |
| label だけで仕様の承認とみなす | label だけでは内容（digest）に結びつかない。legacy `ready` は、付けた人と時点を GitHub の監査履歴で確かめて内容に束縛する（#194） |

## 決定

- **仕様の承認と、テストの準備を分ける。**
  - 仕様の承認の正本は、SBI Issue への `harness-spec: <spec digest>` コメントにする。write 以上の権限を持つ人間が投稿したもので、編集されていないものだけを数える。撤回は `harness-spec-revoke: <spec digest>`。
  - spec digest は、Agent への指示・Risk・Security 分類・実行範囲に使う承認対象の情報全体を正規化したテキストの sha256。今は title・目的・種類・受け入れ要件・Gherkin・想定変更範囲・想定変更ファイル数・検証方法・Risk / Security Impact を含む（#194 で title・目的・種類・想定変更ファイル数・検証方法を追加）。どれかが変われば、それまでの承認は無効になる。チェックボックスの状態は含めない。runが新しい項目を読むようになったら、その項目も digest に入れる。
  - `spec-approved` label は表示用だけで、判定には使わない。
  - `ready` は生成方式の仕様承認には使わない。version 1 の手書き Trusted Acceptance を登録した SBI の legacy 互換経路としてだけ残す。
  - legacy `ready` では「label が付いていること」だけを信用しない（#194）。write 以上の権限を持つ人間（bot は数えない）が `ready` を付けた時点の Issue 内容を、GitHub の監査履歴（timeline の `labeled`・`renamed` と本文の編集履歴）に束縛する。最後に `ready` を付けた人で判定し、権限や付けた人を読めなければ無効にする。`ready` の後に本文か title が変わった場合は、A→B→A で元に戻しても無効にする。再承認は `ready` を外して付け直すことで行う。
- **生成と検査は二段階（G / I）にする。** 生成時点で「完成した実装に対して PASS」を求めない。G（生成時）で、制御した違反を検出できることを確かめ、I（実装後）で完成した実装を検証する。
- **生成したテストは実装 PR に同梱する。** 専用の acceptance test のディレクトリに置き、実装 Agent からは書き換えられないように保護する。
- **L3 の floor を外すのは、main 側の信頼できる CI で G / I を再検証して PASS したときだけにする。** ローカルの証跡だけでは外さない。main 側で判定する CI（#168）ができるまでは、生成した登録を含む PR は L3 のままにする。
- **CI での実行場所:** PR のコードを実行する部分は、secret なし・network を遮断したコンテナで動かす。判定する側は生成物を実行せず、厳格な結果 schema だけを読む。
- **進める順番:** 仕様の承認（この ADR と同じ PR）→ 生成と品質検査 → 登録・保護と CI 接続 → Rails の adapter（実 AI で Rails の SBI を1件通す）→ mobile・admin の adapter。

## 理由

人の役割を「仕様を決めて承認する」ことに絞れば、テストの手書きを待たずに開発を始められる。承認を digest に結びつけるので、仕様が変われば古い承認や古いテストは使われない。
G / I の二段階にすれば、まだ実装が無い時点でもテストの検出能力を確かめられる。

## 影響

### Positive

- 人がテストを手書きしなくても、承認した仕様から実装を始められる。
- 仕様の変更が、承認とテストの両方を自動で無効にする。

### Negative / Trade-offs

- 生成したテストの妥当性の最終確認は、PR Review に残る。品質検査はヒューリスティックで、完全な保証ではない。
- main 側の CI（#168）ができるまでは、生成した登録を含む PR は L3 のまま。
- adapter の無い種類の SBI は、生成できずに止まる。

## 実装・運用への影響

- `pnpm harness:spec-approve <SBI Issue URL>` で、仕様の承認をコメントとして投稿する（投稿者は実行した人の `gh` のアカウント）。
- `harness:run` は、`ready` が無くても、現在の spec digest に有効な承認があれば新方式として扱う。生成が実装されるまでは、新方式の run は「生成がまだ無い」と明示して止まる（fail-closed）。
- Trusted Acceptance の registration は version 2 になり、spec digest と生成したテストの digest を持つ（生成の PR で入れる）。

## 検証方法

- 仕様の項目を変えると spec digest が変わり、古い承認では run が始まらない。
- 編集されたコメント、bot、read 権限、権限を読めない人、撤回された承認では始まらない。
- legacy `ready`: bot・write 未満の人が付けた、付けた人や権限を読めない、付けた後に本文か title が変わった（A→B→A を含む）ときは、`harness:run`・`harness:reverify`・CI のどれでも通らない。
- 生成の PR 以降: 制御した違反を検出できないテストは登録されない。登録後のテストの改変を CI で検出する。

## 再検討条件 / 撤回条件

- 生成したテストの品質が実運用で足りず、人のレビューの負担がかえって増えたとき
- main 側の CI（#168）の方式が決まったとき（L3 の扱いを見直す）

## 関連資料

- Issue #147（設計案と判断点）、#168、#194（legacy `ready` の束縛とspec digestの対象）

ADRへの変更はHuman Gate対象。AIだけで確定しない。
