# dependencyの更新（Renovate）

AdminとRails APIのdependency更新は、Renovateが更新ごとにPRを作る。PRの品質判定は通常のPRと同じく、Harness・CI・人のレビューで行い、mergeも人が行う。設定はリポジトリ直下の[renovate.json](../../renovate.json)にある。

## 対象

| 対象 | 更新するファイル |
| --- | --- |
| Admin（`apps/admin`）のnpm dependency | `apps/admin/package.json`と`pnpm-lock.yaml` |
| Rails API（`apps/api`）のgem | `apps/api/Gemfile`と`apps/api/Gemfile.lock` |

## 対象外

| 対象外 | 理由 |
| --- | --- |
| `apps/mobile`、`prototypes/`、`packages/` | ExpoとReact Nativeは、Expo SDKとの互換性とnative buildの制約があり、個別に上げると壊れやすい。packagesは対象に含めていない |
| Expo、React Native関連のpackage（`expo`、`expo-*`、`@expo/*`、`react-native`、`react-native-*`、`@react-native/*`、`eas-cli`） | 上と同じ。Admin側に入っても更新しない |
| Adminの`react`、`react-dom`、`@types/react`、`@types/react-dom` | Adminは、workspace全体で`react`を1つのバージョンに揃えるため、Expo SDK 58が使うReactのバージョンに固定している。Expo SDKを上げるときに一緒に上げる |
| リポジトリ直下の`package.json` | Harnessのtoolと`packageManager`を持つ。変更するとFull Gateが走る |
| GitHub Actions、Dockerfile、`.node-version`、`.ruby-version` | 対象のmanagerをnpmとbundlerだけにしている |
| `pnpm-lock.yaml`全体の作り直し（lock file maintenance） | mobileとprototypesの依存も一緒に書き換わるため無効にしている |

## PRの作られ方

- patchとminorは、dependencyごとにPRを作る。Adminの`devDependencies`のpatchとminorは1つのPRにまとめる。同じmonorepoのpackageもまとめる。
- majorは、patchやminorとは別のPRになり、`major-update`ラベルが付く。RailsやReactのように影響が大きいmajorは、PRをmergeせず専用のSBIに切り出して進めてよい。
- すべてのPRに`dependencies`ラベルが付く。
- auto-mergeは無効。majorを含め、RenovateのどのPRも人がレビューしてmergeする。
- package.jsonのバージョン指定（`^`など）は、新しいバージョンに合わせて書き換える。lockfileだけが変わるPRにはしない。
- 作られていない更新の一覧は、RenovateがGitHub Issueに作るDependency Dashboardで見られる。

## Harnessでの扱い

RenovateのPRも通常のPRと同じHarnessのCIを通る。変更されたファイルからVerifierを選ぶ。

- Adminの更新は`pnpm-lock.yaml`を変えるため、adminに加えてrails・expo・prototype-web・prototype-mobileのVerifierも選ばれる（api-contractも領域の組み合わせで加わる）。Adminの更新が他のworkspaceを壊していないかを、このVerifierで確かめる。
- Rails APIの更新はrailsのVerifierだけが選ばれる。

`apps/`を変えるPRには承認済みSBI Issueが必要だが、RenovateのPRはSBIを持たない。次をすべてGitHub APIで確かめられたときだけ、SBI Issueの要件を外す。Verifier・Security・Riskの判定と人のレビューはそのまま行う。

- PRの作成者が`renovate[bot]`（type `Bot`）である。
- PRのすべてのcommitの作成者が`renovate[bot]`で、GitHubの署名で検証済み（verified）である。`renovate.json`の`platformCommit: "enabled"`で、RenovateはGitHubのAPIからcommitを作り、GitHubが署名する。
- 変更したファイルが`apps/admin/package.json`・`pnpm-lock.yaml`・`apps/api/Gemfile`・`apps/api/Gemfile.lock`だけである。
- CIが検証したcommitがPRのheadで、PRのheadがこのリポジトリにある（forkではない）。

人がPRのbranchにcommitを足した（Update branchを含む）、1ファイルでも範囲外を変えた、GitHubを読めなかった場合は、通常どおりSBI Issueが必要になり、CIはFAILする。信頼するbotと許可するファイルは`.harness/rules/dependency-bots.json`にある。

## 導入手順（人が行う）

1. `renovate.json`がmainに入っていることを確認する。mainに設定が無い状態でインストールすると、Renovateは設定を足すonboarding PRを先に作る。
2. GitHubで[Renovate](https://github.com/apps/renovate)のGitHub Appをこのリポジトリにだけインストールする。
3. Renovateがmainの`renovate.json`を読み、Dependency DashboardのIssueと更新PRを作り始める。

設定を変えたときは、次のコマンドで検証する。

```sh
npx --yes --package renovate@latest -- renovate-config-validator --strict
```
