// Deterministic SBI Quality Judge. Structural rules are exact; granularity and wording rules are bounded heuristics.
import { sbiKinds } from './schemas.mjs';
export const limits = Object.freeze({ acceptanceCriteria: 6, changeAreas: 4, scenarios: 8, purposeSentences: 2, estimatedFiles: 10 });
const vagueTerms = ['など', '等々', '適切', 'いい感じ', 'なるべく', '可能な限り', 'できれば', '使いやすい', 'わかりやすい', '十分'];
const vagueWords = /\b(etc|appropriate|properly)\b/i;
// Japanese terminators always end a sentence; ASCII ones only before whitespace or the end, so hosts and versions stay intact.
const sentenceEnd = /[。！？]|[.!?](?=\s|$)/;
const blank = value => typeof value !== 'string' || !value.trim();
// A real test is anything left once static checks, "not needed" and separators are removed: "Vitest + eslint" passes, "lint / tsc のみ" does not.
const staticOnly = /テスト(?:は)?(?:不要|なし)|no tests?|eslint|rubocop|prettier|lint|formatter|format|フォーマット|type ?check|型チェック|型確認|静的解析|tsc|--\S+|不要|なし|none|n\/a|のみ|だけ|only|and|と/gi;
const realTest = value => !blank(value) && /[\p{L}\p{N}]/u.test(value.replace(staticOnly, ''));
const apps = areas => [...new Set(areas.flatMap(area => /^apps\/[^/\s]+/.exec(area.trim())?.[0] ?? []))];

export function judgePlan(sbis, { securityCategories = null } = {}) {
  const findings = [];
  const add = (sbi, rule, reason) => findings.push({ sbi, rule, reason });
  if (!sbis.length) add('*', 'empty-plan', 'SBI候補が1件も生成されていません');
  const ids = sbis.map(s => s.id);
  for (const id of new Set(ids)) if (ids.filter(other => other === id).length > 1) add(id, 'duplicate-id', `SBI ID ${id} が重複しています`);
  for (const sbi of sbis) {
    if (!/^SBI-\d{3}$/.test(sbi.id)) add(sbi.id, 'id-format', `SBI IDは SBI-001 の形式にしてください（${sbi.id}）`);
    if (blank(sbi.title)) add(sbi.id, 'title-blank', 'タイトルが空です');
    if (blank(sbi.purpose)) add(sbi.id, 'purpose-blank', '目的が空です');
    if (!sbi.scope.included.length || sbi.scope.included.some(blank)) add(sbi.id, 'scope-blank', '対象範囲が空です');
    if (sbi.scope.excluded.some(blank)) add(sbi.id, 'scope-blank', '対象範囲（対象外）に空の項目があります');
    if (sbi.acceptanceCriteria.length > limits.acceptanceCriteria) add(sbi.id, 'granularity', `粒度が過大です: 受け入れ要件が${sbi.acceptanceCriteria.length}件（上限${limits.acceptanceCriteria}）`);
    // Validation runs one E2E across the whole PBI, so only implementation SBIs are bounded by change areas.
    if (sbi.kind === 'implementation' && sbi.changeAreas.length > limits.changeAreas) add(sbi.id, 'granularity', `粒度が過大です: 想定変更範囲が${sbi.changeAreas.length}領域（上限${limits.changeAreas}）`);
    if (sbi.scenarios.length > limits.scenarios) add(sbi.id, 'granularity', `粒度が過大です: Scenarioが${sbi.scenarios.length}件（上限${limits.scenarios}）`);
    const sentences = sbi.purpose.split(sentenceEnd).filter(part => part.trim()).length;
    if (sentences > limits.purposeSentences) add(sbi.id, 'single-purpose', `目的が1つに絞られていません（${sentences}文。${limits.purposeSentences}文以内）`);
    if (!sbi.acceptanceCriteria.length) add(sbi.id, 'acceptance-missing', '受け入れ要件がありません');
    const acceptanceIds = sbi.acceptanceCriteria.map(a => a.id);
    for (const id of new Set(acceptanceIds)) if (acceptanceIds.filter(other => other === id).length > 1) add(sbi.id, 'duplicate-acceptance', `受け入れ要件 ${id} が重複しています`);
    for (const criterion of sbi.acceptanceCriteria) {
      if (blank(criterion.description)) { add(sbi.id, 'acceptance-blank', `受け入れ要件 ${criterion.id} が空です`); continue; }
      const term = vagueTerms.find(t => criterion.description.includes(t)) || vagueWords.exec(criterion.description)?.[1];
      if (term) add(sbi.id, 'acceptance-verifiable', `受け入れ要件 ${criterion.id} が検証可能な表現ではありません（「${term}」を具体化してください）`);
    }
    if (!sbi.scenarios.length) add(sbi.id, 'gherkin-missing', 'Gherkin Scenarioがありません');
    const covered = new Set();
    for (const scenario of sbi.scenarios) {
      for (const [keyword, steps] of [['Given', scenario.given], ['When', scenario.when], ['Then', scenario.then]]) {
        if (!steps.length || steps.some(blank)) add(sbi.id, 'gherkin-steps', `Scenario「${scenario.name}」に${keyword}がありません`);
      }
      if (!scenario.acceptanceIds.length) add(sbi.id, 'gherkin-mapping', `Scenario「${scenario.name}」が対応する受け入れ要件を指定していません`);
      for (const id of scenario.acceptanceIds) {
        if (acceptanceIds.includes(id)) covered.add(id);
        else add(sbi.id, 'gherkin-mapping', `Scenario「${scenario.name}」が未定義の受け入れ要件 ${id} を参照しています`);
      }
    }
    for (const id of acceptanceIds) if (!covered.has(id)) add(sbi.id, 'gherkin-mapping', `受け入れ要件 ${id} に対応するScenarioがありません`);
    for (const dependency of new Set(sbi.dependsOn)) {
      if (dependency === sbi.id) add(sbi.id, 'dependency-self', '依存SBIが自分自身を指しています');
      else if (!ids.includes(dependency)) add(sbi.id, 'dependency-unknown', `依存SBI ${dependency} が存在しません`);
    }
    if (!sbi.changeAreas.length || sbi.changeAreas.some(blank)) add(sbi.id, 'change-areas', '想定変更範囲が空です');
    const categories = sbi.securityImpact.filter(category => category !== 'None');
    if (sbi.securityImpact.some(blank)) add(sbi.id, 'security-blank', 'Security Impactに空の項目があります');
    if (categories.length && sbi.securityImpact.includes('None')) add(sbi.id, 'security-mixed', 'Security ImpactにNoneと分類が混在しています');
    for (const category of categories) if (securityCategories && !securityCategories.includes(category)) add(sbi.id, 'security-unknown', `Security Impact ${category} はsecurity.jsonに定義された分類ではありません`);
    if (categories.length && sbi.riskCandidate !== 'L3') add(sbi.id, 'risk-security', `Security Impact（${categories.join(', ')}）があるためRisk candidateはL3が必要です（現在 ${sbi.riskCandidate}）`);
    for (const [key, label] of [['applicationTest', 'Application Test'], ['acceptance', '受け入れ要件'], ['e2e', 'E2E']]) {
      if (blank(sbi.verification[key])) add(sbi.id, 'verification', `検証方法（${label}）が未記載です`);
    }
  }
  judgeKinds(sbis, add);
  judgeGranularity(sbis, add);
  judgeSchemaSbi(sbis, add);
  for (const cycle of dependencyCycles(sbis)) add(cycle[0], 'dependency-cycle', `依存SBIが循環しています: ${cycle.join(' → ')}`);
  return { status: findings.length ? 'FAIL' : 'PASS', findings };
}

