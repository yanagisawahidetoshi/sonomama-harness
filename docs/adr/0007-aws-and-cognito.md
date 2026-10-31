# ADR-0007: インフラにAWS、認証基盤にAmazon Cognitoを使う

- 状態: Accepted（2026-10-31、柳沢英俊が承認）
- 日付: 2026-10-31
- 判断者: 柳沢英俊
- 関連SBI: なし

## 背景

認証Providerが決まっていなかったため、apps/admin・apps/api・apps/mobileは認証の実装に入れず、ユーザー登録の方式（[ADR-0002](0002-user-registration-and-invitation.md)）もProviderを仮定せずに比べるしかなかった。

## 選択肢

候補は、各アプリのREADMEに挙げていたAmazon Cognito、Google Cloud Identity Platform、Firebase Authenticationだった。
インフラをAWSにするため、同じAWSのサービスであるAmazon Cognitoを選ぶ。

## 決定

- インフラはAWSを使う。
- 認証基盤はAmazon Cognito（User Pool）を使う。

このADRでは、ユーザー登録・招待の方式は決めない。ADR-0002で扱う。

## 影響と検証

- apps/admin・apps/api・apps/mobileのREADMEにある「認証Providerは未決定」を、Cognitoを使う記述に改める。
- Provider固有のSDK・gem、token管理、login画面は、この決定だけでは導入しない。導入する変更はSEC-AUTH-001の対象になる（[authorization.md](../security/authorization.md)）。
- 撤回するときは、このADRをSupersededにし、後継のADRでProviderを決め直す。

ADRへの変更はHuman Gate対象。AIだけで確定しない。
