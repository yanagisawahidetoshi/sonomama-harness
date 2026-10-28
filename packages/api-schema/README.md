# API Schema
OpenAPI 3.1を唯一の契約定義（SSOT）とし、`openapi.yaml`か`openapi.json`のどちらか1つに置く。
Railsの契約検証と、Expo / admin向けの型生成は、同じスキーマを参照する。

API Schema Plannerは`.harness/api-schema/<issue-number>/openapi.yaml`にProposalを出す。
`pnpm planner:api-schema-status <Issue URL>`がAPPROVEDになった後に、人間がここへ反映する。Plannerはこのディレクトリを書き換えない。
`pnpm api:mock <Issue URL>`は、承認済みProposalと一致するこのファイルをMock Serverとして提供する（docs/workflows/api-mock.md）。
`pnpm api:docs`を実行すると、このファイルをSwagger UIで閲覧できる。URLは`http://127.0.0.1:8080`で、閲覧専用である（docs/workflows/api-docs.md）。

| 役割 | 使うもの | コマンド |
| --- | --- | --- |
| 契約（SSOT） | `openapi.yaml` | - |
| 契約を見る | Swagger UI | `pnpm api:docs` |
| 契約からMock APIを提供する | Prism | `pnpm api:mock <Issue URL>` |

型生成ツール・Contract Testは未導入。
