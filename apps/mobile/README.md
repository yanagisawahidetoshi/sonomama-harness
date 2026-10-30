# SONOMAMA 受講生アプリ (apps/mobile)

受講生向けスマホアプリ。Expo SDK 58 + React Native 0.88 + TypeScript。業務画面は後続SBIで追加する。

| 用途              | ライブラリ                                                                     |
| ----------------- | ------------------------------------------------------------------------------ |
| Routing           | Expo Router (`src/app`)                                                        |
| Server state      | TanStack Query (staleTime 5分 / gcTime 10分 / 4xxはretryなし・その他は最大3回) |
| HTTP              | Axios (`src/shared/api`)                                                       |
| Form              | React Hook Form + Zod (`@hookform/resolvers`)                                  |
| Lint / Format     | Biome (ESLint / Prettierは使わない)                                            |
| Test              | Jest (`jest-expo`) + React Native Testing Library                              |
| Integration / E2E | Maestro (必須。外部CLI、development build対象)                                 |

UI component library・認証・Push通知・AsyncStorage / SecureStore・Analyticsは要件が決まるまで導入しない。
React / React Nativeのversionは`npx expo install`が解決したものを使い、手動でずらさない。

## 前提

- Node 22 (`.node-version`)、pnpm 8 (root `package.json` の `packageManager`)
- 通常開発: Simulator / Emulator または実機にExpo Goを入れる
- iOS: Xcode と iOS Simulator
- Android: Android Studio と Android Emulator
- Maestro CLI 2.x (Integration / E2Eを実行する場合)。iOS 26系のSimulatorでは、1.x系だとアプリの画面要素を取得できない。2.12.0で確認済み。

## セットアップ

```sh
pnpm install
cp apps/mobile/.env.example apps/mobile/.env.local
```

依存を追加するときは `pnpm --filter mobile exec expo install <package>` でSDK 58互換versionを入れる。

## コマンド

```sh
pnpm --filter mobile start         # expo start --go — Expo Goで開く (通常開発)
pnpm --filter mobile ios           # expo run:ios — development buildを作成してSimulatorへインストール・起動
pnpm --filter mobile android       # expo run:android — 同上 (Emulator)
pnpm --filter mobile typecheck
pnpm --filter mobile lint          # biome lint
pnpm --filter mobile format:check  # biome format
pnpm --filter mobile check         # biome check (lint + format + import整列)
pnpm --filter mobile test          # Jest + RNTL
pnpm --filter mobile doctor        # expo-doctor (Expo依存の整合確認)
```

`npx expo-doctor` を `apps/mobile` で直接実行しても同じ。

## Expo Go と development build

通常開発はExpo Goを主対象にする。`pnpm --filter mobile start` は `expo start --go` で起動し、`i` / `a` でSimulator / EmulatorのExpo Goを開く。
`expo-dev-client` は、CIのMaestroで正式なDevelopment Buildを作るために入れている（#145）。入れると `expo start` の既定がdevelopment buildになるが、`start` scriptは `--go` でExpo Goを明示している。

development buildはMaestroのIntegration / E2Eと、Expo Goで扱えないnative機能の確認に使う。
native moduleが必要になった時点で、Expo Goを続けるかを判断し直す。

```sh
pnpm --filter mobile ios       # 初回は ios/ を生成してビルド (数分かかる)
pnpm --filter mobile android   # 初回は android/ を生成してビルド
```

`ios` scriptは `EXPO_USE_PRECOMPILED_MODULES=0` でExpo modulesをsourceからbuildする。SDK 58.0.19時点のprecompiled `ExpoFileSystem` が `ExpoModulesCore` 58.0.26 と合わず、起動時に `Symbol not found` で落ちるため。
`npx expo run:ios` を直接使う場合も同じ環境変数を付ける。解消したらこの指定を外す。

`ios/` と `android/` は生成物なのでGit管理しない。2回目以降はインストール済みのアプリを開き、`pnpm --filter mobile start` のMetroに接続する。`--go` 指定時に `i` / `a` を押すとExpo Goが開くので、development buildはSimulator / Emulator上のアプリから直接起動する。
bundle identifier / application id は暫定で `com.sonomama.student.dev`。

## テストレイヤー

MaestroはMobile Integration / E2Eの必須ツールとする。通常のmobile Verifier（`expo`）には入れず、Maestroが必要なSBIでだけ専用のrequired VerifierとしてCIで実行する。全Mobile PRで無条件には実行しない。CIの `maestro` jobで実行し、Completion Judgeが結果を必須にする（[.ai/workflows/ci.md](../../.ai/workflows/ci.md)）。

- implementation SBI: Mock API + Maestro
- validation SBI: 実API + Rails + DB + Maestro
- CI: GitHub ActionsのUbuntu + Android Emulator。development buildのAPKはartifact / cacheを再利用し、native fingerprintが変わったときだけ作り直す。iOSのCIは対象外

