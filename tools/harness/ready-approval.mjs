import { createHash } from 'node:crypto';
// #194: ready is the human approval of an SBI Issue with a hand-written Trusted Acceptance. A label carries no content, so the approval is bound
// to the Issue as it was when ready was added: GitHub dates the labeled event, every body edit (userContentEdits) and every title change (renamed),
// and any of them at or after the latest ready voids it. Going from A to B and back to A also voids it; the human adds ready again.
// The dates have only seconds, so an edit in the same second as ready counts as after it. Anything GitHub cannot date fails closed.
// On top of the dates, the body GitHub kept as it was at ready must have the same digest as the body the run takes (the title is the current one,
// since no rename followed ready).
// The REST body and the GraphQL history may differ only in line endings, which change nothing the run reads.
const digestOf = ({ title, body }) => createHash('sha256').update(JSON.stringify([title ?? null, body?.replaceAll('\r\n', '\n') ?? null])).digest('hex');
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;
const after = (value, readyAt) => { const at = time(value); return Number.isNaN(at) || at >= readyAt; };

export function readyBinding({ url, issue, timeline, edits }) {
  const labeled = timeline.filter(e => e.event === 'labeled' && e.label?.name === 'ready').map(e => time(e.created_at));
  if (!labeled.length || labeled.some(Number.isNaN)) return [`${url} has no dated labeled event for ready, so the content ready approved is unknown`];
  const readyAt = Math.max(...labeled), since = new Date(readyAt).toISOString(), reasons = [];
  if (edits.some(e => after(e.editedAt, readyAt))) reasons.push(`${url} body was edited after ready was added at ${since}; review the Issue and add ready again`);
  if (edits.some(e => e.deletedAt && after(e.deletedAt, readyAt))) reasons.push(`${url} edit history was changed after ready was added at ${since}; review the Issue and add ready again`);
  if (timeline.some(e => e.event === 'renamed' && after(e.created_at, readyAt))) reasons.push(`${url} title was changed after ready was added at ${since}; review the Issue and add ready again`);
  if (reasons.length) return reasons;
  // edits are oldest first; without any edit the body was never changed. A version deleted from the history has no body to compare.
  const approved = edits.length ? edits.at(-1) : { body: issue.body };
  if (approved.deletedAt || typeof approved.body !== 'string' || digestOf({ title: issue.title, body: approved.body }) !== digestOf(issue)) {
    reasons.push(`${url} digest of the body kept at ready (${since}) does not match the current Issue; review the Issue and add ready again`);
  }
  return reasons;
}

// Read after the Issue itself, so an edit made in between shows up here and refuses rather than slipping past. One gh call at a time, as elsewhere.
export async function readReadyBinding({ ref, issue, github }) {
  let timeline, edits;
  try { timeline = await github.issueTimeline(ref); edits = await github.bodyEdits(ref); }
  catch (error) { return [`${ref.url} timeline or edit history could not be read (${error.message}), so ready cannot be bound to the content it approved`]; }
  return readyBinding({ url: ref.url, issue, timeline, edits });
}
