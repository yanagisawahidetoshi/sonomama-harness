# API Schema
OpenAPI 3.1を唯一の契約定義（SSOT）として`openapi.yaml`（または`openapi.json`のどちらか1つ）に置く。
Railsの契約検証とExpo / admin向け型生成は同じスキーマを参照する。

API Schema Plannerは`.harness/api-schema/<issue-number>/openapi.yaml`にProposalを出す。
人間がIssueで承認（`api-schema-approved`）した後に、ここへ反映する。Plannerはこのディレクトリを書き換えない。
型生成ツール・Mock server・Contract Testは未導入。
