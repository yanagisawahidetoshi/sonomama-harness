import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isSecretPath, redactText } from '../evidence-protection.mjs';
import { join } from 'node:path';
import { execute, json, readJson } from '../io.mjs';
import { responseJsonSchema } from '../schemas.mjs';

export function providerCommand(provider, schema, answer, schemaText) {
  if (provider === 'codex') return { command: 'codex', args: ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', schema, '--output-last-message', answer, '-'] };
  if (provider === 'claude') return { command: 'claude', args: ['-p', '--tools', '', '--disallowedTools', 'mcp__*', '--output-format', 'json', '--json-schema', schemaText, '--no-session-persistence'] };
  throw new Error(`Unknown provider: ${provider}`);
}
export async function runAgent({ provider, iteration, prompt, directory, workspace, timeoutMs }) {
  if (provider === 'fake') return {
    files: [{ path: 'greeting.mjs', content: iteration === 1
      ? 'export function greet(name) { return `Hello, ${name}`; }\n'
      : 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }\n' }], escalation: null,
  };
  const schema = join(directory, 'response.schema.json');
  const temporary = await mkdtemp(join(tmpdir(), 'harness-agent-response-'));
  const answer = join(temporary, 'response.json');
  try {
  await json(schema, responseJsonSchema);
  const { command, args } = providerCommand(provider, schema, answer, JSON.stringify(responseJsonSchema));
  const result = await execute(command, args, { cwd: workspace, input: prompt, timeoutMs });
  await json(join(directory, 'provider-process.json'), result);
  if (!result.ok) throw new Error(`${provider}: ${result.error || (result.timedOut ? 'timeout' : result.stderr || `exit ${result.code}`)}`);
  if (provider === 'codex') {
    const response = await readJson(answer);
    await json(join(directory, 'response.json'), response);
    return response;
  }
  const envelope = JSON.parse(result.stdout);
  if (envelope.is_error) throw new Error(`claude: ${envelope.result}`);
  const response = envelope.structured_output ?? JSON.parse(envelope.result);
  await json(join(directory, 'response.json'), response);
  return response;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function makePrompt({ root, sbi, workspace, feedback, rules }) {
  const files = {};
  for (const path of sbi.allowedFiles) {
    if (isSecretPath(path)) { files[path] = '[EXCLUDED SECRET FILE]'; continue; }
    try { files[path] = await readFile(join(workspace, path), 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return redactText([await readFile(join(root, '.harness/skills/implement.md'), 'utf8'),
    'Return JSON only. Do not use tools or edit files directly.',
    JSON.stringify({ sbi, rules, files, feedback }, null, 2)].join('\n'));
}
