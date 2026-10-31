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

手書きのSBI JSON（Legacy SBI、`.harness/state/sbi-<数字でない名前>.json`）と、Trusted Acceptance（`.harness/verification/`直下と`lib/`直下の`.mjs`）は、認証を仕様として記述するだけで、認証を実装しない。そのため、SEC-AUTH-001の語による検出（変更行の`jwt`・`authentication`など、Legacy SBIの本文の「認証」）を当てない（#217）。ファイル名による検出、SBIが宣言した`requiredSecurityRules`・`securityImpact`、他のルールはそのまま適用する。Run snapshot（`sbi-<数字>.json`）とアプリケーションのコードは、これまでどおり語でも検出する。

SBIの本文（タイトル・目的・受け入れ要件と、PRに入るRun snapshot）のうち、認証が要らないことを述べるだけの言い回しは、SEC-AUTH-001の「認証」の検出から除く（#233、security.jsonの`ignoredMetadataPatterns`と、pr-risk.jsonの`authn_changed`の`ignoredPatterns`）。除くのは次の3つの形だけ。同じ文に「ようにする」「可能にする」「に変更」「化」「外す」「削除」「廃止」「やめる」「緩和」「許可」があるときは、境界を変える記述とみなして除かない。

- 「認証不要の」「認証なしで」のように、要らないことを述べる形。「認証不要にする」「認証不要化」のように、既存の境界を変える形は除かない。
- 「認証ヘッダや Cookie を付けない」「認証ヘッダも Cookie も持たない」のように、付けないリクエストやクライアントを述べる形。
- 「未認証クライアントでも疎通確認できる」のように、未認証でも呼べることを述べる形。「未認証ユーザーは 401 を返す」のような拒否の記述は除かない。

同じSBIで「認証を追加する」などの記述や、コードの変更行の`authenticate`などの語、ファイル名による検出、SBIが宣言した`securityImpact`は、これまでどおり検出する。英語の言い回しは除かない（Plannerは日本語で書き、英語の`authentication`はlanes.jsonのSecurity Gateにも当たるため）。

Railsの認可テスト（rails-authz-test）は、`apps/api/spec/authorization/`の`*_spec.rb`をテスト用DBで実行する。specが無い、テストが0件、skip・pending・focusで実行されないテストがある場合は失敗にする。
役割ごとの許可・拒否のspecは、認可を実装するSBIが、ここから参照する権限表に沿って書く。権限表が決まるまでは、`apps/api/`の認可を変えるPRはこの検証で必ず失敗する。

Railsの認可テストとRLSテストは`apps/api/`の変更、認証のテストは`apps/`・`packages/`・`prototypes/`の変更でだけ実行する。ADRなどの文書だけで認可を記述した場合も、実装前の人の承認とレベル3の判定は必要になる。
