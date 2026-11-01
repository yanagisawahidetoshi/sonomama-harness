# API Schema
OpenAPI 3.1を唯一の契約定義（SSOT）とし、`openapi.yaml`か`openapi.json`のどちらか1つに置く。
Railsの契約検証と、Expo / admin向けの型生成は、同じスキーマを参照する。

このファイルはSchema SBI（`packages/api-schema`だけを変えるSBI）が`pnpm harness:run`で変更し、PRのレビューを経てmainへ入る。mainのこのファイルを承認済みの契約として扱う。
`pnpm api:mock`は、このファイルをそのままMock Serverとして提供する（docs/workflows/api-mock.md）。
`pnpm api:docs`を実行すると、このファイルをSwagger UIで閲覧できる。URLは`http://127.0.0.1:8080`で、閲覧専用である（docs/workflows/api-docs.md）。

| 役割 | 使うもの | コマンド |
| --- | --- | --- |
| 契約（SSOT） | `openapi.yaml` | - |
| 契約を見る | Swagger UI | `pnpm api:docs` |
| 契約からMock APIを提供する | Prism | `pnpm api:mock` |

型生成ツール・Contract Testは未導入。
