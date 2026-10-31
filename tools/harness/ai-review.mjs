// AI Review (#175): the Semantic Review every run requires at every Risk level. A trusted adapter is connected through the
// semanticReviewer option of runHarness / resumeRun / approveRun / reverifyPullRequest (the real one is #187). The fake adapter is
// chosen only for the fake provider of harness:demo and the tests; a real provider never falls back to it.
const fakeReview = async () => ({ status: 'PASS', reasons: ['fake AI Review of harness:demo and tests; never counts for a pull request'] });
export function aiReviewer({ provider, semanticReviewer }) {
  if (semanticReviewer) return { adapter: 'connected', review: semanticReviewer };
  if (provider === 'fake') return { adapter: 'fake', review: fakeReview };
  return null;
}
// Fail closed: a missing adapter is NOT_CONFIGURED, and a crash, a missing result or a status other than PASS / FAIL is FAIL.
export async function runAiReview({ provider, semanticReviewer, input }) {
  const reviewer = aiReviewer({ provider, semanticReviewer });
  if (!reviewer) return { enabled: true, status: 'NOT_CONFIGURED', adapter: null, reasons: ['no AI Review adapter is connected; the merge decision stays blocked until one is'] };
  let result;
  try { result = await reviewer.review(input); }
  catch (error) { return { enabled: true, status: 'FAIL', adapter: reviewer.adapter, reasons: [`AI Review adapter failed: ${error.message}`] }; }
  if (!result || !['PASS', 'FAIL'].includes(result.status)) return { enabled: true, status: 'FAIL', adapter: reviewer.adapter, reasons: ['AI Review returned no PASS / FAIL result'] };
  const adapter = reviewer.adapter === 'fake' ? 'fake' : typeof result.adapter === 'string' && result.adapter !== 'fake' ? result.adapter : reviewer.adapter;
  return { ...result, enabled: true, adapter, reasons: result.reasons ?? [] };
}
