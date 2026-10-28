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
OpenAPI 3.1のrequest / response contract validationは別Issueでライブラリを選ぶ。

routeを変えたら `docker compose run --rm -e RAILS_ENV=test api bin/rails contract:routes` で `config/routes.manifest.json` を更新してcommitする。
api-contract VerifierはRailsを起動せずこのmanifestをOpenAPIと照合し、`spec/lib/route_manifest_spec.rb` はmanifestが古いと失敗する。

## 認証

認証Provider（Cognito / Google Cloud Identity Platform / Firebase Auth等）は未決定。
Provider固有gem・JWT / JWKS検証・認証middleware・認可は実装していない。model / column名もProvider固有名にしない。

## Harness

`.harness/config/harness.json` の `rails` verifierが、Docker Compose経由でimage build、db:prepare、RSpec、RuboCop、Brakeman、Bundler Audit、Zeitwerk checkを実行する。
受け入れ条件は `.harness/verification/api-env.mjs` で検証する。

