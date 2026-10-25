# Rails API placeholder
Rails本体は未生成。Gemfileがない間、Verifierはmissing appとしてSKIPする。
生成後は.harness/config/harness.jsonのrails.commandsにRSpec / RuboCop /
Brakeman / OpenAPIの実行コマンドを登録する。Gemfileだけ追加して検証未設定ならFAIL。
