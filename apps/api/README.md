# SONOMAMA API (apps/api)

Rails API mode。Ruby / RailsとPostgreSQLはDocker Composeで動かし、ローカルにRuby / PostgreSQLをinstallしない。業務APIは後続SBIで追加する。

| 項目 | version |
| --- | --- |
| Ruby 3.4 | 3.4.12 (`Dockerfile` / `.ruby-version`) |
| Rails 8.1 | 8.1.4 (`Gemfile.lock`) |
| PostgreSQL | 18.6 (`compose.yaml` の `db` image) |

Ruby 4.0系は周辺gemの互換性を優先して見送っている。

## 前提

- Docker / Docker Compose (Docker Desktop等)
- Compose設定はrepo rootの `compose.yaml`。コマンドはrepo rootで実行する。

## 起動

```sh
cp .env.example .env              # 任意。CORS許可Originを変える場合
docker compose build api          # imageをbuild (Gemfile変更時も実行)
docker compose up api db          # Rails + PostgreSQL。起動時にdb:prepareを実行する
curl http://127.0.0.1:3000/up     # health check (200)
docker compose up -d db           # DBのみ起動
```

DBのportはhostへ公開しない。`docker compose exec db psql -U postgres` で接続する。
DBは開発・検証専用のコンテナで、パスワードを持たない (`POSTGRES_HOST_AUTH_METHOD=trust`)。Git管理するcredentialはない。

## 開発コマンド

```sh
docker compose run --rm api bundle exec rails db:prepare
docker compose run --rm -e RAILS_ENV=test api bundle exec rails db:prepare
docker compose run --rm -e RAILS_ENV=test api bundle exec rspec
docker compose run --rm api bundle exec rubocop
docker compose run --rm api bundle exec brakeman
docker compose run --rm api bundle exec bundler-audit check --update
docker compose run --rm api bundle exec rails zeitwerk:check
docker compose run --rm api bash                 # コンテナへshell接続
docker compose exec api bash                     # 起動中のコンテナへ接続
```

gemはimageに入る。Gemfileを変えたら `docker compose run --rm --no-deps api bundle lock` でlockを更新し、`docker compose build api` する。
Gemfileを変えていなければ、Dockerのlayer cacheを使うのでbundle installは再実行されない。

## リセット

```sh
docker compose down -v   # コンテナとDB volume (db-data) を削除。DBは次回起動時に作り直す
```

## CORS

`CORS_ALLOWED_ORIGINS` (カンマ区切り) を許可する。未設定ならCORSヘッダーを返さない。
Composeの既定値は管理画面のdev server (`http://localhost:5173`)。Production値はこの環境では決めない。

## OpenAPI

API契約のSSOTは `packages/api-schema/openapi.yaml` (OpenAPI 3.1)。apps/apiには複製しない。
`committee-rails` は採用していない。依存先のCommittee本体が、OpenAPI 3.1以上を未対応として受け付けないため。

### request specの契約検証

request specが実際に送ったrequestとRailsが返したresponseを、`match_api_contract` でOpenAPI 3.1に照合する（`spec/support/api_contract.rb`）。
Composeは `packages/api-schema` をread-onlyで `/api-schema` にmountし、`API_SCHEMA_DIR` で渡す。

```ruby
RSpec.describe "Students", type: :request do
  describe "GET /api/v1/students/:studentId" do
    context "when the student exists" do
      it "returns the student as the contract defines" do
        get "/api/v1/students/#{student.id}", headers: auth_headers

        expect(response).to have_http_status(:ok)
        expect(response).to match_api_contract
      end
    end

    context "when the request breaks the contract" do
      it "rejects it with the declared 400 error body" do
        post "/api/v1/students", params: { grade: "third" }, as: :json

        expect(response).to match_api_contract(request: :invalid)
      end
    end
  end
end
```

