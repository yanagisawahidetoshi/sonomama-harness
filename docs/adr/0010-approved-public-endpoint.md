# ADR-0010: 承認済み仕様で認証不要とした新規endpointの追加を、認証の変更とみなさない

- 状態: Proposed
- 日付: 2026-11-01
- 判断者: 柳沢英俊（方針は Issue #243 で決定）
- 関連Issue: #243、#218、#237、#166
- 関連SBI: #232
- 関連Design Docs: [docs/security/authorization.md](../security/authorization.md)
- Supersedes: なし
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。Proposedの間は、AIはこのADRを決まったものとして実装や提案の根拠にしない。

## 背景

SEC-AUTH-001 は、OpenAPI の `security` キーの行が変わると認証の変更とみなし、LEVEL 3 と Human Gate を求める（#177・#218）。
一方で、SBI の本文の「認証不要」は、認証の変更として検出しない（#237）。
そのため、認証不要の新規 endpoint を契約に足す SBI #232 は、承認後の run で `security: []` を書いた時点で NEW_SECURITY_SCOPE として止まった。AC を満たす実装は必ず止まる。

## 判断ドライバー

- 既存の認証を弱める変更は、仕様承認とは別に必ず人が判断する
- 最初から公開と決めて承認した新規 endpoint に、同じ判断を重ねない
- 区別できない変更は止める（fail-closed）

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| `security: []` を含む変更を一律に LEVEL 3 にする（現状） | 承認済みの公開 endpoint の新設まで止まり、仕様承認と同じ判断を人に二度求める |
| 仕様に「認証不要」とあれば、SBI の段階で SEC-AUTH-001 にする | 承認した公開 endpoint の新設に、AuthN の LEVEL 3 承認を重ねることになる |

## 決定

次をすべて満たす OpenAPI 契約の変更は、`security` キーの行を SEC-AUTH-001 の検出から除き、通常の承認フローで進める。

- 追加した operation の `security` が空配列で、変更前の契約にはその operation が無い。
- 先頭の `security` と `components.securitySchemes` が変わらない。
- 既存の operation は、`security` を含めて変わらない（削除もしない）。
- 承認済みの SBI が、その operation を1つの文で名指しし、認証不要であること、または `security: []` を求めていることを書いている。SBI が名指ししていない公開 operation が1つでもあれば除かない。

次の変更は、これまでどおり SEC-AUTH-001 として LEVEL 3 の Human Gate にする。

- 既存 endpoint の認証の解除・変更・削除
- 先頭の `security` や security scheme など、共通の認証設定の変更
- 承認された公開範囲の拡大（SBI が名指ししていない公開 endpoint の追加）

変更前後の契約を parse できない、変更前の内容が分からない、契約以外のファイルである、などで区別できない場合は除かずに止める。`security` キー以外の語（`bearerAuth`、`jwt` など）、ファイル名による検出、他の rule はそのまま適用する。

## 理由

公開する endpoint を新しく作るかどうかは、SBI の仕様承認で人が判断している。既存の認証を弱める変更や共通設定の変更は、その SBI だけでは影響範囲を判断できないので、別に人が判断する。
API Schema Planner の Security Impact も、新規の公開 endpoint は AuthN の影響にせず、認証必須の endpoint を公開へ変える変更を影響とする（`tools/harness/api-schema-security.mjs`）。判定をこれに揃える。

## 影響

### Positive

- 認証不要と承認した新規 endpoint の SBI が、run の途中で止まらない。

### Negative / Trade-offs

- SBI の承認が、その endpoint を公開する判断を兼ねる。SBI のレビューで公開範囲を確かめる必要がある。
- 実装前の判定（preflight）は、許可ファイルの今の内容を変更として読む。既存の契約に `security` や `securitySchemes` があると、公開 endpoint を足すだけの SBI でも実装前に SEC-AUTH-001 になる。これはこの ADR では変えない。

## 実装・運用への影響

- `.harness/rules/security.json` の SEC-AUTH-001 に `publicOperationException` を置き、`tools/harness/openapi-public-operation.mjs` が変更前後の契約を比べる。
- run（実装の提案時と完了時）と CI は、契約ファイルの変更前後の全文を判定に渡す。

## 検証方法

- 承認済み SBI が名指しした新規の公開 operation は、SEC-AUTH-001 に当たらない。
- 既存 operation の `security` の変更・削除、先頭の `security` や security scheme の変更、SBI が名指ししていない公開 operation の追加、parse できない契約は、SEC-AUTH-001 に当たる。

## 再検討条件 / 撤回条件

- 公開 endpoint の追加で事故や意図しない公開が起きたとき
- 公開範囲を SBI の本文ではなく構造化した宣言（API Schema の `authN` など）で承認するようになったとき

## 関連資料

- Issue #243、#218、#237
- [docs/security/authorization.md](../security/authorization.md)
