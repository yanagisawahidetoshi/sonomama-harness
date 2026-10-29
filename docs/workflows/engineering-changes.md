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

Engineering Issueは、Issue本文に次の節を持つ。

```md
## 種類
engineering
```

さらにIssueは次を満たす必要がある。

- open
- `ready` labelあり
- `needs-review` labelなし
- `sbi` labelなし

PRのcommitのどれかに、次のtrailerを入れる。

```text
Engineering-Issue: https://github.com/<owner>/<repo>/issues/<number>
```

Completion JudgeはGitHub APIでIssueを読み、上の条件を確認する。読めない・別repository・複数Issue・条件不一致の場合はfail-closedで停止する。

Engineering IssueはProduct implementationをSBIから逃がすための経路ではない。プロダクト仕様・ユーザー挙動を変更する場合は従来どおりSBIを使う。曖昧な場合はSBIを選ぶ。
