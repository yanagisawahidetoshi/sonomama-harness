# SONOMAMA Mobile Prototype (prototypes/mobile)

デザイナーがExpoとReact Native StorybookでUIを直接試作・検証する場所（Executable Design Workspace）。
**本番コードではない。** 受講生アプリの本番実装は `apps/mobile` にあり、ここからコピーして本番化しない。

Expo SDK 58 + React Native 0.88 + TypeScript + Expo Router + React Native Storybook 10 + Biome。UI component libraryはDesign Systemの方針が決まるまで導入しない。

## 前提

- Node 22 (`.node-version`)、pnpm 8 (root `package.json` の `packageManager`)
- iOS: Xcode と iOS Simulator / Android: Android Studio と Android Emulator

## コマンド

```sh
pnpm install                                       # repo rootで実行
pnpm --filter prototype-mobile start               # Expo Router版の試作アプリ (Metro)
pnpm --filter prototype-mobile ios                 # development buildを作ってiOS Simulatorで起動
pnpm --filter prototype-mobile android             # development buildを作ってAndroid Emulatorで起動
pnpm --filter prototype-mobile storybook           # Storybook版で起動 (Metro)
pnpm --filter prototype-mobile typecheck
pnpm --filter prototype-mobile check               # Biome (lint + format + import整列)
pnpm --filter prototype-mobile doctor              # expo-doctor
```

`ios` scriptは `EXPO_USE_PRECOMPILED_MODULES=0` でExpo modulesをsourceからbuildする（SDK 58のprecompiled `ExpoFileSystem` が起動時に落ちるため。apps/mobileと同じ）。

## Storybook

Storybookは専用のentry pointで起動し、Expo Routerのrouteには入れない。

| 起動 | 環境変数 | entry |
| --- | --- | --- |
| 通常 | なし | `index.ts` → `expo-router/entry` (`src/app`) |
| Storybook | `EXPO_PUBLIC_STORYBOOK_ENABLED=true` | `index.ts` → `.rnstorybook` |

`metro.config.js` の `withStorybook` も同じ変数を見て、通常起動ではStorybookをbundleから外す。

iOS Simulator / Android Emulatorで見るには、先にdevelopment buildを入れておく。

```sh
EXPO_PUBLIC_STORYBOOK_ENABLED=true pnpm --filter prototype-mobile ios   # 初回: buildしてStorybookで起動
pnpm --filter prototype-mobile storybook                                # 2回目以降: Metroだけ起動し、Simulator / Emulatorのアプリを開く
```

通常の試作アプリに戻すときは `pnpm --filter prototype-mobile start` でMetroを起動し直す。

## Storyの追加

1. `src/components/<ComponentName>/index.tsx` にcomponentを作る。Propsは `interface Props`。スタイルは同じ場所の `styles.ts` に書き、ライト・ダークのsemantic colorを使う。
2. 同じ場所に `<ComponentName>.stories.tsx` を置く。`title` はディレクトリパス（例: `components/LessonCard`）に合わせる。
3. variant、loading / empty / errorの状態、長い文字列をそれぞれStoryにする。タップで変わる簡単な状態はcomponent内のstateで確認する。
4. Metroの起動時に `.rnstorybook/storybook.requires.ts` が再生成される。手動で作り直すときは `pnpm --filter prototype-mobile storybook-generate`。

サンプルは `src/components/LessonCard`。

## mock data

- 表示に使うデータは `src/mocks/` のlocal mock dataだけにする。実ユーザーのデータは使わない。
- Production / Staging APIへ接続しない。API clientやfetchを入れない。OpenAPI由来のmockが必要なら `pnpm api:mock <Issue URL>` のPrism Mock Serverを使う（任意）。
- secret / token / `.env` をここに置かない。AsyncStorage / SecureStore / Push / 認証SDKも入れない。Harnessのsecret scanで検出される。

## 本番への昇格 (Promotion Flow)

```text
Figma / Design Intent
  → prototypes/mobile で試作
  → Storybook / Simulator Review
  → Design Approval
  → Production SBI（promotion.source = prototypes/mobile）
  → apps/mobile で実装
  → Production Harness
```

prototypeのPASSは本番実装の承認にならない。Design Approvalのあと、新しいProduction SBIで `apps/mobile` に実装し直し、本番の検証を通す。

## Harness

prototype laneの `prototype-mobile` verifierが install / typecheck / Biome check / expo-doctor を実行する。secret scanは全runで必須。
受け入れ条件は `.harness/verification/prototype-mobile-env.mjs` で検証する。

`storybook` の本体はrepo rootのdevDependencyにある。prototypes/mobileに直接入れると、`node_modules/.bin/storybook` と `storybook` scriptが衝突してexpo-doctorが失敗するため。
