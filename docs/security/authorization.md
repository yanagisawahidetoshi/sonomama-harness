# 認証・認可・アクセス範囲

## まだ決めていないこと

ログインの方式、利用者の役割、操作やデータごとに誰がどこまで扱えるか、データベースの行単位のアクセス制御（RLS）をどこに使うかを、人が決める。
具体的な権限表は、docs/productと関連するADRに書いてここから参照する。このテンプレートで新しい権限を作ることはしない。

## Harnessで守らせるルール

次の変更には、実装前の人の承認、レベル3のリスク判定、決めた検証の実行が必要になる（詳しくは[README](README.md)）。

| ルールID | 対象となる変更 | 必ず実行する検証 |
| --- | --- | --- |
| SEC-AUTH-001 | 認証、APIの認証 | 認証のテスト（authn-test） |
| SEC-AUTHZ-001 | 認可、APIの認可 | Railsの認可テスト（rails-authz-test） |
| SEC-RLS-001 | RLS | RailsのRLSテスト（rails-rls-test） |
| SEC-ROLE-001 | 役割や権限のモデル | Railsの認可テスト（rails-authz-test） |

必ず実行する検証がまだ用意されていない場合、人が承認しても先へ進めない。

SEC-AUTH-001は、変更した行に`securitySchemes`などの語があると認証の変更とみなす。ただし、API契約テスト基盤（`apps/api/spec/support/api_contract/`直下の`.rb`）がOpenAPIの構造名として`securitySchemes`を列挙するだけの変更は、認証の変更ではないので、この語を本文の検出から除く（security.jsonの`contentExceptions`）。
同じディレクトリでもYAMLなど`.rb`以外のファイルやサブディレクトリは除かない。除くのはこの語だけで、同じファイルでも`bearerAuth`・`jwt`・`authenticate`などの語、ファイル名による検出、他のルールはそのまま適用する。`packages/api-schema/openapi.yaml`の`securitySchemes`・`security`の変更や、契約テスト基盤の外にある`spec/`の変更も、これまでどおり検出する。

SEC-AUTH-001は、`authenticate`で始まる語（`authenticate_user!`、`authenticated?`、Deviseの`authenticated :user`など）と、OpenAPIの`security`キーの行も本文から検出する。`security`キーは先頭にもoperationの下にも書け、値が配列・ブロック・aliasのどれでも、空配列や`bearerAuth`以外のschemeでも、その行の追加・変更・削除を検出する。値が`{`で始まるJavaScriptのオブジェクトなど、OpenAPIのsecurityではない形は対象にしない。
Harnessのコード（`tools/harness/`直下の`.mjs`）は、自身の承認台帳（`authenticatedRecords`、`authenticated local ledger`）、承認する人の確認（`Authenticated human`）、GitHubやgh CLIによる本人確認（`GitHub authenticates`、`the authenticated gh CLI`）、OpenAPIを読んだ結果（`authenticated endpoint`、`.authenticated`など）を`authenticate`で始まる語で書く。アプリの認証を変えるものではないので、security.jsonの`contentExceptions`に列挙した文脈だけを本文の検出から除く。除くのは列挙した文字列（大文字・小文字も一致するもの）だけで、同じ行の他の語、`authenticate_user!`、サブディレクトリやシェルスクリプト、`apps/`・`packages/`・`prototypes/`などHarness以外のパス、Harnessの外へ出すrenameは検出する。除く文脈が増えてきたら、語の列挙ではなく構文や文脈で判定する方式へ移る。
既知の制約: 既存の`security`の下でscheme名の行だけを書き換える変更（`- PartnerAuth: []`を`- OtherAuth: []`にするなど）は、変更した行に`security`が現れないので検出しない。変更前後のOpenAPIをparseして比べる方式を#218で扱う。

Railsの認可テスト（rails-authz-test）は、`apps/api/spec/authorization/`の`*_spec.rb`をテスト用DBで実行する。specが無い、テストが0件、skip・pending・focusで実行されないテストがある場合は失敗にする。
役割ごとの許可・拒否のspecは、認可を実装するSBIが、ここから参照する権限表に沿って書く。権限表が決まるまでは、`apps/api/`の認可を変えるPRはこの検証で必ず失敗する。

Railsの認可テストとRLSテストは`apps/api/`の変更、認証のテストは`apps/`・`packages/`・`prototypes/`の変更でだけ実行する。ADRなどの文書だけで認可を記述した場合も、実装前の人の承認とレベル3の判定は必要になる。
