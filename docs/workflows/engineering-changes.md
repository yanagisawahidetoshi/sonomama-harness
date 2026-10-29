# Engineering Change の扱い

Production領域（`apps/` / `packages/`）の変更を、すべてSBIにする必要はない。

## 変更の種類

| 種類 | 例 | 必要な起点 |
| --- | --- | --- |
| Product implementation | 新機能、仕様変更、ユーザー挙動の変更 | 承認済みSBI Issue + `harness:run` + SBI snapshot |
| Engineering change | dependency、refactor、tooling、Storybook、build設定、Design System導入など、プロダクト仕様を直接変更しない技術変更 | 承認済みEngineering Issue |
| Docs / non-production | docs、prototype、Harness maintenance等 | SBI / Engineering Issueは不要 |

Engineering changeでもVerifier、Security、Risk、Human Reviewは通常どおり実行する。免除するのはSBI snapshotだけ。

## Engineering Issue

Engineering changeとして扱うかは、人がIssueのlabelで決める。PR本文・commit message・Issue本文に「engineering」と書いても通らない。

1. 変更内容を書いたIssueを作る（例: #123 Sparkle Design導入）。
2. 人が内容を確認し、`engineering` と `ready` のlabelを付ける。labelを付けられるのはtriage以上の権限を持つ人だけ。
3. PRのcommitのどれかに、次のtrailerを入れる。

```text
Engineering-Issue: https://github.com/<owner>/<repo>/issues/<number>
```

Completion JudgeはGitHub APIでIssueを読み、次をすべて満たすときだけ通す。1つでも欠ける、またはIssueを読めないときはFAILする（fail-closed）。

| 確認 | 内容 |
| --- | --- |
| リンク | PRのcommit trailerで、このリポジトリのIssueを1件だけ指す。別のIssueを複数指すとFAIL |
| Issueであること | open。Pull Requestの番号ではない（PRが自分自身を承認できないようにする） |
| label | `engineering` と `ready` がある。`needs-review` と `sbi` がない |

## SBIの主張がある場合

次のどれかがあるPRは、Engineering Issueがあっても必ずSBIとして判定する。壊れたSBI snapshotや、snapshotの無いRunをEngineering Issueで通すことはできない。

- `.harness/state/sbi-*.json` の追加・変更・削除
- commit messageの `Harness-Run:` または `SBI-Issue:`（trailerとして読めない位置にあっても数える）

## 判断に迷ったら

HarnessはIssueの内容から、Product implementationかEngineering changeかを判定できない。`engineering` labelを付ける人とPRのHuman Reviewが判断する。プロダクト仕様・ユーザー挙動を変える場合や、迷う場合はSBIを使う。

判定結果はharness jobのログの `Engineering source check:` 行に出る。