// An API contract change is one OpenAPI Schema SBI that changes packages/api-schema only. Every other SBI of the PBI depends on it,
// so the Rails and frontend SBIs start only after the Schema PR is merged (harness:run checks that the Harness PR of the dependency was merged).
const isSchemaArea = area => /^packages\/api-schema(\/|$)/.test(area.trim());
function judgeSchemaSbi(sbis, add) {
  // A validation SBI spans the whole PBI for its E2E, so only an implementation SBI can be the Schema SBI.
  const schemas = sbis.filter(s => s.kind !== 'validation' && s.changeAreas.some(isSchemaArea));
  for (const sbi of schemas) if (sbi.changeAreas.some(area => !isSchemaArea(area))) add(sbi.id, 'schema-sbi', 'OpenAPI Schemaの変更は実装と分け、packages/api-schemaだけを変える1件のSBIにしてください');
  for (const sbi of schemas.slice(1)) add(sbi.id, 'schema-sbi', `OpenAPI Schema SBIは1件にしてください（${schemas.map(s => s.id).join(', ')}）`);
  if (schemas.length !== 1) return;
  const [schema] = schemas;
  const reaches = (id, seen = new Set()) => { if (seen.has(id)) return false; seen.add(id); const deps = sbis.find(s => s.id === id)?.dependsOn ?? []; return deps.includes(schema.id) || deps.some(d => reaches(d, seen)); };
  for (const sbi of sbis.filter(s => s !== schema && !reaches(s.id))) add(sbi.id, 'schema-sbi', `OpenAPI Schema SBI（${schema.id}）に依存させてください`);
}

// A PBI is implementation SBIs, then at most one validation SBI when it needs Integration / E2E. Human acceptance is a PBI Gate, not an SBI.
function judgeKinds(sbis, add) {
  const of = kind => sbis.filter(s => s.kind === kind);
  const implementations = of('implementation').map(s => s.id), validations = of('validation');
  if (!implementations.length) add('*', 'kind-implementation', '実装SBI（implementation）がありません');
  if (validations.length > 1) add('*', 'kind-validation', `最終確認SBI（validation）が${validations.length}件です。PBIごとに1件までです`);
  for (const sbi of sbis.filter(s => !sbiKinds.includes(s.kind))) {
    add(sbi.id, 'kind-unknown', `SBIの種類 ${sbi.kind} は使えません。人間確認はSBIにせず、PBI Human Acceptance Gateで扱います`);
  }
  for (const sbi of of('implementation')) {
    const later = sbi.dependsOn.filter(id => sbis.some(s => s.id === id && s.kind !== 'implementation'));
    if (later.length) add(sbi.id, 'kind-dependency', `実装SBIが最終確認SBI（${later.join(', ')}）に依存しています`);
  }
  for (const sbi of validations) {
    const missing = implementations.filter(id => !sbi.dependsOn.includes(id));
    const extra = sbi.dependsOn.filter(id => !implementations.includes(id));
    if (missing.length) add(sbi.id, 'kind-dependency', `最終確認SBIはすべての実装SBIに依存してください（不足: ${missing.join(', ')}）`);
    if (extra.length) add(sbi.id, 'kind-dependency', `最終確認SBIは実装SBIだけに依存してください（${extra.join(', ')}）`);
  }
}

