import { execute } from './io.mjs';
import { redactText } from './evidence-protection.mjs';
import { githubIssueSchema, githubCommentSchema, githubIssueListSchema, githubCommentListSchema, githubLabelListSchema, githubTimelineSchema, githubPullSchema, githubPullCommitsSchema } from './schemas.mjs';

// GitHub access goes through the authenticated gh CLI. Request bodies are JSON on stdin; no shell expansion, no token handling here.
export async function api(method, endpoint, body) {
  const args = ['api', ...(method === 'GET' ? [] : ['-X', method]), endpoint, ...(body ? ['--input', '-'] : [])];
  const result = await execute('gh', args, { input: body ? JSON.stringify(body) : '', timeoutMs: 60000 });
  if (!result.ok) {
    const detail = result.error || (result.timedOut ? 'timeout' : result.stderr.trim() || `exit ${result.code}`);
    const error = new Error(`gh api ${method} ${endpoint}: ${redactText(detail)}`);
    error.httpStatus = /HTTP (\d{3})/.exec(result.stderr)?.[1] || null;
    throw error;
  }
  return JSON.parse(result.stdout);
}
// The list endpoints are read in full so a re-run sees every earlier SBI Issue; search would be eventually consistent.
async function listAll(endpoint, query, schema) {
  const items = [];
  for (let page = 1; page <= 50; page++) {
    const batch = schema.parse(await api('GET', `${endpoint}?${new URLSearchParams({ ...query, per_page: '100', page: String(page) })}`));
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`gh api GET ${endpoint}: too many pages`);
}
// The GraphQL edit history of an Issue body, oldest first.
async function userContentEdits({ owner, repo, number }) {
  const query = 'query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){issue(number:$number){userContentEdits(first:100,after:$after){nodes{editedAt deletedAt diff} pageInfo{hasNextPage endCursor}}}}}';
  const versions = [];
  let after = null;
  for (let page = 0; page < 50; page++) {
    const edits = (await api('POST', 'graphql', { query, variables: { owner, repo, number, after } }))?.data?.repository?.issue?.userContentEdits;
    if (!edits) throw new Error(`GraphQL: edit history of ${owner}/${repo}#${number} is unavailable`);
    versions.push(...edits.nodes);
    // GitHub returns the edits newest first. editedAt has only seconds, so the API order (reversed) is kept instead of sorting by time.
    if (!edits.pageInfo.hasNextPage) return versions.reverse();
    after = edits.pageInfo.endCursor;
  }
  throw new Error(`GraphQL: edit history of ${owner}/${repo}#${number} has too many pages`);
}
const labelDefinitions = {
  sbi: { color: '0e8a16', description: 'Planner-generated SBI' },
  'needs-review': { color: 'fbca04', description: 'SBI awaiting human review; not ready for the Execution Harness' },
  'api-schema': { color: '1d76db', description: 'Issue with a Planner-generated API Schema Proposal' },
  'needs-api-schema-review': { color: 'fbca04', description: 'API Schema Proposal awaiting human review; implementation must wait' },
  'api-schema-approved': { color: '0e8a16', description: 'Projection of a signed API Schema approval; not the source of truth' },
  'spec-approved': { color: '0e8a16', description: 'Projection of a harness-spec approval comment; not the source of truth' },
};
export const githubCli = {
  async fetchIssue({ owner, repo, number }) {
    return githubIssueSchema.parse(await api('GET', `repos/${owner}/${repo}/issues/${number}`));
  },
  async ensureLabels({ owner, repo }, labels) {
    for (const name of labels) {
      try { await api('GET', `repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`); }
      catch (error) {
        if (error.httpStatus !== '404') throw error;
        await api('POST', `repos/${owner}/${repo}/labels`, { name, ...labelDefinitions[name] });
      }
    }
  },
  async listIssues({ owner, repo }, label) {
    return (await listAll(`repos/${owner}/${repo}/issues`, { labels: label, state: 'all' }, githubIssueListSchema)).filter(issue => !issue.pull_request);
  },
  async listComments({ owner, repo, number }) {
    return listAll(`repos/${owner}/${repo}/issues/${number}/comments`, {}, githubCommentListSchema);
  },
  // GitHub reports maintain as write and triage as read. A non-collaborator is none.
  async permission({ owner, repo }, login) {
    return (await api('GET', `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`)).permission;
  },
  async updateComment({ owner, repo }, id, body) {
    return githubCommentSchema.parse(await api('PATCH', `repos/${owner}/${repo}/issues/comments/${id}`, { body }));
  },
  async updateIssue({ owner, repo, number }, { body }) {
    return githubIssueSchema.parse(await api('PATCH', `repos/${owner}/${repo}/issues/${number}`, { body }));
  },
  async createIssue({ owner, repo }, { title, body, labels }) {
    return githubIssueSchema.parse(await api('POST', `repos/${owner}/${repo}/issues`, { title, body, labels }));
  },
  async addLabels({ owner, repo, number }, labels) {
    return githubLabelListSchema.parse(await api('POST', `repos/${owner}/${repo}/issues/${number}/labels`, { labels }));
  },
  async removeLabel({ owner, repo, number }, name) {
    return githubLabelListSchema.parse(await api('DELETE', `repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(name)}`));
  },
  async addComment({ owner, repo, number }, body) {
    return githubCommentSchema.parse(await api('POST', `repos/${owner}/${repo}/issues/${number}/comments`, { body }));
  },
  // A file as committed at a commit; null when that commit does not have it.
  async fileAt({ owner, repo }, path, ref) {
    let file;
    try { file = await api('GET', `repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({ ref })}`); }
    catch (error) { if (error.httpStatus === '404') return null; throw error; }
    if (file?.type !== 'file' || file.encoding !== 'base64') throw new Error(`${path} at ${ref} is not a file`);
    return Buffer.from(file.content, 'base64').toString('utf8');
  },
  // Every version of an Issue body that GitHub keeps in its edit history, oldest first. A version deleted from the history has no body.
  async bodyVersions(ref) {
    return (await userContentEdits(ref)).map(v => ({ body: v.deletedAt ? null : v.diff, deletedAt: v.deletedAt ?? null }));
  },
  // When each body edit happened, the body it left and when a version was deleted from the history (#194: ready binds to the body as it was when it was added).
  async bodyEdits(ref) {
    return (await userContentEdits(ref)).map(v => ({ editedAt: v.editedAt ?? null, deletedAt: v.deletedAt ?? null, body: v.deletedAt ? null : v.diff ?? null }));
  },
  // GitHub issue dependencies: the Issues registered as blocking this one (blocked by).
  async blockedBy({ owner, repo, number }) {
    return listAll(`repos/${owner}/${repo}/issues/${number}/dependencies/blocked_by`, {}, githubIssueListSchema);
  },
  async issueTimeline({ owner, repo, number }) {
    return listAll(`repos/${owner}/${repo}/issues/${number}/timeline`, {}, githubTimelineSchema);
  },
  async fetchPull({ owner, repo }, number) {
    return githubPullSchema.parse(await api('GET', `repos/${owner}/${repo}/pulls/${number}`));
  },
  async pullCommits({ owner, repo }, number) {
    return listAll(`repos/${owner}/${repo}/pulls/${number}/commits`, {}, githubPullCommitsSchema);
  },
  async pullCommitMessages({ owner, repo }, number) {
    return (await listAll(`repos/${owner}/${repo}/pulls/${number}/commits`, {}, githubPullCommitsSchema)).map(c => c.commit.message);
  },
};
