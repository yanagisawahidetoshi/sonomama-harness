import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { api } from './planner-github.mjs';
import { execute } from './io.mjs';
import { redactText } from './evidence-protection.mjs';
import { sbiFilePattern } from './sbi-source.mjs';
// ADR-0008: the pull_request run executes the PR and is untrusted evidence. The Completion Judge on pull_request_target reads it as data
// with main's code, and does not pass a PR that changed the producer of that evidence on its own evidence.
export const evidenceWorkflow = '.github/workflows/harness.yml';
// What the pull_request workflow reads and runs: the workflow, the Harness and its rules, and the root dependencies the Harness installs.
const producerPatterns = [/^\.github\//, /^tools\/harness\//, /^\.harness\//, /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.node-version|\.npmrc)$/];
// SBI JSON and generated acceptance registrations are data this Judge verifies against the SBI Issue, not producer code.
const producerData = [sbiFilePattern, /^\.harness\/acceptance\/sbi-[1-9]\d*\.json$/];

export function judgeProducer(files) {
  const paths = [...new Set(files.map(f => f.path))].filter(p => producerPatterns.some(r => r.test(p)) && !producerData.some(r => r.test(p))).sort();
  return { paths, reasons: paths.length ? [`producer changed: ${paths.join(', ')} (the PR's own evidence cannot pass it; a human reviews it)`] : [] };
}

// The latest completed pull_request run of harness.yml for the head; a run of another workflow file the PR added never counts.
export function selectEvidenceRun({ runs, headSha }) {
  return runs.filter(r => r.head_sha === headSha && r.event === 'pull_request' && r.path === evidenceWorkflow && r.status === 'completed')
    .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0] ?? null;
}

// The jobs of that run against the verifiers main's impact requires. The PR-side "harness" job is the old Judge and never counts.
export function judgeEvidenceJobs({ jobs, impact }) {
  const reasons = [];
  const result = job => job.status === 'completed' ? job.conclusion : job.status;
  const byName = new Map(jobs.map(j => [j.name, result(j)]));
  const require = name => {
    const value = byName.get(name) ?? 'missing';
    if (value !== 'success') reasons.push(`${name}: ${value}`);
    return value === 'success';
  };
  const group = (wanted, names) => ({ result: !wanted ? 'skipped' : names.map(require).every(Boolean) ? 'success' : 'failure' });
  const shards = [...byName.keys()].filter(name => /^harness-test \(\d+\)$/.test(name)).sort();
  const needs = {
    impact: group(true, ['impact']),
    verifiers: group(impact.requiredVerifiers.length > 0, impact.requiredVerifiers.map(id => `verifiers (${id})`)),
    'harness-test': group(impact.fullGate, shards.length ? shards : ['harness-test (1)']),
    'harness-demo': group(impact.fullGate, ['harness-demo']),
    maestro: group((impact.maestro ?? []).length > 0, ['maestro']),
  };
  // Any other job may succeed or be skipped, never fail (#163).
  const counted = new Set(['impact', 'harness-demo', 'maestro', ...impact.requiredVerifiers.map(id => `verifiers (${id})`), ...impact.fullGate ? shards : []]);
  for (const [name, value] of byName) if (name !== 'harness' && !counted.has(name) && !['success', 'skipped'].includes(value)) reasons.push(`${name}: ${value}`);
  return { needs, reasons: [...new Set(reasons)] };
}

const runListSchema = z.object({ workflow_runs: z.array(z.object({ id: z.number(), run_attempt: z.number(), head_sha: z.string(), event: z.string(), path: z.string(), status: z.string() }).passthrough()) });
const jobListSchema = z.object({ total_count: z.number(), jobs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }).passthrough()) });

// Waits for the evidence run of the head; the workflow's own timeout ends the wait, and a missing run then fails the required check.
export async function waitForEvidenceRun({ repository, headSha, github = { api }, intervalMs = 30000, timeoutMs = 85 * 60000, log = () => {} }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { workflow_runs: runs } = runListSchema.parse(await github.api('GET', `repos/${repository}/actions/runs?${new URLSearchParams({ head_sha: headSha, event: 'pull_request', per_page: '100' })}`));
    const run = selectEvidenceRun({ runs, headSha });
    if (run) return run;
    if (Date.now() >= until) return null;
    log(`waiting for the pull_request run of ${evidenceWorkflow} on ${headSha.slice(0, 12)}`);
    await sleep(intervalMs);
  }
}

export async function readEvidenceJobs({ repository, run, github = { api } }) {
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const batch = jobListSchema.parse(await github.api('GET', `repos/${repository}/actions/runs/${run.id}/jobs?${new URLSearchParams({ filter: 'latest', per_page: '100', page: String(page) })}`));
    jobs.push(...batch.jobs);
    if (jobs.length >= batch.total_count || batch.jobs.length < 100) return jobs;
  }
  throw new Error(`run ${run.id}: too many jobs`);
}

// An artifact is data: it is unpacked outside both trees and read only through the Zod schemas of the result readers. A missing one is judged as a missing result.
export async function downloadEvidence({ repository, run, name, dir }) {
  await mkdir(dir, { recursive: true });
  const result = await execute('gh', ['run', 'download', String(run.id), '--repo', repository, '--name', name, '--dir', dir], { timeoutMs: 300000 });
  return result.ok ? null : redactText(result.stderr.trim() || result.error || `exit ${result.code}`);
}
