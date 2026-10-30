import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { api, githubCli } from './planner-github.mjs';
import { githubPrCli } from './github-pr.mjs';
import { execute } from './io.mjs';
import { redactText } from './evidence-protection.mjs';
import { sbiSnapshotSchema } from './schemas.mjs';
import { maestroLanes } from './maestro.mjs';

// The Maestro E2E evidence of an SBI is what CI judged on the head of its merged Harness PR, never a local or agent-written file:
// the snapshot that PR committed decides the kind and the lane (maestroLanes, as Impact Analysis does), and the result file comes from the
// maestro-results artifact of the workflow run whose harness check (the Completion Judge) passed on that head.
// Anything missing, expired or inconsistent throws, so the PBI stays NOT_DONE with the reason.
const lanes = Object.freeze({ implementation: 'mock', validation: 'real' });
const workflow = '.github/workflows/harness.yml';
const resultSchema = z.strictObject({
  version: z.literal(1), lane: z.enum(['mock', 'real']), headSha: z.string().regex(/^[0-9a-f]{40,64}$/), status: z.enum(['PASS', 'FAIL']),
  flows: z.array(z.strictObject({ name: z.string().min(1), status: z.enum(['PASS', 'FAIL']), message: z.string().optional() })),
  artifacts: z.array(z.string().min(1)),
});
const runListSchema = z.looseObject({ workflow_runs: z.array(z.looseObject({ id: z.number().int(), path: z.string(), head_sha: z.string() })) });
const artifactListSchema = z.looseObject({ artifacts: z.array(z.looseObject({ id: z.number().int(), name: z.string(), expired: z.boolean() })) });

export const githubActionsCli = {
  checkRuns: githubPrCli.checkRuns,
  async workflowRuns({ owner, repo }, checkSuiteId) {
    return runListSchema.parse(await api('GET', `repos/${owner}/${repo}/actions/runs?${new URLSearchParams({ check_suite_id: String(checkSuiteId), per_page: '100' })}`)).workflow_runs;
  },
  async artifacts({ owner, repo }, runId) {
    return artifactListSchema.parse(await api('GET', `repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`)).artifacts;
  },
  // gh downloads and unpacks the artifact; only the file names and contents leave this function.
  async download({ owner, repo }, runId, name) {
    const dir = await mkdtemp(join(tmpdir(), 'harness-maestro-'));
    try {
      const result = await execute('gh', ['run', 'download', String(runId), '-R', `${owner}/${repo}`, '-n', name, '-D', dir], { timeoutMs: 120000 });
      if (!result.ok) throw new Error(`gh run download ${runId} ${name}: ${redactText(result.error || result.stderr.trim() || `exit ${result.code}`)}`);
      const files = {};
      for (const file of await readdir(dir)) files[file] = await readFile(join(dir, file), 'utf8');
      return files;
    } finally { await rm(dir, { recursive: true, force: true }); }
  },
};

async function approvedSnapshot({ ref, sbi, head, github }) {
  const path = `.harness/state/sbi-${sbi.number}.json`;
  const text = await github.fileAt(ref, path, head);
  if (text === null) throw new Error(`merged head ${head.slice(0, 12)} に snapshot ${path} がありません`);
  let parsed;
  try { parsed = sbiSnapshotSchema.safeParse(JSON.parse(text)); } catch (error) { throw new Error(`snapshot ${path} を読めません（${error.message}）`); }
  if (!parsed.success) throw new Error(`snapshot ${path} が不正です（${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}）`);
  const snapshot = parsed.data;
  if (snapshot.source.url !== sbi.issueUrl) throw new Error(`snapshot ${path} は ${snapshot.source.url} のものです`);
  // The Issue can be edited after the merge; the kind CI approved with the snapshot is the one that counts.
  if (snapshot.sbi.kind !== sbi.kind) throw new Error(`Issueの種類 ${sbi.kind} が、merge時のsnapshotのkind ${snapshot.sbi.kind} と一致しません`);
  if (snapshot.sbi.pbiUrl !== ref.url) throw new Error(`snapshot ${path} は別のPBI（${snapshot.sbi.pbiUrl ?? 'なし'}）のSBIです`);
  return snapshot;
}

async function laneResult({ ref, lane, head, actions }) {
  const check = (await actions.checkRuns(ref, head)).filter(r => r.name === 'harness').sort((a, b) => b.id - a.id)[0];
  if (!check || check.status !== 'completed' || check.conclusion !== 'success') throw new Error(`merged head ${head.slice(0, 12)} のharness checkがsuccessではありません`);
  const runs = (await actions.workflowRuns(ref, check.check_suite?.id)).filter(r => r.path === workflow && r.head_sha === head);
  if (runs.length !== 1) throw new Error(`harness check ${check.id} の${workflow}のworkflow runを1件に特定できません（${runs.length}件）`);
  const artifact = (await actions.artifacts(ref, runs[0].id)).find(a => a.name === 'maestro-results');
  if (!artifact || artifact.expired) throw new Error(`workflow run ${runs[0].id} のmaestro-results artifactが${artifact ? '期限切れ' : 'ありません'}`);
  const files = await actions.download(ref, runs[0].id, 'maestro-results');
  const name = `${lane}.json`;
  if (typeof files[name] !== 'string') throw new Error(`maestro-results に ${name} がありません`);
  let parsed;
  try { parsed = resultSchema.safeParse(JSON.parse(files[name])); } catch (error) { throw new Error(`${name} を読めません（${error.message}）`); }
  if (!parsed.success) throw new Error(`${name} が不正です（${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}）`);
  const result = parsed.data;
  // The same conditions as judgeMaestro: a result of another lane or commit, no flow or no kept log is not evidence.
  if (result.lane !== lane) throw new Error(`${name} はlane ${result.lane} の結果です`);
  if (result.headSha !== head) throw new Error(`${name} はcommit ${result.headSha.slice(0, 12)} の結果で、headSha ${head.slice(0, 12)} ではありません`);
  if (!result.flows.length) throw new Error(`${name} で実行したflowがありません`);
  if (!result.artifacts.length) throw new Error(`${name} にログ・スクリーンショットのartifactがありません`);
  const passed = result.status === 'PASS' && result.flows.every(f => f.status === 'PASS');
  return { e2e: { status: passed ? 'PASS' : 'FAIL', api: lane }, evidenceDigest: createHash('sha256').update(files[name]).digest('hex') };
}

export function maestroEvidence({ ref, github = githubCli, actions = githubActionsCli }) {
  return {
    async read({ sbi, pull }) {
      if (!pull?.head?.sha) return { connected: false, reason: 'mainへmergeされたHarness PRが無いため、CIのMaestro E2E Evidenceを読めません' };
      const head = pull.head.sha;
      const snapshot = await approvedSnapshot({ ref, sbi, head, github });
      if (!maestroLanes([snapshot.sbi]).length) return { connected: true, e2e: null };
      return { connected: true, ...await laneResult({ ref, lane: lanes[sbi.kind], head, actions }) };
    },
  };
}
