# API Schema Plannerの運用（内部機能）

通常のOpenAPI作成・変更は、PlannerのOpenAPI Schema SBIを`pnpm harness:run <SBI Issue URL>`で実行する（README「OpenAPI Schema SBI」）。
以下は旧来の専用フローで、人間向けのpackage scriptからは外している。

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
3. `node tools/harness/cli.mjs api-schema https://github.com/<owner>/<repo>/issues/<number>`を実行する。
4. Quality JudgeがFAILならIssueを直して再実行する。
5. PASSなら`.harness/api-schema/<number>/summary.md`のHuman Reviewを人間が確認する。
   生成物はGit管理対象。commitしてPRで差分レビューする。Execution Harnessはcleanなリポジトリでしか起動しない。
6. 承認する場合は、Proposalをcommitしたうえで`node tools/harness/cli.mjs api-schema-approve <Issue URL>`を実行する。
   取り消しは`--decision revoke`、差し戻しは`--decision request-changes`。
7. `pnpm planner:api-schema-status <Issue URL>`で判定する。APPROVEDならexit 0、それ以外はexit 2。
8. 承認後、人間がopenapi.yamlを`packages/api-schema/openapi.yaml`へ反映し、それを参照するFrontend / Backendの実装SBIを作る。
   Frontendは`pnpm api:mock <Issue URL>`で反映したOpenAPIのMock Serverを使える（[api-mock.md](../../docs/workflows/api-mock.md)）。

承認まではFrontend / Backendの実装へ進めない。

## 承認の正本

承認の正本は`.harness/state/human/api-schema/`の署名付き台帳（Git管理対象外）。Issueのラベルは台帳の状態を映す目印で、正本ではない。
API Schemaを利用する後続処理は、必ず`planner:api-schema-status`（`apiSchemaApprovalStatus`）でAPPROVEDを確認する。ラベルを根拠にしない。

- 承認記録は、Proposal 3ファイル（openapi.yaml・proposal.json・summary.md）のdigestと、承認時のcommit SHAを持つ。
- 判定時は現在のファイルのdigestと一致し、記録したcommitの内容とも一致する承認だけを数える。内容が変われば承認は無効になる。
- Proposalが未commit、人間が生成物を編集した、Quality JudgeがPASSしていない場合は承認を記録しない。
- 生成物の改変は、Plannerが`.harness/state/api-schema/`（Git管理対象外）に署名して残した生成記録の3ファイルのdigestと比べて判定する。proposal.json自身の`files`は参考情報で、改変の判定には使わない。
- 生成記録は生成したPCにだけある。別のPCやcloneでは生成記録がないため承認を記録しない（承認台帳と同じくローカルの信頼状態）。
- Security Impactがあれば異なる人間2人、なければ1人が必要。Security ImpactはHarnessが既存契約とProposalの差分から導出する（`api-schema-security.mjs`）。
  providerの`securityImpact`は申告値で、導出値を欠けばQuality JudgeがFAILし、必要人数は導出値（申告が多ければ申告も）から決める。
  導出の対象: Bearer JWT必須・Rails認可条件・PII、認証必須→公開、認可条件（roles / rule）の削除・緩和・変更、認証・認可付きendpointの削除。
  必要人数は署名付きの生成記録から読み、proposal.jsonからは読まない。同じ人の承認は1人と数え、各人の最新の判断だけを使う。
- 識別は既存の承認台帳と同じくOSユーザー。1台のPCの同じOSユーザーでは2人分にならない。複数人の本運用には認証済み承認adapterを接続する。
- 署名付き台帳に未撤回の承認（APPROVEの後に同じ承認者のREVOKEがない）がある間、Plannerは再生成しない。digest・commit・未commit/未追跡ファイルの有無は問わない。変更する場合は承認者が`--decision revoke`してから再実行する。
  REQUEST_CHANGESと未commitの変更はstatusのAPPROVEDを下げるが、再生成の許可には使わない。解除はREVOKEだけ。