| レイヤー                 | 主なツール                                    | 実行環境                           |
| ------------------------ | --------------------------------------------- | ---------------------------------- |
| Unit / Component         | Jest + React Native Testing Library           | Node (`pnpm --filter mobile test`) |
| Mobile Integration       | Maestro + Mock API (Approved OpenAPI / Prism) | development build                  |
| Mobile E2E               | Maestro + 実API + Rails + DB                  | development build                  |
| 日常の画面開発・動作確認 | Expo Go                                       | Expo Go                            |

Rails側のRequest Specなど、backend内部のIntegration TestはMaestroへ置き換えない。Maestroは受講生アプリ側のユーザーフローを担当する。

CIのflowは `.maestro/mock/`（implementation SBI）と `.maestro/real/`（validation SBI）に置き、どちらも最初に `.maestro/common/open-development-build.yaml` でDevelopment Buildを開く。
このflowは、Development Buildのランチャーが表示されてから `sonomama://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081` でEmulatorのホストのMetroを開き、初回に開く開発メニューを閉じて、`home-title` が出るまで待つ。

ローカルで同じflowを流す場合（Android Emulator、Maestro 2.x）:

```sh
pnpm --filter mobile android                                  # Development Buildを作ってEmulatorへインストール
pnpm --filter mobile exec expo start --dev-client --port 8081 # 別ターミナル。8081を空けておく
maestro test apps/mobile/.maestro/mock                       # repo rootから
```

## Maestro smoke test

```sh
brew tap mobile-dev-inc/tap && brew install mobile-dev-inc/tap/maestro
# または curl -fsSL "https://get.maestro.mobile.dev" | bash
```

Simulator / Emulator を起動し、development buildをインストールした状態で実行する。

```sh
pnpm --filter mobile start                     # 別ターミナルでMetroを起動
maestro test apps/mobile/.maestro/smoke.yaml   # repo rootから
```

`smoke.yaml` はアプリを起動し、初期画面の `testID="home-title"` と `SONOMAMA` が表示されることだけを確認する。
通常のmobile Verifier（`expo`）では実行しない。

### Android Emulator

Android EmulatorのDevelopment Buildは、ランチャーから接続するか上のURLで `10.0.2.2:8081`（ホストPCのMetro）からbundleを読む。
`prototypes/mobile` など別のMetroが8081を使っていると、`expo start` は8083等へずれるが、アプリは8081の別アプリのbundleを読み込んでしまう（`Can't find ViewManager 'RNSVGPath'` などの赤画面になる）。
8081を空けてから起動するか、debug buildの接続先を変える。

```sh
# 8083で起動したMetroへ向ける例
printf '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map><string name="debug_http_host">10.0.2.2:8083</string></map>\n' > /tmp/rn-prefs.xml
adb push /tmp/rn-prefs.xml /data/local/tmp/rn-prefs.xml
adb shell "run-as com.sonomama.student.dev sh -c 'mkdir -p shared_prefs && cat /data/local/tmp/rn-prefs.xml > shared_prefs/com.sonomama.student.dev_preferences.xml'"
adb shell am force-stop com.sonomama.student.dev
```

Pixel 7 Pro API 35 Emulator + Maestro CLI 1.39.13 で `smoke.yaml` のPASSを確認済み。

## API接続

接続先は `EXPO_PUBLIC_API_BASE_URL` で切り替える。値は `src/shared/api` を初めてimportしたときにZodで検証する。

```text
EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:4010
```

ローカルではPrism Mock Serverを使える。

```sh
pnpm api:mock <Issue URL>
```

実行環境によってPCのlocalhostへの到達方法が違う。

| 実行環境             | 設定値の例                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| iOS Simulator        | `http://127.0.0.1:4010` (Macのlocalhostを共有する)                                                                                      |
| Android Emulator     | `http://10.0.2.2:4010` (Emulatorから見たホストPC)                                                                                       |
| 実機 (iOS / Android) | 未対応。`pnpm api:mock` のPrismは `127.0.0.1` だけで待ち受けるため、実機からは接続できない。実機で確認する場合はLAN公開の対応を別途行う |

値を変えたら `pnpm --filter mobile start --clear` でMetroのキャッシュを消して再起動する。

## 認証

認証ProviderはAmazon Cognito（User Pool）を使う。
Provider固有SDK・token保存・auth context・login画面は導入していない。導入時は `src/shared/api/http-client.ts` のAxios interceptorで認証ヘッダーを付与し、HTTP層からProvider固有実装を分離する。

## Harness

`.harness/config/harness.json` の `expo` verifierが `typecheck` / `check` / `test` / `doctor` を実行する。
受け入れ条件は `.harness/verification/mobile-env.mjs` で検証する。