// One implementation SBI is one layer, one PR of about two hours and at most limits.estimatedFiles files, verified by a real test per scenario.
// Validation spans the whole PBI and its real test is the E2E. Human acceptance is a PBI Gate, not an SBI.
function judgeGranularity(sbis, add) {
  for (const sbi of sbis.filter(s => s.kind === 'implementation')) {
    if (sbi.layers.length !== 1 || sbi.layers.some(blank)) add(sbi.id, 'layer-mixed', `レイヤーは1つにしてください（${sbi.layers.length}件: ${sbi.layers.join(', ') || 'なし'}）`);
    const touched = apps(sbi.changeAreas);
    if (touched.length > 1) add(sbi.id, 'layer-mixed', `レイヤーが混在しています: 想定変更範囲が複数のアプリ（${touched.join(', ')}）にまたがります。アプリごとにSBIを分けてください`);
    if (sbi.estimatedFiles === 0) add(sbi.id, 'granularity', '想定変更ファイル数が0です');
    if (sbi.estimatedFiles > limits.estimatedFiles && blank(sbi.oversizeReason)) add(sbi.id, 'granularity', `粒度が過大です: 想定変更ファイル数が${sbi.estimatedFiles}ファイル（目安${limits.estimatedFiles}）。SBIを分割するか、分割できない理由をoversizeReasonに書いてください`);
    if (!blank(sbi.verification.applicationTest) && !realTest(sbi.verification.applicationTest)) add(sbi.id, 'real-test', `Application Testに実テストがありません（lint / typecheckだけでは不可）: ${sbi.verification.applicationTest}`);
  }
  for (const sbi of sbis.filter(s => s.kind === 'validation')) {
    if (!blank(sbi.verification.e2e) && !realTest(sbi.verification.e2e)) add(sbi.id, 'real-test', `最終確認SBIのE2Eに実テストがありません: ${sbi.verification.e2e}`);
  }
  for (const sbi of sbis) {
    for (const scenario of sbi.scenarios) if (!realTest(scenario.test)) add(sbi.id, 'gherkin-test', `Scenario「${scenario.name}」を検証する実テストがありません（lint / typecheckだけでは不可）`);
  }
}

// After implementation: a PR may exceed its estimate within limits.estimatedFiles, or stay within an estimate above it that the Planner justified.
// Anything else, including a missing estimate, fails closed. The CI Completion Judge applies it to each implementation SBI snapshot.
export function judgeChangedFileCount({ estimatedFiles, changedPaths, limit = limits.estimatedFiles }) {
  const changedFiles = new Set(changedPaths).size;
  if (!Number.isInteger(estimatedFiles) || estimatedFiles < 0) return { status: 'FAIL', changedFiles, estimatedFiles: null, reason: 'SBIの想定変更ファイル数がないため、変更ファイル数を判定できません' };
  if (changedFiles > limit && changedFiles > estimatedFiles) return { status: 'FAIL', changedFiles, estimatedFiles, reason: `変更ファイル数が${changedFiles}ファイルで、目安${limit}ファイルとSBIの想定${estimatedFiles}ファイルを超えています` };
  return { status: 'PASS', changedFiles, estimatedFiles, reason: null };
}

function dependencyCycles(sbis) {
  // Self references and unknown IDs are reported separately; only edges between known SBIs form cycles.
  const graph = new Map(sbis.map(s => [s.id, s.dependsOn.filter(d => d !== s.id && sbis.some(other => other.id === d))]));
  const cycles = [], state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'active') { const start = path.indexOf(id); if (start >= 0 && !cycles.some(c => c.includes(id))) cycles.push([...path.slice(start), id]); return; }
    state.set(id, 'active');
    for (const next of graph.get(id)) visit(next, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of graph.keys()) visit(id, []);
  return cycles;
}

// Dependencies are created before dependents so an SBI Issue can reference the Issue numbers it depends on.
export function creationOrder(sbis) {
  const pending = [...sbis], order = [];
  while (pending.length) {
    const ready = pending.filter(s => s.dependsOn.every(d => d === s.id || order.includes(d) || !sbis.some(other => other.id === d)));
    if (!ready.length) throw new Error(`依存SBIが循環しています: ${pending.map(s => s.id).join(', ')}`);
    for (const sbi of ready) { order.push(sbi.id); pending.splice(pending.indexOf(sbi), 1); }
  }
  return order;
}
