# API Schema
OpenAPI 3.1を唯一の契約定義（SSOT）として`openapi.yaml`（または`openapi.json`のどちらか1つ）に置く。
Railsの契約検証とExpo / admin向け型生成は同じスキーマを参照する。

API Schema Plannerは`.harness/api-schema/<issue-number>/openapi.yaml`にProposalを出す。
`pnpm planner:api-schema-status <Issue URL>`がAPPROVEDになった後に、人間がここへ反映する。Plannerはこのディレクトリを書き換えない。
承認済みProposalと一致するこのファイルを`pnpm api:mock <Issue URL>`がMock Serverとして提供する（docs/workflows/api-mock.md）。
`pnpm api:docs`で、このファイルをSwagger UIで閲覧できる（`http://127.0.0.1:8080`、閲覧専用。docs/workflows/api-docs.md）。

| 役割 | もの | コマンド |
| --- | --- | --- |
| 契約（SSOT） | `openapi.yaml` | - |
| 契約を見る | Swagger UI | `pnpm api:docs` |
| 契約からMock APIを提供する | Prism | `pnpm api:mock <Issue URL>` |

型生成ツール・Contract Testは未導入。
