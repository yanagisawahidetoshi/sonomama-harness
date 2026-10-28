# API Mock Serverを起動する

Rails APIの完成を待たずにFrontendを開発できるように、承認済みのOpenAPIからローカルのMock Serverを起動する。Mock用に別のAPI仕様は持たず、API仕様の基準となるファイル（SSOT）`packages/api-schema/openapi.yaml`を、Prismでそのまま提供する。

```text
pnpm api:mock <Issue URL>
  → planner:api-schema-status と同じ判定（署名付き承認台帳）でAPPROVEDか確認
  → 承認済みProposalの openapi.yaml と packages/api-schema/openapi.yaml のdigestを照合
  → 一致: Prism（static mode）を 127.0.0.1:4010 で起動
  → 不一致・未承認: 起動せず exit 1 で理由を表示
```

## 手順

1. API仕様の案（Proposal）を人が承認する（手順は[.ai/workflows/api-schema.md](../../.ai/workflows/api-schema.md)）。
2. 承認済みの`.harness/api-schema/<number>/openapi.yaml`を整形せずに`packages/api-schema/openapi.yaml`へコピーする。1バイトでも違えば起動しない。
3. `pnpm api:mock https://github.com/<owner>/<repo>/issues/<number>`を実行する。Ctrl+Cで停止する。
4. FrontendはAPI Base URLを環境変数で`http://127.0.0.1:4010`に切り替える。Mock ServerはExpo / React Admin固有のロジックを持たない。

`--dynamic`を付けると、Prismがschemaからランダムな値を生成する。既定のstatic modeはexampleを使い、exampleがなければschemaから値を作る。応答は毎回同じになる。

## 認証

`security: [bearerAuth]`のendpointは、`Authorization`ヘッダにBearer形式の任意の値（例: 値を`mock-token`にする）を付ければ2xxを返す。付けなければ401と共通の`Error`を返す。JWTは検証しないので、実際の認証ProviderのtokenやCredentialは使わない。

## 起動を拒否する条件

- `planner:api-schema-status`がAPPROVEDでない。`api-schema-approved`ラベルは判定に使わない。
- `packages/api-schema/openapi.yaml`がない。`openapi.json`や`openapi.yml`がある。複数ある。
- `packages/api-schema/openapi.yaml`と承認済みProposalの`openapi.yaml`のdigestが一致しない。
- `#`で始まらない`$ref`がある。Prismが外部のファイルやURLを読みに行くのを防ぐ。

## 制約

- 同じPCでのみ起動できる（MVP）: 生成記録と承認台帳はGit管理外のため、Proposalを生成・承認したPCでしか承認を判定できない。恒久仕様にはせず、認証済みApproval Adapterへ移すときに別PCへ対応する。
- SSOTと一致するのは最後に反映した承認済みProposalだけ。Proposalは既存OpenAPIへマージした全体を出すので、古いIssueのURLでは起動できない。
- Prismは`@stoplight/prism-cli@5.14.2`に固定している。5.15以降はNode 24以上が必要なため。
- proxy modeは使わない。Rails API・認証Provider・本番APIへは接続しない。

## やらないこと

Frontend API clientの生成、Statefulな業務ロジックの再現、認証Providerの実JWT検証、別PCでの承認判定。
