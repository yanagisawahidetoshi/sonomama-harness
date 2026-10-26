// Independent lifecycles. A gate approval never transitions the merge lifecycle.
export const states = Object.freeze({
  execution: ['PENDING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'JUDGING', 'FAILED', 'DONE', 'ESCALATED'],
  design: ['NOT_REQUIRED', 'WAITING_FOR_DESIGN_APPROVAL', 'APPROVED', 'REJECTED'],
  gate: ['NOT_REQUIRED', 'WAITING_FOR_HUMAN_GATE', 'APPROVED', 'REJECTED'],
  merge: ['NOT_ASSESSED', 'RISK_ASSESSING', 'WAITING_FOR_DESIGN_APPROVAL', 'WAITING_FOR_HUMAN_GATE', 'WAITING_FOR_HUMAN_REVIEW', 'MERGE_ALLOWED', 'REJECTED', 'BLOCKED'],
});
export function assertState(phase, state) {
  if (!states[phase]?.includes(state)) throw new Error(`Invalid ${phase} state: ${state}; this Harness never merges`);
}
