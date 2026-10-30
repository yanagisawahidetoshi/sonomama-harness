# ADR-0006: Production変更の起点を、決定的なルールによるchange-type判定で決め、Engineering Issueを必須にしない

- 状態: Proposed
- 日付: 2026-10-30
- 判断者: 未定
- 関連Issue: なし
- 関連SBI: なし
- 関連Design Docs: [docs/workflows/engineering-changes.md](../workflows/engineering-changes.md)、[.ai/workflows/ci.md](../../.ai/workflows/ci.md)
- Supersedes:
- Superseded by:

状態の意味とAIの扱いは[README](README.md)を参照する。Proposedの間は、AIはこのADRを決まったものとして実装や提案の根拠にしない。

## 背景

今は、Production（`lanes.json`の`productionPaths`、つまり`apps/`と`packages/`）を1ファイルでも変えるPRに、次のどれかの起点を必須にしている。

- 承認済みSBI IssueからのHarness Runとsnapshot
- `engineering`と`ready`のlabelが付いたEngineering Issueと、commitの`Engineering-Issue:` trailer
- trusted dependency bot（Renovate）の例外

この結果、`apps/admin/README.md`の1行を直すPRでも、Issueを作り、人がlabelを付けるまでCompletion Judgeが通らない（#185）。
Engineering Issueのlabelは人がPRのレビューと別に付ける承認で、中身もレビューと重なる。Harnessはlabelの有無を見るだけで、Issueの内容とdiffを照合しない。Product変更をEngineeringと偽っても、見抜くのはどのみちPRのレビューになる。
一方、L1の変更はSBIの承認後、できるだけ人の手を介さずに進める方針にしている（#182）。Engineering Issueを毎回求める運用はこれと合わない。

## 判断ドライバー

- 正解の定義（SBI → spec digest → spec approval → Trusted Acceptance）を持つべきProduct変更は、必ずSBIを通す
- AIの自己申告でGateを外さない（AGENTS.md）
- 人のタッチポイントを、判断が要る場面だけにする
- 判定できないものは、緩い側ではなく厳しい側へ倒す（fail-closed）

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| 現状維持（Production変更にSBIかEngineering Issueを必須） | PRのレビューと承認が二重になる。Issueの内容は照合しないので、偽装の防止にもならない |
| 人がPRに`engineering` labelを付けたらEngineeringとする | L1の技術変更でも毎回人の操作が要る。#182の方針と合わない |
| LLMがdiffを読んでProduct / Engineeringを判定する | AIの自己申告でGateを外すことになる |
| Ambiguousのたびに人へ質問する | 人のタッチポイントが増える。答えがない間の扱いも決める必要がある |
| `apps/`・`packages/`のMarkdownだけをProductionから外す | 依存更新・Storybook・テスト基盤などの技術変更が残り、Engineering Issueの問題は解消しない |

## 決定

未決定。現時点の提案は次のとおり。

### 判定のしくみ

- Production変更を含むPRに、Harnessがchange-typeを`product`・`engineering`・`ambiguous`のどれかで付ける。
- 判定に使うのは、パス、ファイルの種類、diffの内容に対する決定的なルールだけとする。LLMの判定、PR本文、commit message、ブランチ名、「refactor」などの自己申告は使わない。
- ルールはファイルごとに当てる。Production配下の変更ファイルがすべてEngineeringのルールに当たるときだけ、PRを`engineering`にする。1ファイルでも当たらなければ`ambiguous`にする。
- `ambiguous`は人に質問せず、`product`として扱う（fail-closed）。SBIが無ければCompletion JudgeはFAILする。
- ルールは`.harness/rules/`に置く。Agentは書き込めず、変更は既存のHuman Gateの対象になる。
- 判定の結果と根拠は、harness jobのログに`Change type:`の行で出す。どのファイルがどのルールに当たったか、どのファイルで`ambiguous`になったかを書く。

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

次のものはProductとして扱い、SBIを必須にする。

- `apps/**/src/**`（上の表のStorybookとテストを除く）
- `apps/api/app/**`、`apps/api/config/**`、`apps/api/db/**`、`apps/api/lib/**`
- その他、Productionの実行時に入るコードと設定
- 依存の追加・削除（Railsのgemのように、追加するだけで実行時の挙動が変わるものがある）
- 「refactor」と称していても、本番の挙動に入るファイルを変えるもの

