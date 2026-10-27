import { execute } from './io.mjs';
import { redactText } from './evidence-protection.mjs';
import { githubIssueSchema, githubCommentSchema, githubIssueListSchema, githubCommentListSchema, githubLabelListSchema } from './schemas.mjs';

// GitHub access goes through the authenticated gh CLI. Request bodies are JSON on stdin; no shell expansion, no token handling here.
async function api(method, endpoint, body) {
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
const labelDefinitions = {
  sbi: { color: '0e8a16', description: 'Planner-generated SBI' },
  'needs-review': { color: 'fbca04', description: 'SBI awaiting human review; not ready for the Execution Harness' },
  'api-schema': { color: '1d76db', description: 'Issue with a Planner-generated API Schema Proposal' },
  'needs-api-schema-review': { color: 'fbca04', description: 'API Schema Proposal awaiting human review; implementation must wait' },
  'api-schema-approved': { color: '0e8a16', description: 'Projection of a signed API Schema approval; not the source of truth' },
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
  async updateComment({ owner, repo }, id, body) {
    return githubCommentSchema.parse(await api('PATCH', `repos/${owner}/${repo}/issues/comments/${id}`, { body }));
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
};
