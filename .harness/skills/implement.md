# SBI実装スキル
日本語で判断する。SBIのGiven/When/Thenとacceptance criteriaをすべて満たす。
前回の検証・レビューの失敗理由を読み、許可されたファイル（allowedFiles）と許可されたディレクトリ（allowedDirs）配下だけを修正する。
Trusted Acceptance・設定・rules・証跡を変更しない。返すJSONはfilesとescalationのみ。
SBIは人間が承認済み。SBIに書かれたRisk・Security Impactの範囲はそのまま実装する。
承認済みSBIで決められない判断（仕様曖昧、重要設計判断、SBIに無いAuthN/AuthZ/RLS/PII/Migrationへの影響、ADR変更、
許可範囲外の変更、Design・API契約との矛盾）を発見したら、filesを空にしてescalationに人間が決める事項を具体的に記載する。完了の自己申告は不要。

SBI.allowedFiles・allowedDirsの範囲にあるApplication TestはTDDで作成・修正できる。Trusted Acceptance (.harness/verification, tools/harness) には書き込めない。試作と本番のlaneはファイルパスで決まり、Agentは変更できない。