「refactorだからEngineering」「AIがEngineeringと判断した」という理由ではGateを外さない。

### Engineering Issueの位置づけ

- Engineering Issueは必須にしない。複数のPRにまたがる作業や、後から追いたい基盤作業を管理するときに任意で使う。
- `ambiguous`の変更を、SBIを作らずEngineeringとして扱いたいときだけ、人の明示的な判断を例外として受け付ける。手段は今のEngineering Issue（`engineering`と`ready`のlabel、`Engineering-Issue:` trailer）をそのまま使う。
- 人に毎回`engineering` labelを付けさせる工程は作らない。

### 変えないこと

- change-typeが決めるのは、Production変更の起点としてSBIが要るかどうかだけ。Verifier、Security Verifier、Risk Level、Human Gate、PRのHuman Reviewの判定は変えない。
- PRがSBIのsnapshotや`Harness-Run:`・`SBI-Issue:`のtrailerを持つ場合は、change-typeにかかわらず今と同じSBIの検査を行う。
- trusted dependency botの例外は残す。

## 理由

- SBIが守っているのは「正解の定義」で、Product変更にしか意味がない。技術変更にSBIやIssueを求めても、守るものが増えない。
- 偽装を防ぐのはIssueの有無ではなく、diffがProductの領域に触れていないかの判定である。この判定をルールで機械的に行えば、Issueより強く、人の手間も減る。
- ルールで言い切れないものを`product`に倒すので、判定の漏れはSBIを余計に求める方向にしか出ない。

## 影響

### Positive

- README・依存更新・Storybook・テストだけのPRが、Issueもlabelも無しでCompletion Judgeを通る。
- 判定の根拠がログに出るので、なぜSBIが要るのかをPRの作者がその場で分かる。
- Engineering Issueの偽装でSBIを避ける経路がなくなる。

### Negative / Trade-offs

- 本番コードのrefactorは、挙動が変わらなくてもSBIかEngineering Issueが要る。
- 依存のバージョン更新は、実行時の挙動を変えうるのにEngineeringになる。守りはVerifierとPRのレビューに頼る。
- テストの削除・弱体化もEngineeringになる。ACの判定はTrusted Acceptanceが別に持つので影響しないが、Application Testの網羅はPRのレビューに頼る。
- `apps/**`のREADMEには、AIが実装時に守る制約が書かれている。これを変えるPRもEngineeringになり、確認はPRのレビューに頼る。
- ルールの保守が要る。新しい種類のファイルは、ルールに足すまで`ambiguous`になる。

## 実装・運用への影響

- Completion Judgeの起点の判定（`tools/harness/impact.mjs`、`tools/harness/sbi-source.mjs`、`tools/harness/engineering-source.mjs`）に、change-typeの判定を入れる。テストを先に書く。
- `.harness/rules/`に判定ルールを追加する。`policy.json`の保護パスとHuman Gateの対象になる。
- `docs/workflows/engineering-changes.md`と`.ai/workflows/ci.md`の「Production変更の起点」を書き換える。
- Security rule（SEC-*）の対象範囲は変えない。

## 検証方法

- 判定の単体テストで、上の表のEngineeringの例が`engineering`に、Ambiguousの例が`ambiguous`になることを確かめる。
- EngineeringとAmbiguousのファイルが混じったPRが`ambiguous`になり、SBIが無ければFAILすることを確かめる。
- commit messageやPR本文に「refactor」「engineering」と書いても判定が変わらないことを確かめる。
- #185（`apps/**`のREADMEだけの変更）が、Issue無しでCompletion Judgeを通ることを確かめる。

## 再検討条件 / 撤回条件

- Engineeringと判定されたPRで、本番の挙動が変わる事故が起きたとき
- `ambiguous`からEngineering Issueでの例外が頻発し、人のタッチポイントが減らないとき

## 関連資料

- #182（L1のAuto Mergeを許可する方針）。Auto Mergeの実装（#157、#175）とは独立に進める
- #185（`apps/**`のREADMEの変更で、Completion Judgeが起点不足でFAILした例）
- [ADR-0005](0005-generated-trusted-acceptance.md)（SBIからTrusted Acceptanceを作る流れ）

ADRへの変更はHuman Gate対象。AIだけで確定しない。
