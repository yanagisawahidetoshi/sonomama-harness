# Project context

- SONOMAMAのPhase 0/1ローカルHarness。apps/api（Rails）・apps/mobile（Expo）・apps/admin（React）は開発環境まで構築済みで、業務機能は後続SBIで追加する。
- このリポジトリはHarness専用。別プロジェクトの動画PoCや参照ファイルを追加しない。
- 常に日本語で会話する。

## 文書の置き場所

| 場所 | 読み手 | 置くもの |
| --- | --- | --- |
| docs/ | 人間 | 設計の考え方・判断理由・ADR・セキュリティ要件・運用の概要 |
| .ai/ | AI | 実装・レビュー時に守る前提・制約・作業手順 |
| .harness/ | Harness | 機械が実行・検証・強制するconfig・rules・verification・skills |

- 同じ内容を複数の層にコピーしない。人間の判断・背景はdocs、AIが守る短い制約は.ai、機械的に強制できるルールは.harnessに置く。
- docs/は通常の実装では読まない。ADR・Security Requirements・人間の設計判断を確かめるときだけ参照する。
- docs/**を新規作成・大きく書き換えるときは、yomiyasuスキルで人間向けに推敲する。AI向けプロンプトとして最適化しない。
