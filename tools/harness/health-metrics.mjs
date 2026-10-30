// Observation data for a future Harness Observer. Derived from the run summary only; never read back by any judge.
export const healthMetricsVersion = 1;
const count = checks => {
  const summary = { pass: 0, fail: 0, skip: 0, notConfigured: 0 };
  for (const c of checks || []) {
    if (c.status === 'PASS') summary.pass++; else if (c.status === 'FAIL') summary.fail++;
    else if (c.status === 'SKIP') summary.skip++; else if (c.status === 'NOT_CONFIGURED') summary.notConfigured++;
  }
  return summary;
};
export function healthMetrics(summary) {
  const last = summary.iterations?.at(-1) ?? null;
  const finishedAt = summary.cleanedAt ?? summary.events?.at(-1)?.at ?? null;
  const execution = summary.events?.filter(e => e.phase === 'execution') ?? [];
  const implementingAt = execution.find(e => e.status === 'IMPLEMENTING')?.at ?? null;
  const elapsed = (from, until) => from && until ? Date.parse(until) - Date.parse(from) : null;
  const risk = summary.risk ? { level: summary.risk.level, phase: 'post-execution' } : summary.riskPreflight ? { level: summary.riskPreflight.level, phase: 'preflight' } : { level: null, phase: null };
  const security = summary.securityAssessment ?? null;
  const merge = summary.merge ?? {};
  // Only the code is observation data. The human-facing reason text stays in escalation.json and may carry PII.
  const escalation = summary.status === 'ESCALATED' || summary.executionStatus === 'ESCALATED' ? { code: summary.escalation?.code ?? 'UNKNOWN' } : null;
  return {
    version: healthMetricsVersion,
    runId: summary.id, sbiId: summary.sbi ?? null, lane: summary.lane?.name ?? null, provider: summary.provider ?? null,
    startedAt: summary.startedAt ?? null, finishedAt,
    // durationMs is lifecycle elapsed time including human waits. executionDurationMs spans the first IMPLEMENTING
    // event to the last execution-phase event, so gate waits before implementation are excluded; null if never implemented.
    durationMs: elapsed(summary.startedAt, finishedAt), executionDurationMs: elapsed(implementingAt, execution.at(-1)?.at),
    executionStatus: summary.executionStatus ?? null, mergeStatus: merge.state ?? null,
    riskLevel: risk.level, riskPhase: risk.phase, autoMergeEligible: merge.autoMergeEligible === true,
    cleaned: Boolean(summary.cleanedAt),
    iterations: {
      total: summary.iterations?.length ?? 0, failed: summary.iterations?.filter(i => i.completion !== true).length ?? 0,
      done: summary.executionStatus === 'DONE', limitReached: escalation?.code === 'ITERATION_LIMIT', consecutiveFailure: escalation?.code === 'CONSECUTIVE_FAILURE',
    },
    verifiers: { summary: count(last?.verification?.checks), checks: (last?.verification?.checks ?? []).map(c => ({ id: c.id, status: c.status, required: c.required === true })) },
    security: {
      securitySensitive: security?.securitySensitive ?? null, matchedRules: security?.matchedRules ?? [],
      requiredVerifierCount: security ? security.requiredVerifiers?.length ?? 0 : null,
      preImplementationGateRequired: security?.requiresPreImplementationGate ?? null,
      verification: count(last?.securityVerification?.checks),
    },
    approvals: {
      implementationGate: { required: summary.gate?.required === true, state: summary.gate?.state ?? 'NOT_REQUIRED' },
      merge: { required: merge.requiredApprovals ?? null, valid: merge.validApprovals ?? null, requestedChanges: merge.reasons?.includes('human_requested_changes') === true },
    },
    review: {
      policyReview: last?.review?.status ?? 'NOT_RUN',
      semanticReview: { enabled: last?.semanticReview?.enabled ?? false, status: last?.semanticReview?.status ?? 'NOT_RUN' },
      humanReviewRequired: typeof merge.requiredApprovals === 'number' ? merge.requiredApprovals > 0 : null,
    },
    escalation,
  };
}
