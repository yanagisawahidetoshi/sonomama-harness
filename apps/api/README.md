# Rails API placeholder

Rails本体はまだ生成していない。Gemfileがない間は、Verifierがmissing appとしてSKIPする。

生成したら、.harness/config/harness.jsonのrailsのcommandsにRSpec / RuboCop / Brakeman / OpenAPIの実行コマンドを登録する。Gemfileだけ追加してcommandsを登録していなければ、検証はFAILになる。
