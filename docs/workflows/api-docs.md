# API Docs（Swagger UI）の運用

`packages/api-schema/openapi.yaml`（SSOT）を、ブラウザのSwagger UIで読むためのローカルサーバ。仕様の閲覧専用で、APIへのリクエストは送らない。

```text
OpenAPI（packages/api-schema/openapi.yaml） = 契約 / SSOT
  ├─ Swagger UI（pnpm api:docs）         = 契約を見る
  └─ Prism（pnpm api:mock <Issue URL>）  = 契約からMock APIを提供する
```

## 手順

1. `pnpm api:docs`を実行する。`http://127.0.0.1:8080`を開く。Ctrl+Cで停止する。
2. 8080が使用中なら`pnpm api:docs --port 18080`のように変える。listenするのは常に`127.0.0.1`。

OpenAPIは表示のたびにファイルから読む。編集した内容は、ブラウザを再読み込みすれば反映される。複製や変換したファイルは作らない。
API Schemaの承認は確認しない。承認済みのOpenAPIだけを扱う必要がある場合は`api:mock`を使う。

## 外部通信をしないための設定

- Try it outは無効（`supportedSubmitMethods: []`）。OpenAPIの`servers`にProductionやStagingのURLがあっても、そこへリクエストしない。
- オンラインvalidator（validator.swagger.io）を無効にしている。
- URL入力欄のあるtop barを出さない。表示できるのはSSOTだけ。
- Content Security Policyで、ブラウザが読み込みと通信をできる先を、このサーバだけに制限している。
- Hostヘッダが`127.0.0.1:<port>`か`localhost:<port>`以外のリクエストは403にする（DNS rebinding対策）。
- OpenAPIのsecurityScheme（Bearer / JWTなど）はAuthorizeボタンと鍵アイコンで表示される。Try it outがないので、tokenを入力しても使われない。認証Providerの実際のtokenやCredentialは不要。

## 起動を拒否する条件

- `packages/api-schema/openapi.yaml`がない。`openapi.json`や`openapi.yml`がある。複数ある。
- OpenAPI 3.1.xではない。
- `#`で始まらない`$ref`がある。ブラウザが外部のファイルやURLを読みに行くのを防ぐ。起動後にこうなった場合は、`/openapi.yaml`が422を返して表示しない。
- swagger-ui-distがインストールされていない（`pnpm install`を実行する）。

## やらないこと

Try it out、Production / Staging APIへのproxy、認証Providerの実認証、外部公開、Redocなど別のドキュメントUI。
