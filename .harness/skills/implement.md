# SBI実装スキル
日本語で判断する。SBIのGiven/When/Thenとacceptance criteriaをすべて満たす。
前回の検証・レビューの失敗理由を読み、許可されたファイルだけを修正する。
Trusted Acceptance・設定・rules・証跡を変更しない。返すJSONはfilesとescalationのみ。
仕様曖昧、重要設計判断、AuthN/AuthZ/RLS/PII/Migration/ADRへの影響を発見したら、
filesを空にしてescalationに人間への確認事項を記載する。完了の自己申告は不要。

SBI.allowedFilesに明記されたApplication TestはTDDで作成・修正できる。Trusted Acceptance (.harness/verification, tools/harness) には書き込めない。試作と本番のlaneはファイルパスで決まり、Agentは変更できない。
