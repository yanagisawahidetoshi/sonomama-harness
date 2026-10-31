# ADR-0006: Production変更の起点を、決定的なルールによるchange-type判定で決め、Engineering Issueを必須にしない

- 状態: Accepted（2026-10-30、柳沢英俊が承認）
- 日付: 2026-10-30
- 判断者: 柳沢英俊
- 関連Issue: なし
- 関連SBI: なし
- 関連Design Docs: [docs/workflows/engineering-changes.md](../workflows/engineering-changes.md)、[.ai/workflows/ci.md](../../.ai/workflows/ci.md)
- Supersedes:
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。

## 背景

今は、Production（`lanes.json`の`productionPaths`、つまり`apps/`と`packages/`）を1ファイルでも変えるPRに、次のどれかの起点を必須にしている。

- 承認済みSBI IssueからのHarness Runとsnapshot
- `engineering`と`ready`のlabelが付いたEngineering Issueと、commitの`Engineering-Issue:` trailer
- trusted dependency bot（Renovate）の例外

この結果、`apps/admin/README.md`の1行を直すPRでも、Issueを作り、人がlabelを付けるまでCompletion Judgeが通らない（#185）。
Engineering Issueのlabelは人がPRのレビューと別に付ける承認で、中身もレビューと重なる。Harnessはlabelの有無を見るだけで、Issueの内容とdiffを照合しない。labelはPRのHEADや変更内容に結びついていないので、Issueを承認した後にPRへ本番コードを足しても通る。
一方、L1の変更はSBIの承認後、できるだけ人の手を介さずに進める方針にしている（#182）。Engineering Issueを毎回求める運用はこれと合わない。

## 判断ドライバー

- 正解の定義（SBI → spec digest → spec approval → Trusted Acceptance）を持つべきProduct変更は、必ずSBIを通す
- AIの自己申告でGateを外さない（AGENTS.md）
- 人のタッチポイントを、判断が要る場面だけにする
- 判定できないものは、緩い側ではなく厳しい側へ倒す（fail-closed）

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 現状維持（Production変更にSBIかEngineering Issueを必須） | PRのレビューと承認が二重になる。Issueの承認はdiffやHEADに結びつかず、偽装の防止にもならない |
| 人がPRに`engineering` labelを付けたらEngineeringとする | L1の技術変更でも毎回人の操作が要る。#182の方針と合わない |
| LLMがdiffを読んでProduct / Engineeringを判定する | AIの自己申告でGateを外すことになる |
| ambiguousのたびに人へ質問する | 人のタッチポイントが増える。答えがない間の扱いも決める必要がある |
| ambiguousを、今のEngineering Issueで例外的にSBI無しにする | Issueの承認はdiffやHEADに結びつかない。承認後に足した本番コードも通ってしまう |
| `apps/`・`packages/`のMarkdownだけをProductionから外す | 依存更新・Storybook・テスト基盤などの技術変更が残り、Engineering Issueの問題は解消しない |

## 決定

### 判定のしくみ

- Production変更を含むPRのdiffに、Harnessが`changeType`と`requiresSbi`を付ける。diffの分類は次の2つだけとする。

| changeType | 条件 | requiresSbi | ログ |
| --- | --- | --- | --- |
| `engineering` | Production配下の変更ファイルが、すべてEngineeringのルールに当たる | false | `Change type: engineering / SBI not required` |
| `ambiguous` | 1ファイルでもEngineeringのルールに当たらない | true | `Change type: ambiguous / SBI required (fail-closed)` |

- `ambiguous`は「Productと判定した」ではなく「Engineeringと証明できなかった」を表す。別の値に変換せず、`changeType = ambiguous`のまま保持する。
- `ambiguous`で人には質問しない。SBIが無ければCompletion JudgeはFAILする。
- 判定に使うのは、パス、ファイルの種類、diffの内容に対する決定的なルールだけとする。LLMの判定、PR本文、commit message、ブランチ名、「refactor」などの自己申告は使わない。
- ログには、どのファイルがどのルールに当たったか、どのファイルで`ambiguous`になったかも書く。
- ルールは`.harness/rules/`に置く。Agentは書き込めず、変更は既存のHuman Gateの対象になる。

### SBI sourceは別の軸で扱う

change-type（diffが何を変えているか）と、SBI source（変更がどのSBIから来たか）は混ぜない。

