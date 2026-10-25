# Review adapterの接続契約

現在は独立したローカルGit workspaceと人間用CLIを使用する。
将来のGitHub接続でも、Risk ClassifierとMerge Policy Judgeの純粋関数をそのまま使う。

## 実装済みの接続点

- workspace.git / changedFiles: 現在HEADとbaselineからの差分。rename前のパスも判定対象にする。
- verifierRegistry: verifier IDと、信頼するコマンド・AC IDの登録。
- recordDecisionのidentityProvider: 信頼する認証経路からid / kind=human / sourceを返す。
- authenticatedRecords: purpose、SHA、context、取り消しを含む署名済み承認履歴。
- assessRisk: 差分、SBI/AC、Human Gate、AIの上方リスク提案を入力にRulesを評価する。
- mergeDecision: 必須チェック、Risk、認証済み承認を入力に可否だけを返す。
- runHarness/resumeRunのsemanticReviewer: 有効時の意味レビュー。PASS/FAILと任意のriskLevelを返す。

## GitHub adapterで保証すること

現在HEAD・ベース差分・必須check結果を取得し、最新HEADに対する有効な人間のレビューを正規化する。
botやAI、重複人物、取り消し済み・古いSHAのレビューを人数へ含めない。
permissionやreviewer適格性は認証済みサービスの情報で検証する。
Gate承認をPRレビューと混同しない。risk/level-1〜3のラベルは分類結果の投影であり承認の根拠ではない。

Risk/approvalの取得から可否表示までにHEADが変わったら再評価する。
現段階ではMERGEDを書き込まず、merge APIは実装しない。
