# API Schema Plannerの運用

API変更を伴うPBI / SBIは、実装前にOpenAPIの契約を人間が承認する。PlannerはProposalの生成までを担当し、承認・実装・mergeはしない。

```text
GitHub Issue → Requirement Reader → Existing API Schema Reader（packages/api-schema/openapi.yaml|json）
  → API Schema Planner（codex / claude）→ API Schema Quality Judge
  → PASS: .harness/api-schema/<issue-number>/ に openapi.yaml・proposal.json・summary.md
          Issueへ [api-schema][needs-api-schema-review] とProposal要約コメント → Human Review
  → FAIL: ファイルもGitHubも書かずexit 1で理由を表示
```

## 手順

1. Issueに対象画面・操作・データ・権限の要件を書く。
2. `gh auth status`で対象リポジトリへissues: writeできることを確認する。
3. `pnpm planner:api-schema https://github.com/<owner>/<repo>/issues/<number> --provider claude`を実行する。
4. Quality JudgeがFAILならIssueを直して再実行する。
5. PASSなら`.harness/api-schema/<number>/summary.md`のHuman Reviewを人間が確認する。
   生成物はGit管理対象。commitしてPRで差分レビューする。Execution Harnessはcleanなリポジトリでしか起動しない。
6. 承認する場合は`needs-api-schema-review`を外して`api-schema-approved`を付ける。
   Plannerは承認ラベルを作成しないため、リポジトリで初回だけ人間が作成する。
   `gh label create api-schema-approved --color 0e8a16 --description "Human-approved API Schema Proposal"`
   `gh issue edit <number> --remove-label needs-api-schema-review --add-label api-schema-approved`
7. 承認後、人間がopenapi.yamlを`packages/api-schema/openapi.yaml`へ反映し、それを参照するFrontend / Backendの実装SBIを作る。

承認まではFrontend / Backendの実装へ進めない。API Schemaの承認はGitHubラベルで記録し、
Execution Harnessの実装前Gate・Merge Approval（署名付き承認台帳）とは別物として扱う。どちらの代わりにもならない。

## Proposalの内容

| 項目 | 表現 |
| --- | --- |
| Endpoint | method、`/api/v1/...`のpath、camelCaseのoperationId、summary、tags、change（add / modify / remove） |
| AuthN | `cognito-jwt`は`security: [cognitoJwt]`と401。`public`は`security: []`で401 / 403なし |
| AuthZ | Railsが判定するroleと条件を`x-sonomama-authz`に記録。roleがあれば403 |
| Request | path / query / header parameter、request body、required、type / format / enum、constraints |
| Response | status、body schema、一覧はarray、204はbodyなし |
| Error | 4xx / 5xxはHarnessが定義する共通の`Error`（code / message / details）だけを使う |
| Schema | components。required / nullable（3.1のtype配列）/ enum / format / ref |
| Security | Security Impact（security.jsonの分類）、PII（`x-sonomama-pii` / `x-sonomama-data`）、ログ出力注意 |
| 変更種別 | 既存OpenAPIとの比較による破壊的変更の候補と非破壊の変更 |

proposal.jsonはmachine-readableな提案本体、Quality Judgeの結果、生成ファイルのdigestを持つ。

## Quality Judgeが拒否するもの

method / path / operationIdの欠落・形式違反、operationIdの重複（既存含む）、method + pathの重複、
pathの`{param}`とpath parameterの不一致、未定義schemaへの参照、空のenum、型と合わないexample、
対象外・重複したstatus、2xxなし、204のbody、共通Error以外のerror response、GET / DELETEのrequest body、
401 / 403と認証・認可条件の不整合、PII・認証・認可に対するSecurity Impactの宣言漏れ、security.json外の分類、
Secret / Credentialらしき値、成功responseでのpassword / secret等の返却、既存endpointとの衝突（addで既存あり、modify / removeで既存なし）。

破壊的変更の候補（endpoint削除、property削除、型変更、enum値の削除、必須化など）はFAILにせず、summary.mdに並べて人間が判断する。

## 再実行

- 生成済みディレクトリは、proposal.jsonに記録したdigestとopenapi.yaml・summary.mdが一致する場合だけ上書きする。
  人間が編集していたら上書きせずexit 1。
- 別リポジトリの同じ番号のIssueのProposalがあれば上書きしない。
- Issueに`api-schema-approved`があれば再生成しない。変更するときは人間がラベルを外す。
- Issueコメントはmarkerで探して同じコメントを更新する。

既存OpenAPIはOpenAPI 3.1.xだけを読む。openapi.yamlとopenapi.jsonが両方あれば停止する。
providerへは既存OpenAPIから抜き出したendpoint・component・propertyの一覧だけを渡し、ファイル本文は渡さない。

## やらないこと

Rails / Frontendの実装、OpenAPIからのcode generation、Mock server、API Schemaの自動承認・`ready`化、
packages/api-schemaへの自動反映、本番APIへの接続、自動merge。
