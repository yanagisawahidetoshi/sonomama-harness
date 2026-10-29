import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Maestro is not part of the ordinary mobile verifier. A mobile SBI whose Issue asks for E2E needs the maestro CI job: an implementation SBI
// against the mock API (Prism), a validation SBI against the real API, Rails and DB. The job runs on the CI Android Emulator and hands the
// Completion Judge one result file per lane; a missing job, a missing or foreign result, no flow, a failed flow or no kept evidence fails.
const lanes = Object.freeze({ implementation: 'mock', validation: 'real' });
const noE2e = /^\s*(不要|なし|無し|none|n\/a|-)?\s*$/i;

export function maestroLanes(sbis) {
  const mobile = sbi => (sbi.allowedDirs ?? []).some(dir => dir.startsWith('apps/mobile/')) || (sbi.allowedFiles ?? []).some(path => path.startsWith('apps/mobile/'));
  // A missing E2E line is not an answer, so the lane stays required and the Judge fails closed instead of skipping it.
  const target = sbi => sbi.kind === 'validation' || sbi.e2e == null || !noE2e.test(sbi.e2e);
  return [...new Set(sbis.filter(s => s.kind in lanes && mobile(s) && target(s)).map(s => lanes[s.kind]))].sort();
}

const attribute = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
export function maestroResultFromJunit({ lane, junit, headSha, artifacts }) {
  const flows = [...junit.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(([, tag, body = '']) => {
    const failure = /<(failure|error)\b[^>]*>([\s\S]*?)<\/\1>|<(failure|error)\b[^>]*\/>/.exec(body);
    const failed = failure || !['SUCCESS', undefined].includes(attribute(tag, 'status'));
    return { name: attribute(tag, 'name') ?? attribute(tag, 'id') ?? '(unnamed)', status: failed ? 'FAIL' : 'PASS', ...(failed ? { message: (failure?.[2] ?? attribute(tag, 'status') ?? '').trim() } : {}) };
  });
  return { version: 1, lane, headSha, status: flows.length && flows.every(f => f.status === 'PASS') ? 'PASS' : 'FAIL', flows, artifacts };
}

export async function readMaestroResults(dir, wanted) {
  const results = {};
  for (const lane of wanted) {
    let text;
    try { text = await readFile(join(dir, `${lane}.json`), 'utf8'); } catch { continue; }
    try { results[lane] = JSON.parse(text); } catch (error) { results[lane] = { error: error.message }; }
  }
  return results;
}

export function judgeMaestro({ lanes: wanted, needs, results, headSha }) {
  if (!wanted.length) return [];
  const reasons = [];
  const job = needs.maestro?.result ?? 'missing';
  if (job !== 'success') reasons.push(`maestro: ${job} (required for ${wanted.join(', ')})`);
  for (const lane of wanted) {
    const result = results?.[lane];
    const fail = message => reasons.push(`maestro ${lane}: ${message}`);
    if (!result) { fail('no result file from the maestro job'); continue; }
    if (result.error) { fail(`result cannot be read (${result.error})`); continue; }
    if (result.lane !== lane) { fail(`result is for lane ${result.lane}`); continue; }
    if (result.headSha !== headSha) { fail(`result is for ${String(result.headSha).slice(0, 12)}, not ${headSha.slice(0, 12)}`); continue; }
    if (!Array.isArray(result.flows) || !result.flows.length) { fail('no flow ran'); continue; }
    const failed = result.flows.filter(f => f.status !== 'PASS');
    if (failed.length || result.status !== 'PASS') fail(`failed flows ${failed.map(f => f.name).join(', ') || '(status FAIL)'}`);
    if (!Array.isArray(result.artifacts) || !result.artifacts.length) fail('no log or screenshot was kept as evidence');
  }
  return reasons;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => args[args.indexOf(name) + 1];
  const artifacts = args.flatMap((a, i) => args[i - 1] === '--artifact' ? [a] : []);
  const result = maestroResultFromJunit({ lane: value('--lane'), junit: await readFile(value('--junit'), 'utf8').catch(() => ''), headSha: value('--head'), artifacts });
  await writeFile(value('--out'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Maestro ${result.lane}: ${result.status} (${result.flows.length} flows)`);
}