- `match_api_contract` はrequestとresponseの両方が契約どおりのときだけ通る。不正入力の負のテストは `request: :invalid` を付け、入力違反が検出されたことと、エラーresponseが契約どおりであることを確かめる。
- 照合するもの: method / pathのoperation、path / query / header / cookie parameter、request bodyの有無・Content-Type・schema、response status・media type・body・宣言されたheader。bodyなしと宣言したstatus（204等）でbodyを返すとFAIL。
- schemaは必須、型、enum、配列、入れ子、null許容（`type: [string, "null"]`）、`additionalProperties` を契約どおりに扱う。schemaの `default` は欠けたpropertyを補わない（必須なら欠落でFAIL）。
- 失敗メッセージはoperation・status・違反箇所のJSON pointerだけを出し、tokenやbodyの値は出さない。
- 契約の読込に失敗した、OpenAPI 3.1でない、validatorが扱えない機能（未知の `format`、外部ファイルへの `$ref`、JSON以外のmedia type）を使う場合は、照合せずに失敗する。
- 照合しないもの: `security`（認証）。認証・認可の振る舞いは通常のrequest specで確かめる。

full suite（`bundle exec rspec`）の最後に、Railsの業務route（`config/routes.manifest.json`）ごとに契約照合したrequest specを `COVERED` / `UNCOVERED` で出す。
業務routeに契約照合したspecが1件も無い（skipを含む）、routeが契約に無い、`openapi.yaml` が無いのに業務routeがある場合はsuiteをFAILにする。
Railsが未実装の契約operationは `UNIMPLEMENTED` と出すだけでFAILにしない。業務routeも `openapi.yaml` も無い間は `NOT CHECKED` と出し、照合済みとは扱わない。
一部のファイル・exampleだけを実行したときはcoverageを判定しない。

照合の仕組みは `spec/support/api_contract_spec.rb` が、本番routeに追加しないfixture用のRails route（`spec/support/api_contract_fixture.rb`）と契約（`spec/fixtures/api_contract/`）で検証する。

#### validatorの選定

`openapi_first`（OpenAPI 3.0 / 3.1、JSON Schema 2020-12は `json_schemer`）を使う。parameterのstyle / 型変換、operation解決、response headerを任せる。
`openapi_first` はschemaの `default` を欠けたpropertyへ補ってから必須チェックするため、bodyは `json_schemer` のOpenAPI 3.1 dialectで補完なしに検証する。
`$ref` はdocument内の参照（`#/...`）だけを解決する。

| 案 | 却下理由 |
| --- | --- |
| `committee-rails` | OpenAPI 3.1を受け付けない |
| `openapi_contracts` | request bodyとparameterの照合がmatcherごとのopt-inで、付け忘れると黙って照合しない |
| `skooma` | 0.x系で、JSON Schema実装が独自（`json_skooma`）。`json_schemer` より利用実績が少ない（動作は未検証） |
| `json_schemer` 単体 | operation解決とparameterのstyle / 型変換を自前で持つことになる |
| `rswag` | specからOpenAPIを生成する方式で、`openapi.yaml` をSSOTにできない |

routeを変えたら `docker compose run --rm -e RAILS_ENV=test api bin/rails contract:routes` で `config/routes.manifest.json` を更新してcommitする。
api-contract VerifierはRailsを起動せずこのmanifestをOpenAPIと照合し、`spec/lib/route_manifest_spec.rb` はmanifestが古いと失敗する。

## 認証

認証Provider（Cognito / Google Cloud Identity Platform / Firebase Auth等）は未決定。
Provider固有gem・JWT / JWKS検証・認証middleware・認可は実装していない。model / column名もProvider固有名にしない。

## Harness

`.harness/config/harness.json` の `rails` verifierが、Docker Compose経由でimage build、db:prepare、RSpec、RuboCop、Brakeman、Bundler Audit、Zeitwerk checkを実行する。
受け入れ条件は `.harness/verification/api-env.mjs` で検証する。
