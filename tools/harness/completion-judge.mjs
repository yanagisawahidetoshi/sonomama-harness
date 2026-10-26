import { securityPassed } from './security-enforcement.mjs';
import { checksPassed } from './verifier.mjs';
export function judge(result, sbi) {
  const { verification, review, security, semanticReview, securityVerification, gateApproved } = result;
  return Boolean(verification?.status === 'PASS' && review?.status === 'PASS'
    && security?.status === 'PASS' && securityPassed(securityVerification) && gateApproved === true
    && (!result.headSha || securityVerification.headSha === result.headSha)
    && (!semanticReview?.enabled || semanticReview.status === 'PASS')
    && checksPassed(verification.checks)
    && sbi.acceptanceCriteria.length > 0
    && sbi.acceptanceCriteria.every(a => verification.acceptance?.includes(a.id)
      && verification.checks.some(c => c.id === a.verifier && c.status === 'PASS' && c.trust === 'acceptance')));
}
