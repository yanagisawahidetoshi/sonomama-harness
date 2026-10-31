// AI Review (#175): the Semantic Review every run requires at every Risk level. A trusted adapter is connected through the
// semanticReviewer option of runHarness / resumeRun / approveRun / reverifyPullRequest (the real one, agents/ai-review-adapter.mjs, is #187; it reviews with the trusted review provider, not the run's provider). The fake adapter is
// chosen only for the fake provider of harness:demo and the tests; a real provider never falls back to it.
const fakeReview = async ({ headSha }) => ({ status: 'PASS', headSha, reasons: ['fake AI Review of harness:demo and tests; never counts for a pull request'] });
export function aiReviewer({ provider, semanticReviewer }) {
  // The provider-backed adapter (#187) reviews real provider runs only; a fake provider run keeps the fake adapter.
  if (semanticReviewer && !(provider === 'fake' && semanticReviewer.providerBacked)) return { adapter: 'connected', review: semanticReviewer };
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
  // A review counts only for the SHA the Harness asked about, and a fake review never counts for a real provider run.
  if (result.headSha !== input?.headSha) return { enabled: true, status: 'FAIL', adapter: reviewer.adapter, reasons: ['AI Review is not for the reviewed head SHA'] };
  if (reviewer.adapter !== 'fake' && result.adapter === 'fake') return { enabled: true, status: 'FAIL', adapter: 'fake', reasons: ['the fake AI Review adapter never reviews a real provider run'] };
  const adapter = reviewer.adapter === 'fake' ? 'fake' : typeof result.adapter === 'string' && result.adapter !== 'fake' ? result.adapter : reviewer.adapter;
  return { ...result, enabled: true, adapter, reasons: result.reasons ?? [] };
}
