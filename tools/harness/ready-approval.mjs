import { createHash } from 'node:crypto';
import { isBot, canMerge } from './github-pr.mjs';
// #194: ready is the human approval of an SBI Issue with a hand-written Trusted Acceptance. A label carries no content, so the approval is bound
// to the Issue as it was when ready was added: GitHub dates the labeled event, every body edit (userContentEdits, lastEditedAt) and every title
// change (renamed), and any of them at or after the latest ready voids it. Going from A to B and back to A also voids it; the human adds ready again.
// The dates have only seconds, so an edit in the same second as ready counts as after it. Anything GitHub cannot date fails closed.
// On top of the dates, the title and body GitHub kept as they were at ready must have the same digest as what the run takes.
// #200: as for harness-spec, only a human with write access approves; the person who added the latest ready decides.
// The REST body and the GraphQL history may differ only in line endings, which change nothing the run reads.
const digestOf = ({ title, body }) => createHash('sha256').update(JSON.stringify([title ?? null, body?.replaceAll('\r\n', '\n') ?? null])).digest('hex');
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;
const after = (value, readyAt) => { const at = time(value); return Number.isNaN(at) || at >= readyAt; };
const writeRoles = ['admin', 'maintain', 'write'];

// The labeled event of the latest ready; among events in the same second, the last one GitHub lists.
function latestReady(timeline) {
  const labeled = timeline.filter(e => e.event === 'labeled' && e.label?.name === 'ready');
  if (!labeled.length || labeled.some(e => Number.isNaN(time(e.created_at)))) return null;
  return labeled.reduce((latest, e) => time(e.created_at) >= time(latest.created_at) ? e : latest);
}

export function readyBinding({ url, issue, timeline, history }) {
  const ready = latestReady(timeline);
  if (!ready) return [`${url} has no dated labeled event for ready, so the content ready approved is unknown`];
  const readyAt = time(ready.created_at), since = new Date(readyAt).toISOString(), reasons = [], { lastEditedAt, edits } = history;
  // The ready the Issue carries now must be the one the latest labeled event added: not removed since (the same second counts as after),
  // still on the Issue, and not another label renamed to ready (GitHub records no event for a rename; the color is the trace it leaves).
  const current = (issue.labels ?? []).find(l => l.name === 'ready');
  if (timeline.some(e => e.event === 'unlabeled' && e.label?.name === 'ready' && after(e.created_at, readyAt))) reasons.push(`${url} ready was removed after it was added at ${since}; add ready again`);
  if (!current) reasons.push(`${url} has no ready label now, so the labeled event at ${since} approves nothing`);
  else if (current.color && ready.label?.color && current.color !== ready.label.color) reasons.push(`${url} ready label is not the one added at ${since} (color ${ready.label.color} → ${current.color}); add ready again`);
  // An empty connection is "never edited" only when GitHub also reports no last edit; a permission problem can return it empty.
  if (lastEditedAt != null && !edits.length) reasons.push(`${url} edit history is empty although GitHub reports an edit at ${lastEditedAt}; review the Issue and add ready again`);
  if (edits.some(e => after(e.editedAt, readyAt)) || (lastEditedAt != null && after(lastEditedAt, readyAt))) reasons.push(`${url} body was edited after ready was added at ${since}; review the Issue and add ready again`);
  if (edits.some(e => e.deletedAt && after(e.deletedAt, readyAt))) reasons.push(`${url} edit history was changed after ready was added at ${since}; review the Issue and add ready again`);
  const renames = timeline.filter(e => e.event === 'renamed');
  if (renames.some(e => after(e.created_at, readyAt))) reasons.push(`${url} title was changed after ready was added at ${since}; review the Issue and add ready again`);
  if (reasons.length) return reasons;
  // edits are oldest first; without any edit the body was never changed. A version deleted from the history has no body to compare.
  const approved = edits.length ? edits.at(-1) : { body: issue.body };
  const title = renames.length ? renames.at(-1).rename?.to : issue.title;
  if (approved.deletedAt || typeof approved.body !== 'string' || typeof title !== 'string' || digestOf({ title, body: approved.body }) !== digestOf(issue)) {
    reasons.push(`${url} digest of the title and body kept at ready (${since}) does not match the current Issue; review the Issue and add ready again`);
  }
  return reasons;
}

// The same rule as a harness-spec approval (isBot, canMerge); role_name also has to be a write role, so triage or a custom role never approves.
export function readyApprover({ url, actor, access }) {
  const login = actor?.login;
  if (!login) return [`${url} ready was added by an actor GitHub does not record, so nobody approved it`];
  if (isBot(actor)) return [`${url} ready was added by ${login}, a bot; only a human with write access approves an SBI Issue`];
  if (!access || !canMerge(access.permission) || !writeRoles.includes(access.role_name)) {
    return [`${url} ready was added by ${login} without write access (${access ? `${access.permission ?? 'unknown'} / ${access.role_name ?? 'unknown'}` : 'permission unreadable'}); a human with write access has to add ready`];
  }
  return [];
}

// Read after the Issue itself, so an edit made in between shows up here and refuses rather than slipping past. One gh call at a time, as elsewhere.
export async function readReadyBinding({ ref, issue, github }) {
  let timeline, history;
  try { timeline = await github.issueTimeline(ref); history = await github.bodyHistory(ref); }
  catch (error) { return [`${ref.url} timeline or edit history could not be read (${error.message}), so ready cannot be bound to the content it approved`]; }
  const reasons = readyBinding({ url: ref.url, issue, timeline, history }), ready = latestReady(timeline);
  if (!ready) return reasons;
  const { actor } = ready;
  let access = null;
  if (actor?.login && !isBot(actor)) { try { access = await github.collaboratorPermission(ref, actor.login); } catch { access = null; } }
  return [...reasons, ...readyApprover({ url: ref.url, actor, access })];
}
