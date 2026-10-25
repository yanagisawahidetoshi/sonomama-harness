# Secret / Credentialの扱い

SEC-SECRET-001を実行ルールとして参照する。

秘密情報をSBI・ソース・prompt・ログ・Evidence・レビューZIPへ含めない。
環境設定ファイル、秘密鍵、credential保管ファイル、upload用アクセス鍵はコピー・exportから除外する。
秘密値が通常のソースや出力に含まれる場合も検査し、伏せ字化または適用前の停止を行う。
この文書は保管庫ではない。実際の値を貼り付けない。

事前Human Gate、最低LEVEL 3、secret-scanを要求する。
鍵の配置、配布、ローテーション、アクセス権限の具体策は人間が別途決定する。