- PRがSBIのsnapshot（`.harness/state/sbi-*.json`）を追加・変更・削除している場合は、change-typeにかかわらず、今のSBI sourceの検査（`sbi-source.mjs`）を行う。検査に失敗すればFAILする。
- `Harness-Run:`・`SBI-Issue:`のtrailerがあるだけでは、有効なSBI sourceとみなさない。trailerはchange-typeの判定にも使わない。snapshotの無いPRに残ったtrailerで、Engineeringのdiffが`ambiguous`になることも、`ambiguous`のdiffが通ることもない。
- `requiresSbi = true`のPRは、SBI sourceの検査に通ったsnapshotがあるときだけ通る。
- SBI sourceの検査に通った後だけ、ログに`Source: SBI #123`を別の行で出す。

### Engineeringと判定する変更（例）

明確にEngineeringと証明できるものだけを挙げる。

| 対象 | 条件 |
| --- | --- |
| `docs/**` | 今もProductionの外にあり、起点は要らない。変更しない |
| `tools/harness/**`、`.github/**`（CI設定） | 同上。Risk・Human Gate・保護パスの扱いは今のまま |
| `apps/**`・`packages/**`のMarkdown（`*.md`） | ビルドと実行に入らない場所にあるもの。`apps/*/src/**`、`apps/api/app/**`、`apps/api/config/**`、`public/**`の下は除く |
| 依存とlockfileの更新 | `pnpm-lock.yaml`、`apps/api/Gemfile.lock`。`package.json`は、既にある依存のバージョン指定だけが変わる場合。`scripts`・`overrides`・その他のキーが変わる、依存の追加・削除がある場合は除く。`Gemfile`は、既にある`gem`行のバージョン指定だけが変わる場合 |
| Storybook | `*.stories.tsx`、`.storybook/**` |
| テスト | `*.test.ts(x)`、`apps/api/spec/**`、`jest.config.*`、`vitest.config.*`、`apps/api/.rspec` |
| 開発ツール | linter・formatterの設定（`biome.json`など）。ビルド出力に効く設定（`tsconfig*.json`、`vite.config.ts`、`app.json`など）は除く |

次のファイルは、パスが上に当たっても`ambiguous`にする: 削除とrenameで、変更前のパスがEngineeringのルールに当たらないもの、symlink、バイナリ。

### Ambiguousとする変更（例）

次のものは`ambiguous`のまま、SBIを必須にする。

- `apps/**/src/**`（上の表のStorybookとテストを除く）
- `apps/api/app/**`、`apps/api/config/**`、`apps/api/db/**`、`apps/api/lib/**`
- その他、Productionの実行時に入るコードと設定
- 依存の追加・削除（Railsのgemのように、追加するだけで実行時の挙動が変わるものがある）
- 「refactor」と称していても、本番の挙動に入るファイルを変えるもの

「refactorだからEngineering」「AIがEngineeringと判断した」という理由ではGateを外さない。

### Engineering Issueの位置づけ

- Engineering Issueは起点の判定に使わない。`engineering`の変更には要らず、`ambiguous`の変更はEngineering Issueがあっても`requiresSbi = true`のままにする。
- Engineering Issueは、複数のPRにまたがる作業や、後から追いたい基盤作業を管理するときに任意で使う。
- 人に毎回`engineering` labelを付けさせる工程は作らない。
- 初期の実装では、`ambiguous`をSBI無しで通す例外を設けない。純粋なrefactorなどでSBI必須が実運用上の問題になったら、そのPRのHEAD SHAか変更内容のdigestに結びついた人の判断として、別のADRで設計する。

### テストの変更とRisk

- テストの変更は`engineering`になるが、これはSBIが要らないという意味だけを持つ。L1のAuto Mergeを安全にできるという意味は持たない。
- テストの削除、skip・pending・focus化（`.only`、`xit`、`fdescribe`、`:focus`など）、明白なassertionの弱体化は、Risk / Policy側でL1のAuto Mergeの対象から外す必要がある。
- [ADR-0008](0008-default-risk-level-one.md)（#157）で既定がLEVEL 1になり、テストの変更もL1になる。その前提として、`pr-risk.json`の`testProtection`がテストファイルの削除、skip・pending・focus化、assertionを含む行の削除をLEVEL 2へ上げる。
- 書き換えたassertionが弱くなったかどうか（`toBe(1)`を`toBeDefined()`にする等）までは判定しない。必要になったら別のIssueで足す。

### 変えないこと

- change-typeが決めるのは`requiresSbi`だけ。Verifier、Security Verifier、Risk Level、Human Gate、PRのHuman Reviewの判定は変えない。
- SBIのsnapshotを持つPRへのSBI sourceの検査の内容。
- trusted dependency botの例外は残す。

