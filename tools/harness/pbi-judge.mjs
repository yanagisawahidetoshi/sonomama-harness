import { pbiAcceptanceRecordSchema } from './schemas.mjs';

// Deterministic PBI Completion Judge. Inputs come from trusted adapters, never from agent self-reports:
// - sbis: [{ id, kind, dependsOn }] of one PBI.
// - results[sbiId]: implementation → { merged, requiredVerifiers: 'PASS' | ..., e2e: null | { status, api } };
//   validation → { e2e: { status, api }, evidenceDigest }. Missing means not run yet.
// - acceptanceRecords: human records from the identity adapter (purpose pbi-acceptance), bound to the validation evidence digest.
// - blockingBugs: [{ url, state }] linked to the PBI; anything but closed blocks it.
const e2eApis = Object.freeze({ implementation: 'mock', validation: 'real', acceptance: null });
export const e2eApi = kind => e2eApis[kind];

function implementationStatus(id, result, reasons) {
  if (!result) { reasons.push(`実装SBI ${id} の結果がありません`); return 'PENDING'; }
  if (result.e2e && result.e2e.api !== 'mock') { reasons.push(`実装SBI ${id} のE2Eがモック以外（${result.e2e.api}）に接続しています`); return 'FAILED'; }
  if (result.e2e && result.e2e.status !== 'PASS') { reasons.push(`実装SBI ${id} のE2E（モックAPI）が${result.e2e.status}です`); return 'FAILED'; }
  if (result.requiredVerifiers !== 'PASS') { reasons.push(`実装SBI ${id} の必須Verifierが${result.requiredVerifiers ?? '未実行'}です`); return 'FAILED'; }
  if (result.merged !== true) { reasons.push(`実装SBI ${id} のPRがmainへmergeされていません`); return 'PENDING'; }
  return 'DONE';
}
function validationStatus(id, result, reasons) {
  if (!result?.e2e) { reasons.push(`最終確認SBI ${id} のE2E結果がありません`); return 'PENDING'; }
  if (result.e2e.api !== 'real') { reasons.push(`最終確認SBI ${id} のE2Eが実API以外（${result.e2e.api}）に接続しています`); return 'FAILED'; }
  if (result.e2e.status !== 'PASS') { reasons.push(`最終確認SBI ${id} のE2E（実API + Rails + DB）が${result.e2e.status}です`); return 'FAILED'; }
  if (!/^[0-9a-f]{64}$/.test(result.evidenceDigest ?? '')) { reasons.push(`最終確認SBI ${id} のEvidence digestがありません`); return 'FAILED'; }
  return 'DONE';
}
function accepted(pbiUrl, sbiId, validationDigest, records) {
  const latest = new Map();
  for (const raw of records) {
    const parsed = pbiAcceptanceRecordSchema.safeParse(raw);
    if (parsed.success && parsed.data.pbiUrl === pbiUrl && parsed.data.sbiId === sbiId) latest.set(parsed.data.reviewer, parsed.data);
  }
  return [...latest.values()].some(r => r.decision === 'APPROVE' && r.validationDigest === validationDigest);
}

function evaluate({ pbiUrl, sbis, results = {}, acceptanceRecords = [], blockingBugs = [] }) {
  const reasons = [], status = {};
  const of = kind => sbis.filter(s => s.kind === kind);
  for (const sbi of of('implementation')) status[sbi.id] = implementationStatus(sbi.id, results[sbi.id], reasons);
  const implementationsDone = of('implementation').length > 0 && of('implementation').every(s => status[s.id] === 'DONE');
  for (const sbi of of('validation')) status[sbi.id] = implementationsDone ? validationStatus(sbi.id, results[sbi.id], reasons) : 'PENDING';
  const [validation] = of('validation');
  const validated = of('validation').length === 1 && status[validation.id] === 'DONE';
  for (const sbi of of('acceptance')) {
    status[sbi.id] = validated && accepted(pbiUrl, sbi.id, results[validation.id].evidenceDigest, acceptanceRecords) ? 'DONE' : 'PENDING';
    if (status[sbi.id] !== 'DONE') reasons.push(`人間確認SBI ${sbi.id} は最終確認PASS後の人間の承認がありません`);
  }
  for (const [kind, label] of [['validation', '最終確認SBI'], ['acceptance', '人間確認SBI']]) if (of(kind).length !== 1) reasons.push(`${label}が${of(kind).length}件です（1件必要）`);
  for (const bug of blockingBugs) if (bug.state !== 'closed') reasons.push(`未解決のバグ ${bug.url} がPBIをブロックしています`);
  return { status, reasons };
}

// Validation waits for every implementation SBI of the PBI, not only the declared dependencies; acceptance waits for validation PASS.
export function canStart(input, sbiId) {
  const sbi = input.sbis.find(s => s.id === sbiId);
  if (!sbi) return { allowed: false, reasons: [`SBI ${sbiId} はこのPBIにありません`] };
  const { status } = evaluate(input);
  const waiting = sbi.kind === 'implementation' ? sbi.dependsOn.filter(id => status[id] !== 'DONE')
    : sbi.kind === 'validation' ? input.sbis.filter(s => s.kind === 'implementation' && status[s.id] !== 'DONE').map(s => s.id)
    : input.sbis.filter(s => s.kind === 'validation' && status[s.id] !== 'DONE').map(s => s.id);
  return { allowed: waiting.length === 0, reasons: waiting.map(id => `${id} が完了していません`) };
}

export function judgePbi(input) {
  const { status, reasons } = evaluate(input);
  const done = reasons.length === 0 && input.sbis.every(s => status[s.id] === 'DONE');
  return { status: done ? 'DONE' : 'NOT_DONE', sbis: status, reasons };
}
