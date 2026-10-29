# SONOMAMA 受講生アプリ (apps/mobile)

受講生向けスマホアプリ。Expo SDK 58 + React Native 0.88 + TypeScript。業務画面は後続SBIで追加する。

| 用途          | ライブラリ                                                                     |
| ------------- | ------------------------------------------------------------------------------ |
| Routing       | Expo Router (`src/app`)                                                        |
| Server state  | TanStack Query (staleTime 5分 / gcTime 10分 / 4xxはretryなし・その他は最大3回) |
| HTTP          | Axios (`src/shared/api`)                                                       |
| Form          | React Hook Form + Zod (`@hookform/resolvers`)                                  |
| Lint / Format | Biome (ESLint / Prettierは使わない)                                            |
| Test          | Jest (`jest-expo`) + React Native Testing Library                              |
| E2E           | Maestro (外部CLI、development build対象)                                       |

UI component library・認証・Push通知・AsyncStorage / SecureStore・Analyticsは要件が決まるまで導入しない。
React / React Nativeのversionは`npx expo install`が解決したものを使い、手動でずらさない。

## 前提

通常開発はExpo Goを主対象にする。

- Node 22 (`.node-version`)、pnpm 8 (root `package.json` の `packageManager`)
- 実機で確認する場合: Expo Go
- iOS development build / Maestroを使う場合: Xcode と iOS Simulator
- Android development build / Maestroを使う場合: Android Studio と Android Emulator
- Maestro CLI 2.x (E2Eを実行する場合)。iOS 26系のSimulatorでは、1.x系だとアプリの画面要素を取得できない。2.12.0で確認済み。

## セットアップ

```sh
pnpm install
cp apps/mobile/.env.example apps/mobile/.env.local
```

依存を追加するときは `pnpm --filter mobile exec expo install <package>` でSDK 58互換versionを入れる。
Expo Goで利用できないnative moduleが必要になった場合は、その時点でdevelopment buildへ切り替える。

## コマンド

```sh
pnpm --filter mobile start         # Expo Go向けにMetroを起動してQRコードを表示
pnpm --filter mobile ios           # 必要時のみ: expo run:ios でdevelopment buildを作成
pnpm --filter mobile android       # 必要時のみ: expo run:android でdevelopment buildを作成
pnpm --filter mobile typecheck
pnpm --filter mobile lint          # biome lint
pnpm --filter mobile format:check  # biome format
pnpm --filter mobile check         # biome check (lint + format + import整列)
pnpm --filter mobile test          # Jest + RNTL
pnpm --filter mobile doctor        # expo-doctor (Expo依存の整合確認)
```

`npx expo-doctor` を `apps/mobile` で直接実行しても同じ。

## Expo Go（通常開発）

初期開発ではExpo Goを正式な開発ルートにする。`expo-dev-client` は初期依存として入れない。

```sh
pnpm --filter mobile start
```

`start` scriptは `expo start --go` を実行する。表示されたQRコードを実機のExpo Goで読み取るか、Terminal UIからSimulator / Emulatorを開く。

実機からMetroへ接続できない場合は、同一LANを確認する。公共Wi-Fi等でLAN接続が難しい場合は必要に応じてExpo CLIの`tunnel`を使う。

Expo Goで利用できないnative module、custom native code、ネイティブ設定変更が必要になった場合はdevelopment buildへ切り替える。

## development build（必要時のみ）

通常開発では使わず、Maestro E2EやExpo Goで扱えないnative機能が必要な場合に使う。

```sh
pnpm --filter mobile ios       # 初回は ios/ を生成してビルド (数分かかる)
pnpm --filter mobile android   # 初回は android/ を生成してビルド
```

`ios` scriptは `EXPO_USE_PRECOMPILED_MODULES=0` でExpo modulesをsourceからbuildする。SDK 58.0.19時点のprecompiled `ExpoFileSystem` が `ExpoModulesCore` 58.0.26 と合わず、起動時に `Symbol not found` で落ちるため。
`npx expo run:ios` を直接使う場合も同じ環境変数を付ける。解消したらこの指定を外す。

`ios/` と `android/` は生成物なのでGit管理しない。development buildを使う場合は、2回目以降はインストール済みのアプリを開き、Metroへ接続する。
bundle identifier / application id は暫定で `com.sonomama.student.dev`。

## Maestro smoke test

```sh
brew tap mobile-dev-inc/tap && brew install mobile-dev-inc/tap/maestro
# または curl -fsSL "https://get.maestro.mobile.dev" | bash
```

MaestroはExpo Goではなくdevelopment buildを対象にする。Simulator / Emulator を起動し、development buildをインストールした状態で実行する。

```sh
pnpm --filter mobile start                     # 別ターミナルでMetroを起動
maestro test apps/mobile/.maestro/smoke.yaml   # repo rootから
```

Maestro実行時にdevelopment buildへ接続する必要がある場合は、Expo CLIの起動ターゲットをdevelopment buildへ切り替える。
`smoke.yaml` はアプリを起動し、初期画面の `testID="home-title"` と `SONOMAMA` が表示されることだけを確認する。
Harness / CIのrequired checkには含めない。

### Android Emulator

`expo-dev-client` は入れていないため、Android Emulatorのdevelopment buildは既定で `10.0.2.2:8081`（ホストPCのMetro）からbundleを読む。
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
| 実機 (iOS / Android) | ローカルPrism接続は未対応。`pnpm api:mock` のPrismは `127.0.0.1` だけで待ち受けるため、Expo Go自体は起動できてもローカルMock APIへは接続できない。実機でAPI確認する場合はLAN公開の対応を別途行う |

値を変えたら `pnpm --filter mobile start --clear` でMetroのキャッシュを消して再起動する。

## 認証

認証Provider（Cognito / Google Cloud Identity Platform / Firebase Auth等）は未決定。
Provider固有SDK・token保存・auth context・login画面は導入していない。決定後は `src/shared/api/http-client.ts` のAxios interceptorで認証ヘッダーを付与し、HTTP層からProvider固有実装を分離する。

## Harness

`.harness/config/harness.json` の `expo` verifierが `typecheck` / `check` / `test` / `doctor` を実行する。
受け入れ条件は `.harness/verification/mobile-env.mjs` で検証する。
