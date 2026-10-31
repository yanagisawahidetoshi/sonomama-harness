# ADR（設計判断の記録）

人間が承認した設計判断の一次情報を置く。主な読者は人間で、AIは重要な設計判断を確かめるときに参照する。
新しいADRは[0000-template.md](0000-template.md)をコピーし、番号を1つ進めて作る。

## 状態

| 状態 | 意味 | AIの扱い |
| --- | --- | --- |
| Proposed | 提案の段階。人間はまだ判断していない | 決まったものとして実装や提案の根拠にしない |
| Accepted | 判断者が承認した | 参照して実装・提案してよい。矛盾する変更をAIだけで行わない |
| Superseded | 後のADRに置き換えられた。`Superseded by`に後継を書く | 後継のADRに従う |
| Rejected | 検討して採らなかった | 根拠にしない。同じ案を出すときは、却下理由が解消したことを示す |

状態を変えるのは人間だけ。Acceptedにするときは、状態の行に日付と判断者を書く（例: `Accepted（2026-10-27、判断者名が承認）`）。

## 置き場所の分担

| 置き場所 | 内容 |
| --- | --- |
| `docs/`（ADRを含む） | 人間向けの設計意図・判断・要件 |
| `.ai/` | AIが実装時に守る短い制約と手順。ADRの本文は写さず、必要な制約だけをリンク付きで置く |
| `.harness/` | 機械が実行・検証・強制するルール |

## Human Gate

`docs/adr/`の変更は、新規作成・状態の変更・本文の修正を問わずレベル2になり、mergeに人1人のレビューが必要（`.harness/rules/security.json`のSEC-DESIGN-001、`pr-risk.json`の`adr`）。実装前の承認Gateは置かず、人はSBIまたはADRのPRで判断する（#175・#193）。異なる2人の承認は求めない（[ADR-0008](0008-default-risk-level-one.md)）。
本文が認証・認可・RLS・PIIなどに触れると、そのSecurity ruleにも当たり、レベル3・異なる2人以上の承認へ上がる（[docs/security/authorization.md](../security/authorization.md)）。
