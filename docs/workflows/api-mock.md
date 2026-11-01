# API Mock Serverを起動する

Rails APIの完成を待たずにFrontendを開発できるように、OpenAPIからローカルのMock Serverを起動する。Mock用に別のAPI仕様は持たず、API仕様の基準となるファイル（SSOT）`packages/api-schema/openapi.yaml`を、Prismでそのまま提供する。

OpenAPIの変更はSchema SBIとしてPRでレビューされ、mainへmergeされる。mainの`openapi.yaml`を承認済みの契約として扱うので、Mock Serverの起動に別の承認は要らない（#164）。

```text
pnpm api:mock [--dynamic]
  → packages/api-schema/openapi.yaml を読む
  → 起動できる: Prism（static mode）を 127.0.0.1:4010 で起動
  → 起動できない: 起動せず exit 1 で理由を表示
```

## 手順

1. 使いたいOpenAPIがmainにあることを確認する（ブランチでSchema SBIを試すときは、そのブランチの`openapi.yaml`が使われる）。
2. `pnpm api:mock`を実行する。Ctrl+Cで停止する。
3. FrontendはAPI Base URLを環境変数で`http://127.0.0.1:4010`に切り替える。Mock ServerはExpo / React Admin固有のロジックを持たない。

`--dynamic`を付けると、Prismがschemaからランダムな値を生成する。既定のstatic modeはexampleを使い、exampleがなければschemaから値を作る。応答は毎回同じになる。

## 認証

`security: [bearerAuth]`のendpointは、`Authorization`ヘッダにBearer形式の任意の値（例: 値を`mock-token`にする）を付ければ2xxを返す。付けなければ401と共通の`Error`を返す。JWTは検証しないので、実際の認証ProviderのtokenやCredentialは使わない。

## 起動を拒否する条件

- `packages/api-schema/openapi.yaml`がない。`openapi.json`や`openapi.yml`がある。複数ある。OpenAPI 3.1でない。
- `#`で始まらない`$ref`がある。Prismが外部のファイルやURLを読みに行くのを防ぐ。
- Issue URLなどの引数を渡した。Mock ServerはSSOTだけを提供する。

## 制約

- Prismは`@stoplight/prism-cli@5.14.2`に固定している。5.15以降はNode 24以上が必要なため。
- proxy modeは使わない。Rails API・認証Provider・本番APIへは接続しない。

## やらないこと

Frontend API clientの生成、Statefulな業務ロジックの再現、認証Providerの実JWT検証。
