# 認証・認可・アクセス範囲

## まだ決めていないこと

ログインの方式、利用者の役割、操作やデータごとに誰がどこまで扱えるか、データベースの行単位のアクセス制御（RLS）をどこに使うかを、人が決める。
具体的な権限表は、docs/productと関連するADRに書いてここから参照する。このテンプレートで新しい権限を作ることはしない。

## Harnessで守らせるルール

次の変更には、SBI承認、レベル3のリスク判定、決めた検証の実行が必要になる（詳しくは[README](README.md)）。

| ルールID | 対象となる変更 | 必ず実行する検証 |
| --- | --- | --- |
| SEC-AUTH-001 | 認証、APIの認証 | 変更したアプリの認証のテスト（APIはauthn-test、管理画面はadmin-authn-test、モバイルはmobile-authn-test） |
| SEC-AUTHZ-001 | 認可、APIの認可 | Railsの認可テスト（rails-authz-test） |
| SEC-RLS-001 | RLS | RailsのRLSテスト（rails-rls-test） |
| SEC-ROLE-001 | 役割や権限のモデル | Railsの認可テスト（rails-authz-test） |

必ず実行する検証がまだ用意されていない場合、人が承認しても先へ進めない。

SEC-AUTH-001は、変更した行に`securitySchemes`などの語があると認証の変更とみなす。ただし、API契約テスト基盤（`apps/api/spec/support/api_contract/`直下の`.rb`）がOpenAPIの構造名として`securitySchemes`を列挙するだけの変更は、認証の変更ではないので、この語を本文の検出から除く（security.jsonの`contentExceptions`）。
同じディレクトリでもYAMLなど`.rb`以外のファイルやサブディレクトリは除かない。除くのはこの語だけで、同じファイルでも`bearerAuth`・`jwt`・`authenticate`などの語、ファイル名による検出、他のルールはそのまま適用する。`packages/api-schema/openapi.yaml`の`securitySchemes`・`security`の変更や、契約テスト基盤の外にある`spec/`の変更も、これまでどおり検出する。

手書きのSBI JSON（Legacy SBI、`.harness/state/sbi-<数字でない名前>.json`）と、Trusted Acceptance（`.harness/verification/`直下と`lib/`直下の`.mjs`）は、認証を仕様として記述するだけで、認証を実装しない。そのため、SEC-AUTH-001の語による検出（変更行の`jwt`・`authentication`・`authenticate_user!`・`security: []`など、SEC-AUTH-001の本文パターンすべてと、Legacy SBIの本文の「認証」）を大文字・小文字を区別せずに当てない（#217、#177）。ファイル名による検出、SBIが宣言した`requiredSecurityRules`・`securityImpact`、他のルールはそのまま適用する。Run snapshot（`sbi-<数字>.json`）とアプリケーションのコードは、これまでどおり語でも検出する。

SEC-AUTH-001は、`authenticate`で始まる語（`authenticate_user!`、`authenticated?`、Deviseの`authenticated :user`など）、Rails 8・Devise・HTTP認証のフィルタ（`require_authentication`、`allow_unauthenticated_access`、`ActionController::HttpAuthentication`、`database_authenticatable`などの`authenticatable`、`http_basic_authenticate_with`）、Deviseのルートとモデルの宣言（`devise_for`、`unauthenticated :user`、`devise :omniauthable`など）、`has_secure_password`、再認証（`reauthenticate`、`preauthenticated`）、OpenAPIの`security`キーの行も本文から検出する。英文の`unauthenticated`や`authenticator`、`has_secure_token`だけでは検出しない。
既知の制約: `devise`のモジュールの並びを次の行へ続けた場合（`devise :database_authenticatable,`の次の行の`:lockable, :timeoutable`など）、続きの行だけの変更は`devise`の宣言の一部だと行からはわからないので検出しない。`security`キーは先頭にもoperationの下にも書け、値が配列・ブロック・aliasのどれでも、空配列や`bearerAuth`以外のschemeでも、その行の追加・変更・削除を検出する。値が`{`で始まるJavaScriptのオブジェクトなど、OpenAPIのsecurityではない形は対象にしない。
Harnessのコード（`tools/harness/`直下の`.mjs`）は、自身の承認台帳（`authenticatedRecords`、`authenticated local ledger`）、承認する人の確認（`Authenticated human`）、GitHubやgh CLIによる本人確認（`GitHub authenticates`、`the authenticated gh CLI`）、OpenAPIを読んだ結果（`authenticated endpoint`、`.authenticated`など）を`authenticate`で始まる語で書く。アプリの認証を変えるものではないので、security.jsonの`contentExceptions`に列挙した文脈だけを本文の検出から除く。除くのは列挙した文字列（大文字・小文字も一致するもの）だけで、同じ行の他の語、`authenticate_user!`、サブディレクトリやシェルスクリプト、`apps/`・`packages/`・`prototypes/`などHarness以外のパス、Harnessの外へ出すrenameは検出する。除く文脈が増えてきたら、語の列挙ではなく構文や文脈で判定する方式へ移る。
`contentExceptions`の大文字・小文字の扱いは除外ごとに`ignoreCase`で決める。書かない除外は、列挙した大文字・小文字のとおりの文字列だけを除く。指定を忘れても除外が広がらないようにするためで、契約テスト基盤の`securitySchemes`（OpenAPIの名前そのもの）とHarnessの既知の文脈はこの既定のままにする。Legacy SBI・Trusted Acceptanceの除外は、本文パターンと同じく大文字・小文字を区別しない（`ignoreCase: true`）。
既知の制約: 本文の検出は変更した行だけを読むので、次のOpenAPIの書き方は検出しない。変更前後のOpenAPIをparseして比べる方式を#218で扱う。
- 既存の`security`の下でscheme名の行だけを書き換える変更（`- PartnerAuth: []`を`- OtherAuth: []`にするなど）
- 1行のJSON（`{"openapi": "3.1.0", "security": []}`）や、flow mappingの中のキー（`get: {security: []}`）
- 明示キー（`? security`）、`security: null`・`security: ~`、JavaScriptの識別子を値にしたもの（`security: requirements`）

