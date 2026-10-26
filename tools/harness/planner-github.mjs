import { execute } from './io.mjs';
import { redactText } from './evidence-protection.mjs';
import { githubIssueSchema, githubCommentSchema } from './schemas.mjs';

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
const labelDefinitions = {
  sbi: { color: '0e8a16', description: 'Planner-generated SBI' },
  'needs-review': { color: 'fbca04', description: 'SBI awaiting human review; not ready for the Execution Harness' },
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
  async createIssue({ owner, repo }, { title, body, labels }) {
    return githubIssueSchema.parse(await api('POST', `repos/${owner}/${repo}/issues`, { title, body, labels }));
  },
  async addComment({ owner, repo, number }, body) {
    return githubCommentSchema.parse(await api('POST', `repos/${owner}/${repo}/issues/${number}/comments`, { body }));
  },
};
