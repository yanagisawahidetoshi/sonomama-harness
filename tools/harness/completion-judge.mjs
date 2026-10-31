import { securityPassed } from './security-enforcement.mjs';
import { checksPassed } from './verifier.mjs';
export function judge(result, sbi) {
  const { verification, review, security, semanticReview, securityVerification, gateApproved } = result;
  return Boolean(verification?.status === 'PASS' && review?.status === 'PASS'
    && security?.status === 'PASS' && securityPassed(securityVerification) && gateApproved === true
    && (!result.headSha || securityVerification.headSha === result.headSha)
    // AI Review is always run. A FAIL sends the change back to the agent; NOT_CONFIGURED (no adapter yet, #187) lets the execution
    // finish but the merge decision stays blocked on AI Review (merge-policy.mjs).
    && ['PASS', 'NOT_CONFIGURED'].includes(semanticReview?.status) && semanticReview.enabled === true
    && checksPassed(verification.checks)
    && sbi.acceptanceCriteria.length > 0
    && sbi.acceptanceCriteria.every(a => verification.acceptance?.includes(a.id)
      && verification.checks.some(c => c.id === a.verifier && c.status === 'PASS' && c.trust === 'acceptance')));
}