SBIの本文（タイトル・目的・受け入れ要件と、PRに入るRun snapshot）のうち、認証が要らないことを述べるだけの言い回しは、SEC-AUTH-001の「認証」の検出から除く（#233、security.jsonの`ignoredMetadataPatterns`と、pr-risk.jsonの`authn_changed`の`ignoredPatterns`）。除くのは次の3つの形だけ。同じ文に「ようにする」「可能にする」「に変更」「化」「外す」「削除」「廃止」「やめる」「緩和」「許可」があるときは、境界を変える記述とみなして除かない。

- 「認証不要の」「認証なしで」のように、要らないことを述べる形。「認証不要にする」「認証不要化」のように、既存の境界を変える形は除かない。
- 「認証ヘッダや Cookie を付けない」「認証ヘッダも Cookie も持たない」のように、付けないリクエストやクライアントを述べる形。
- 「未認証クライアントでも疎通確認できる」のように、未認証でも呼べることを述べる形。「未認証ユーザーは 401 を返す」のような拒否の記述は除かない。

同じSBIで「認証を追加する」などの記述や、コードの変更行の`authenticate`などの語、ファイル名による検出、SBIが宣言した`securityImpact`は、これまでどおり検出する。英語の言い回しは除かない（Plannerは日本語で書き、英語の`authentication`はlanes.jsonのSecurity Gateにも当たるため）。

Railsの認可テスト（rails-authz-test）は、`apps/api/spec/authorization/`の`*_spec.rb`をテスト用DBで実行する。specが無い、テストが0件、skip・pending・focusで実行されないテストがある場合は失敗にする。
役割ごとの許可・拒否のspecは、認可を実装するSBIが、ここから参照する権限表に沿って書く。権限表が決まるまでは、`apps/api/`の認可を変えるPRはこの検証で必ず失敗する。

認証・RLSのテストも同じ条件で失敗にする（#165）。どれも、テストが無い・0件・skipなどで実行されないテストがある・テストが失敗した場合はFAIL、すべて実行して通ればPASS。

| 検証 | 実行するテスト | 実行方法 |
| --- | --- | --- |
| authn-test | `apps/api/spec/authentication/`の`*_spec.rb` | テスト用DB（`sonomama_authn_test`）でRSpec |
| rails-rls-test | `apps/api/spec/rls/`の`*_spec.rb` | テスト用DB（`sonomama_rls_test`）でRSpec |
| admin-authn-test | `apps/admin/src/features/auth/`の`*.test.ts(x)` | 管理画面のVitest（コンテナ内） |
| mobile-authn-test | `apps/mobile/src/features/auth/`の`*.test.ts(x)` | モバイルのJest（コンテナ内） |

合否は実行結果の件数で決める（#246）。RSpecはJSONの集計で、実行したテストが1件以上・pendingが0件・宣言したテストがすべて実行された（focusやタグの絞り込みで外れたものが無い）ことを見る。Vitest（`--reporter=json`）とJest（`--json`）は、`numTotalTests`が1以上で、`numPendingTests`・`numTodoTests`・`numFailedTests`が0、読み込めないsuiteが無いことを見る。
静的な検査は補助として残し、RSpecの`xit`・`skip`・`pending`・`focus`（`{ skip }`・`do skip ... end`・`RSpec.xdescribe`・`; xit`の形も）、Vitest・Jestの`.skip`・`.skipIf`・`.runIf`・`.only`・`.todo`・`it['skip']`・`{ skip: true }`などのoption・`const { skip } = it`・`xit`・`fit`を見つけて失敗にする。失敗するテストを成功扱いにする`it.fails`（Vitest）・`test.failing`（Jest）は件数では見分けられないので、静的な検査で禁止する。
モバイルの静的な検査は、jest-expoが実行するファイル（`*.test.*`・`*.spec.*`・`__tests__/`配下、`.mts`・`.cts`を含む）をすべて読む。

どの検証を実行するかは、変更したパスで決める。Railsの認可テストとRLSテストは`apps/api/`、APIの認証テストは`apps/api/`と`packages/`（OpenAPIの認証定義はAPIが実装するため）、管理画面とモバイルの認証テストはそれぞれ`apps/admin/`・`apps/mobile/`の変更でだけ実行する。
SBIがルールを宣言した場合や、SBIの本文がルールに一致した場合も同じで、ルールのSBI承認・レベル3・2人のReviewはそのまま付けたうえで、変更したパスが当たる検証だけを必須にする。たとえば管理画面だけを変える認証のSBIでは、APIとモバイルの認証テストは要求しない。変更したパスがまだわからないとき（実装前の確認で対象のパスが無いときなど）は、ルールの検証をすべて必須にする。
`prototypes/`の認証の変更には、アプリの認証テストを要求しない。SEC-AUTH-001には一致するので、SBI承認・レベル3・2人のReviewで止める。
ADRなどの文書だけで認可を記述した場合も、SBI承認とレベル3の判定は必要になる。