この承認はExecution Harnessの実装前Gate・Design Approval・Merge Approvalとは別の記録で、どれの代わりにもならない。

## Proposalの内容

| 項目 | 表現 |
| --- | --- |
| Endpoint | method、`/api/v1/...`のpath、camelCaseのoperationId、summary、tags、change（add / modify / remove） |
| AuthN | `bearer-jwt`は`security: [bearerAuth]`（HTTP Bearer / JWT。発行する認証Providerは契約に書かない）と401。`public`は`security: []`で401 / 403なし |
| AuthZ | Railsが判定するroleと条件を`x-sonomama-authz`に記録。roleがあれば403 |
| Request | path / query / header parameter、request body、required、type / format / enum、constraints |
| Response | status、body schema、一覧はarray、204はbodyなし |
| Error | 4xx / 5xxはHarnessが定義する共通の`Error`（code / message / details）だけを使う |
| Schema | components。required / nullable（3.1のtype配列）/ enum / format / ref |
| Security | Security Impact（security.jsonの分類）、PII（`x-sonomama-pii` / `x-sonomama-data`）、ログ出力注意 |
| 変更種別 | 既存OpenAPIとの比較による破壊的変更の候補と非破壊の変更 |

proposal.jsonはmachine-readableな提案本体、Quality Judgeの結果、生成ファイルのdigest（参考情報）を持つ。

## Quality Judgeが拒否するもの

method / path / operationIdの欠落・形式違反、operationIdの重複（既存含む）、method + pathの重複、
pathの`{param}`とpath parameterの不一致、未定義schemaへの参照、空のenum、型と合わないexample、
対象外・重複したstatus、2xxなし、204のbody、共通Error以外のerror response、GET / DELETEのrequest body、
401 / 403と認証・認可条件の不整合、Harnessが導出したSecurity Impact（PII・認証・認可、既存契約からの認証解除・認可緩和・削除）の宣言漏れ、security.json外の分類、
Secret / Credentialらしき値、成功responseでのpassword / secret等の返却、既存endpointとの衝突（addで既存あり、modify / removeで既存なし）。

破壊的変更の候補（endpoint削除、property削除、型変更、enum値の削除、必須化など）はFAILにせず、summary.mdに並べて人間が判断する。

## 既存OpenAPIの変更

`modify`は既存operation、同名componentは既存schemaを丸ごと置き換える。providerには既存OpenAPIの構造（説明・exampleを除く）を渡し、残す内容の記載を求める。
生成後のOpenAPIと既存OpenAPIを構造ごと比較し、削除・値の変更・制約の追加（required・enum・format・maxLength等、security、必須parameter・必須request body）を
すべて破壊的変更の候補としてsummary.mdの冒頭の件数と「既存OpenAPIとの構造差分」に出す。提案モデルで表現できない拡張（`x-`）なども対象。
説明・summary・exampleの変更と、任意項目の追加は非破壊として出す。proposal.jsonの`contractDiff`にも同じ内容を残す。

## 再実行

- 生成済みディレクトリは、署名付きの生成記録と3ファイル（openapi.yaml・proposal.json・summary.md）のdigestが一致する場合だけ上書きする。
  人間が編集していた場合や生成記録がない場合は、上書きせずexit 1。
- 別リポジトリの同じ番号のIssueのProposalがあれば上書きしない。
- 署名付き台帳に未撤回の承認があれば再生成しない。Issueに`api-schema-approved`がある場合も再生成しない。
- Issueコメントはmarkerで探して同じコメントを更新する。

既存OpenAPIはOpenAPI 3.1.xだけを読む。openapi.yamlとopenapi.jsonが両方あれば停止する。
providerへは既存OpenAPIから抜き出したendpoint・component・propertyの一覧だけを渡し、ファイル本文は渡さない。

## やらないこと

Rails / Frontendの実装、OpenAPIからのcode generation、API Schemaの自動承認・`ready`化、Execution Harnessでの承認状態の強制、
packages/api-schemaへの自動反映、本番APIへの接続、自動merge。
