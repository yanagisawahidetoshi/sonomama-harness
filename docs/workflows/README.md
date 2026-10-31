# 開発の流れ

PBI（プロダクトバックログの項目）を受け取ってからmergeするまでの流れを示す。コマンドや判定条件の詳細はAI向けの.ai/workflows/にある。

1. PBIを分ける: PBIをGitHub Issueに書き、AIに作業単位（SBI）へ分けさせる。分け方、受け入れ要件、セキュリティへの影響は人がレビューし、採用するSBIを決める。
2. APIの仕様を決める: APIの変更を伴うPBIでは、OpenAPIを変更する専用のSBI（Schema SBI）が作られる。通常のSBIと同じく人がレビューして実行し、Prismでモックを確認したPRをmergeしてから、それに依存するSBIを始める。
3. AIが実装し、Harnessが検証する: 人が承認したSBIは、認証・個人情報・データベースなど安全性に関わるものも、実装前の承認を重ねずにAIが実装する。自動の検証とAIレビューに通るまで、AIが修正を繰り返す。3回続けて失敗した場合や、承認済みのSBIでは決められない判断（範囲外の変更、新しい安全性の影響、仕様の矛盾など）が出た場合は止まり、人がSBIを直して承認し直す。
4. AIレビュー: 検証に通った変更は、リスクのレベルにかかわらずAIがレビューする。AIのレビューは人の承認の人数には数えない。
5. PRをレビューする: 検証に通ったcommitをPRにし、人がGitHubでレビューする。必要な承認の人数は変更のリスクで決まり、レベル1は0人、レベル2は1人、レベル3は別々の2人以上になる。
6. mergeする: Harnessが出すのは「mergeしてよい」という判定（MERGE_ALLOWED）と自動merge可否（autoMergeEligible）まで。レベル1で自動mergeできる判定のときだけ自動mergeしてよく、レベル2・3は人がmergeする。

Design System導入、dependency、refactor、tooling、Storybook、build設定など、プロダクト仕様を直接変更しないProduction領域の技術変更はSBIに分けず、[Engineering Change](engineering-changes.md)として承認済みIssueを起点にできる。Verifier・Security・Risk・Human Reviewは通常どおり行う。

デザイナーの試作（prototypes/）を本番に採用する場合は、試作のデザインを人が承認してから、新しいSBIで本番のアプリに実装し直す。試作が検証に通っても、本番の実装を承認したことにはならない。

## このディレクトリの手順書

- [api-docs.md](api-docs.md): API仕様をブラウザで見る
- [api-mock.md](api-mock.md): 承認済みのAPI仕様から、ローカルでモックサーバを起動する
- [database-migrations.md](database-migrations.md): マイグレーションをexpand/contractで進め、破壊的な操作を例外承認で通す
- [engineering-changes.md](engineering-changes.md): SBIを必要としないProduction領域の技術変更を扱う
- [dependency-updates.md](dependency-updates.md): AdminとRails APIのdependency更新をRenovateのPRで受け取る
- [github-ruleset.md](github-ruleset.md): mainのGitHub Rulesetを適用・確認する

## AI向けの詳しい手順

| 手順 | 文書 |
| --- | --- |
| PBIからSBIを作る | [.ai/workflows/pbi-sbi-planner.md](../../.ai/workflows/pbi-sbi-planner.md) |
| API仕様の案を作って承認する（内部機能。通常はSchema SBI） | [.ai/workflows/api-schema.md](../../.ai/workflows/api-schema.md) |
| Harnessで実装・検証する | [.ai/workflows/implementation.md](../../.ai/workflows/implementation.md) |
| PRを作ってレビューで判定する | [.ai/workflows/pull-request.md](../../.ai/workflows/pull-request.md) |
| CIで必要な検証を選んで実行する | [.ai/workflows/ci.md](../../.ai/workflows/ci.md) |
