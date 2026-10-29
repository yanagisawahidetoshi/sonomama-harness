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

Railsの認可テスト（rails-authz-test）は、`apps/api/spec/authorization/`の`*_spec.rb`をテスト用DBで実行する。specが無い、テストが0件、skip・pending・focusで実行されないテストがある場合は失敗にする。
役割ごとの許可・拒否のspecは、認可を実装するSBIが、ここから参照する権限表に沿って書く。権限表が決まるまでは、`apps/api/`の認可を変えるPRはこの検証で必ず失敗する。

Railsの認可テストとRLSテストは`apps/api/`の変更、認証のテストは`apps/`・`packages/`・`prototypes/`の変更でだけ実行する。ADRなどの文書だけで認可を記述した場合も、実装前の人の承認とレベル3の判定は必要になる。
