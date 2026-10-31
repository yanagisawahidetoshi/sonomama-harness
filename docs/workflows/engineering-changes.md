# Engineering Change の扱い

Production領域（`apps/` / `packages/`）の変更で、SBIが要るかどうかはdiffのchange-typeで決める（[ADR-0006](../adr/0006-change-type-classification.md)）。Issueやlabelは要らない。

## change-type

Harnessは変更ファイルのパスと内容だけを見て、PRを次のどちらかに分ける。

| changeType | 条件 | SBI |
| --- | --- | --- |
| `engineering` | Production配下の変更ファイルが、すべてEngineeringのルールに当たる | 不要 |
| `ambiguous` | 1ファイルでもルールに当たらない | 必須（fail-closed） |

Engineeringのルールは[`.harness/rules/change-types.json`](../../.harness/rules/change-types.json)にある。

| ルール | 対象 |
| --- | --- |
| `markdown` | `apps/**`・`packages/**`の`*.md`。`apps/*/src/**`、`apps/api/app/**`、`apps/api/config/**`、`public/**`の下は除く |
| `lockfile` | `pnpm-lock.yaml`、`apps/api/Gemfile.lock` |
| `package-json-dependency-versions` | アプリの`package.json`で、既にある依存のバージョンだけが変わったもの |
| `gemfile-versions` | `apps/api/Gemfile`で、既にある`gem`行のバージョン指定だけが変わったもの |
| `storybook-stories` / `storybook-config` | `*.stories.tsx`、`.storybook/**` |
| `tests` / `test-config` | `*.test.ts(x)`、`apps/api/spec/**`、`jest.config.*`、`vitest.config.*`、`.rspec` |
| `lint-config` | `biome.json` |

次のものは`ambiguous`になる。

- `apps/**/src/**`、`apps/api/app/**`、`apps/api/config/**`、`apps/api/db/**`、`apps/api/lib/**`などの本番コード
- `tsconfig*.json`、`vite.config.ts`、`app.json`などビルド出力に効く設定
- 依存の追加・削除、`scripts`や`overrides`の変更
- symlink、バイナリ、modeの変更
- 「refactor」と称していても、本番の挙動に入るファイルを変えるもの

commit message・PR本文・ブランチ名・Engineering Issueは判定に使わない。`ambiguous`をSBIなしで通す例外は今のところない。

## 変えないこと

change-typeが決めるのはSBIの要否だけ。`engineering`でもVerifier、Security、Risk、Human Reviewは通常どおり実行する。
テストの変更は`engineering`だが、L1のAuto Mergeを安全にできるという意味は持たない。テストの削除や弱体化をL1から外すRisk / Policyの保護はまだ無い（ADR-0006のfollow-up）。

## Engineering Issue

Engineering Issueは必須ではない。複数のPRにまたがる作業や、後から追いたい基盤作業を管理するときに任意で使う。Completion Judgeは読まない。

## 判断に迷ったら

ルールに当たらないものは`ambiguous`になり、SBIを求められる。新しい種類のファイルをEngineeringにしたいときは、`.harness/rules/change-types.json`へのルール追加として人が判断する。

判定結果はharness jobのログの `Change type:` 行に出る。