## 理由

- SBIが守っているのは「正解の定義」で、Product変更にしか意味がない。技術変更にSBIやIssueを求めても、守るものが増えない。
- 偽装を防ぐのはIssueの有無ではなく、diffがProductの領域に触れていないかの判定である。この判定をルールで機械的に、PRのdiffそのものに対して行う。
- ルールで言い切れないものは`requiresSbi = true`になるので、判定の漏れはSBIを余計に求める方向にしか出ない。

## 影響

### Positive

- README・依存更新・Storybook・テストだけのPRが、Issueもlabelも無しでCompletion Judgeを通る。
- 判定の根拠がログに出るので、なぜSBIが要るのかをPRの作者がその場で分かる。
- diffやHEADに結びつかないEngineering Issueの承認で、本番コードの変更がSBIを避ける経路がなくなる。

### Negative / Trade-offs

- 本番コードのrefactorは、挙動が変わらなくてもSBIが要る。例外の手段は初期の実装では用意しない。
- 依存のバージョン更新は、実行時の挙動を変えうるのに`engineering`になる。守りはVerifierとPRのレビューに頼る。
- テストの削除・弱体化も`engineering`になる。ACの判定はTrusted Acceptanceが別に持つので影響しない。L1から外す保護はfollow-upで作る。
- `apps/**`のREADMEには、AIが実装時に守る制約が書かれている。これを変えるPRも`engineering`になり、確認はPRのレビューに頼る。
- ルールの保守が要る。新しい種類のファイルは、ルールに足すまで`ambiguous`になる。

## 実装・運用への影響

- Completion Judgeの起点の判定（`tools/harness/impact.mjs`、`tools/harness/sbi-source.mjs`）に、`changeType`と`requiresSbi`の判定を入れる。テストを先に書く。
- `tools/harness/engineering-source.mjs`によるEngineering Issueの検査を、起点の判定から外す。
- `.harness/rules/`に判定ルールを追加する。`policy.json`の保護パスとHuman Gateの対象になる。
- `docs/workflows/engineering-changes.md`と`.ai/workflows/ci.md`の「Production変更の起点」を書き換える。
- follow-up: テストの削除・skip・pending・focus化・assertionの弱体化をL1から外すRisk / Policyの保護。
- Security rule（SEC-*）の対象範囲は変えない。

## 検証方法

- 判定の単体テストで、上の表のEngineeringの例が`engineering`に、Ambiguousの例が`ambiguous`になることを確かめる。
- `ambiguous`の結果が`changeType = ambiguous`、`requiresSbi = true`のままで、別の値に変わらないことを確かめる。
- snapshotの無いEngineeringのdiffに`Harness-Run:`・`SBI-Issue:`のtrailerが残っていても、`engineering`のまま通ることを確かめる。
- snapshotの無い`ambiguous`のdiffに、trailerだけがあってもFAILすることを確かめる。
- EngineeringとAmbiguousのファイルが混じったPRが`ambiguous`になり、SBIが無ければFAILすることを確かめる。
- `ambiguous`のPRに、`engineering`・`ready`のEngineering Issueとtrailerがあっても、SBIが無ければFAILすることを確かめる。
- commit messageやPR本文に「refactor」「engineering」と書いても判定が変わらないことを確かめる。
- ログに`Change type: engineering / SBI not required`か`Change type: ambiguous / SBI required (fail-closed)`が出て、`Source: SBI #<番号>`はSBI sourceの検査に通ったときだけ出ることを確かめる。
- #185（`apps/**`のREADMEだけの変更）が、Issue無しでCompletion Judgeを通ることを確かめる。

## 再検討条件 / 撤回条件

- `engineering`と判定されたPRで、本番の挙動が変わる事故が起きたとき
- 純粋なrefactorなどで`ambiguous`のSBI必須が実運用上の問題になったとき（HEAD SHAか変更内容のdigestに結びついた人の判断を、別のADRで設計する）

## 関連資料

- #182（L1のAuto Mergeを許可する方針）。Auto Mergeの実装（#157、#175）とは独立に進める
- #185（`apps/**`のREADMEの変更で、Completion Judgeが起点不足でFAILした例）
- [ADR-0005](0005-generated-trusted-acceptance.md)（SBIからTrusted Acceptanceを作る流れ）

ADRへの変更はHuman Gate対象。AIだけで確定しない。
