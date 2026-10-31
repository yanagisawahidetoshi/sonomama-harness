# ADR-0001: 実装後Merge ApprovalのSource of TruthをGitHub Reviewにする

- 状態: Accepted（2026-10-27、柳沢英俊がPR #18の再レビュー後に承認）
- 日付: 2026-10-27
- 改訂: Accepted（PR #195 のマージで承認。2026-10-31、#175・#193の決定に合わせて実装前Gateの記述を改めた）
- 判断者: 柳沢英俊
- 関連SBI: Issue #15（GitHub PR Adapter）

## 背景

実装後のMerge Approvalは、ローカルの署名付き台帳（`harness:approve --phase merge`）に記録してきた。この台帳は、人をOSユーザーで識別する。
そのため、別のPCにいる開発者は承認を記録できない。また、Harnessが検証したcommitとGitHub上でレビューしているPRが、同じSHAであることを保証できない。

## 選択肢

| 案 | 却下理由 |
| --- | --- |
| ローカル台帳とGitHub Reviewの両方を必須にする | ローカル台帳は別PCの開発者と共有できない。操作が二重になる割に、本人性の保証はGitHub Reviewより強くならない。どちらが正本かも曖昧になる |
| ローカル台帳だけを使い続ける | チームでレビューする実態と合わない。PR HEADとの一致も確かめられない |

## 決定

- GitHub PR mode（`harness:pr`でPRを作ったrun）では、実装後のMerge ApprovalのSource of TruthをGitHub Reviewにする。
  `harness:approve --phase merge`は要求しない。記録しようとしても拒否する。
- Local mode（PRを作っていないrun）では、従来のローカル台帳を使う。2つの方式を同時には要求しない。
- API Schema Approvalは、ローカル台帳のまま変えない。Design Approvalは#155で、実装前Gateは#175・#193で廃止した。
- 承認として数えるのは、APPROVEDの対象SHA、現在のPR HEAD SHA、Harnessが検証したSHAの3つが一致するReviewだけ。
  botとPR作成者は数えない。同じuserは1人と数え、最新のReviewだけを使う。CHANGES_REQUESTEDは対象SHAにかかわらずブロックする。
- Reviewは、GitHubと同じくリポジトリのwrite以上の権限を持つ人のものだけを数える。read以下の人のCHANGES_REQUESTEDもブロックにしない。
  権限を読めなかった人は、APPROVEDを数えず、CHANGES_REQUESTEDはブロックとして扱う。
- PRのbaseは、runのbaselineに固定する。PR作成時とresume時の両方で、base branchが設定どおりで、PRのbase SHAとbase branchの現在の先頭がbaselineと一致することを求める。
  mainが進んだらBLOCKEDにし、最新のmainからrunを作り直す。こうするとmergeの結果がHarnessの検証したコードと一致する。
  この条件はRulesetの`strict_required_status_checks_policy`より強いため、その設定は読まない。
  「runを作り直す」は、実装を保持したまま最新のmainと統合して検証し直す再検証run（`harness:reverify`）で行う（[ADR-0003](0003-reverify-after-main-update.md)）。base一致の条件は変えない。
- 必須CIは、Harnessの設定とRulesetのrequired status checksの和集合。Rulesetのcheckに`integration_id`があれば、そのGitHub Appのcheck runだけを数える。
- 必要な人数は、既存のRisk Policyに従う（LEVEL 1は0人、LEVEL 2は1人、LEVEL 3は異なる2人以上）。
- Harnessが出すのは`MERGE_ALLOWED`まで。`MERGED`はGitHubの状態を正本とし、Harnessでは生成しない。

## 影響と検証

- GitHub上のReviewやCIは随時変わるので、`harness:resume`のたびにGitHubから取り直して判定する。
- baseの固定により、レビュー待ちの間に別のPRがmainへmergeされると、そのrunはMERGE_ALLOWEDにならない。runの作り直しとReviewのやり直しが必要になる。
- 実装Agentが人間と同じ`gh`の認証で動くと、人間名義のReviewを出せてしまう。これはHarnessでは検出できない。Agentの実行環境に、GitHubの認証情報を渡さない運用で防ぐ。
- 撤回する場合は、PR modeのrunでもローカル台帳を参照するように戻す。GitHub Reviewは`MERGE_ALLOWED`の判定以外には使っていないため、戻しても既存のデータは移行しなくてよい。

ADRへの変更はHuman Gate対象。AIだけで確定しない。
