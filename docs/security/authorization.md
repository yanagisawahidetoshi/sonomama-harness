# 認証・認可・アクセス境界

## 未決の要件

認証方式、利用者の役割、操作・データごとのアクセス範囲、RLSの適用範囲を人間が定義する。
具体的な権限表はdocs/productと関連ADRに紐付ける。このテンプレートでは権限を新設しない。

## 実行ルール

- SEC-AUTH-001: AuthN / API認証の変更。authn-testが必要。
- SEC-AUTHZ-001: AuthZ / API認可の変更。rails-authz-testが必要。
- SEC-RLS-001: RLS変更。rails-rls-testが必要。
- SEC-ROLE-001: role / permissionモデルの変更。rails-authz-testが必要。

いずれも実装前Human Gate、最低LEVEL 3、実装後は異なる人間2人以上の承認を要求する。
未設定の必須検証はNOT_CONFIGUREDとなり、承認だけで突破できない。
