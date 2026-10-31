import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { providerAiReviewer } from './ai-review-adapter.mjs';
// #187: the real AI Review adapter runs the trusted review provider (Claude CLI, tool-less) on the reviewed SHA and diff only,
// whatever provider implemented the run, and trusts nothing it returns until the strict schema accepts it.
// The CLI is stubbed here, so these tests never reach a model.
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const secret = 'ghp_' + 'A'.repeat(36);
const input = (overrides = {}) => ({
  provider: 'claude', headSha: head, baselineSha: base, timeoutMs: 3000, workspace: '/nonexistent/workspace',
  sbi: { id: 'SBI-1', title: 'Greeting', description: 'Greet the user', acceptanceCriteria: [{ id: 'AC-1', description: 'greets' }] },
  files: [{ path: 'greeting.mjs', status: 'M', added: 'export const greet = () => "hi";', deleted: '' }],
  verification: { status: 'PASS', checks: [{ id: 'unit', status: 'PASS' }] },
  ...overrides,
});
const verdict = (overrides = {}) => ({ headSha: head, status: 'PASS', riskLevel: 1, reasons: ['matches the SBI'], ...overrides });
// A stub of io.execute that answers like the provider CLI and records what the adapter asked.
const cli = (answer, calls = []) => {
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (typeof answer === 'function') return answer(command, args, options);
    if (command === 'codex') {
      await writeFile(args[args.indexOf('--output-last-message') + 1], typeof answer === 'string' ? answer : JSON.stringify(answer));
      return { ok: true, code: 0, stdout: '', stderr: '' };
    }
    return { ok: true, code: 0, stdout: JSON.stringify({ is_error: false, structured_output: answer }), stderr: '' };
  };
  return { run, calls };
};

describe('Real AI Review adapter', () => {
  describe('given a provider CLI that returns a valid review of the head SHA', () => {
    it('when Claude reviews then returns its PASS bound to the SHA and labelled with the provider', async () => {
      const { run } = cli(verdict());
      const result = await providerAiReviewer({ run })(input());
      assert.deepEqual(result, { adapter: 'claude', ...verdict() });
    });
    it('when Codex implemented the run then Claude reviews it and Codex never runs', async () => {
      const { run, calls } = cli(verdict({ status: 'FAIL', riskLevel: 2, reasons: ['misses AC-1'] }));
      const result = await providerAiReviewer({ run })(input({ provider: 'codex' }));
      assert.deepEqual(calls.map(c => c.command), ['claude']);
      assert.equal(result.adapter, 'claude');
      assert.equal(result.status, 'FAIL');
      assert.equal(result.riskLevel, 2);
    });
    it('when it runs the CLI then runs it with no tools, no advisor, outside the workspace and within the configured timeout', async () => {
      const { run, calls } = cli(verdict());
      await providerAiReviewer({ run })(input());
      const [call] = calls;
      assert.equal(call.command, 'claude');
      assert.deepEqual(call.args.slice(call.args.indexOf('--tools'), call.args.indexOf('--tools') + 2), ['--tools', '']);
      assert.deepEqual(JSON.parse(call.args[call.args.indexOf('--settings') + 1]), { advisorModel: '' });
      assert.deepEqual(call.args.slice(call.args.indexOf('--disallowedTools'), call.args.indexOf('--disallowedTools') + 2), ['--disallowedTools', 'mcp__*']);
      assert.notEqual(call.options.cwd, '/nonexistent/workspace');
      assert.ok(call.options.cwd);
      assert.equal(call.options.timeoutMs, 3000);
    });
    it('when it runs the CLI then loads none of the user customizations and passes only the environment the CLI needs', async () => {
      const { run, calls } = cli(verdict());
      process.env.HARNESS_REVIEW_PROBE = 'must-not-reach-the-reviewer';
      try { await providerAiReviewer({ run })(input()); } finally { delete process.env.HARNESS_REVIEW_PROBE; }
      const [call] = calls;
      assert.ok(call.args.includes('--safe-mode'));
      assert.ok(call.args.includes('--strict-mcp-config'));
      assert.ok(Object.keys(call.options.env).every(key => ['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR'].includes(key)));
      assert.equal(Object.values(call.options.env).includes('must-not-reach-the-reviewer'), false);
    });
    it('when it asks for the answer then the JSON schema has the same limits as the parser', async () => {
      const { run, calls } = cli(verdict());
      await providerAiReviewer({ run })(input());
      const schema = JSON.parse(calls[0].args[calls[0].args.indexOf('--json-schema') + 1]);
      assert.equal(schema.properties.reasons.maxItems, 20);
      assert.equal(schema.properties.reasons.items.maxLength, 500);
    });
    it('when Claude puts the answer in result instead of structured_output then reads it from there', async () => {
      const { run } = cli(() => ({ ok: true, code: 0, stdout: JSON.stringify({ is_error: false, result: JSON.stringify(verdict()) }), stderr: '' }));
      assert.equal((await providerAiReviewer({ run })(input())).status, 'PASS');
    });
    it('when it builds the prompt then gives the head SHA and the diff as data', async () => {
      const { run, calls } = cli(verdict());
      await providerAiReviewer({ run })(input());
      const prompt = calls[0].options.input;
      assert.match(prompt, new RegExp(head));
      assert.match(prompt, /greeting\.mjs/);
      assert.match(prompt, /export const greet/);
      assert.equal(prompt.includes('/nonexistent/workspace'), false);
    });
  });

  describe('given a diff or a response that carries a secret', () => {
    it('when the diff has a secret value or a secret file then the CLI never receives either', async () => {
      const { run, calls } = cli(verdict());
      await providerAiReviewer({ run })(input({ files: [
        { path: 'config.mjs', status: 'M', added: `export const token = "${secret}";`, deleted: '' },
        { path: '.env', status: 'A', added: 'DATABASE_PASSWORD=plain-secret-value', deleted: '' },
      ] }));
      const prompt = calls[0].options.input;
      assert.equal(prompt.includes(secret), false);
      assert.equal(prompt.includes('plain-secret-value'), false);
    });
    it('when the review reasons echo a secret then the returned result masks it', async () => {
      const { run } = cli(verdict({ reasons: [`found ${secret} in config.mjs`] }));
      const result = await providerAiReviewer({ run })(input());
      assert.equal(JSON.stringify(result).includes(secret), false);
    });
  });

  describe('given a provider CLI that does not return a valid review', () => {
    for (const [name, answer] of [
      ['the response has an extra key', verdict({ approved: true })],
      ['the response has no head SHA', (({ headSha, ...rest }) => rest)(verdict())],
      ['the status is neither PASS nor FAIL', verdict({ status: 'MAYBE' })],
      ['the risk level is out of range', verdict({ riskLevel: 0 })],
      ['the structured output is a sentence, not an object', 'looks good to me'],
    ]) {
      it(`when ${name} then rejects the review`, async () => {
        const { run } = cli(answer);
        await assert.rejects(providerAiReviewer({ run })(input()));
      });
    }
    it('when the CLI prints something that is not JSON then rejects the review', async () => {
      const { run } = cli(() => ({ ok: true, code: 0, stdout: 'looks good to me', stderr: '' }));
      await assert.rejects(providerAiReviewer({ run })(input()), /no AI Review answer/);
    });
    it('when the CLI times out then rejects the review', async () => {
      const { run } = cli(() => ({ ok: false, timedOut: true, code: null, stdout: '', stderr: '' }));
      await assert.rejects(providerAiReviewer({ run })(input()), /timeout/);
    });
    it('when the CLI exits nonzero then rejects without repeating its stderr', async () => {
      const { run } = cli(() => ({ ok: false, timedOut: false, code: 1, stdout: '', stderr: `token ${secret}` }));
      await assert.rejects(providerAiReviewer({ run })(input()), error => !error.message.includes(secret));
    });
    it('when Claude reports an error then rejects the review', async () => {
      const { run } = cli(() => ({ ok: true, code: 0, stdout: JSON.stringify({ is_error: true, result: 'authentication failed' }), stderr: '' }));
      await assert.rejects(providerAiReviewer({ run })(input()));
    });
  });

  describe('given a review provider that is not trusted or a Claude CLI that cannot run', () => {
    it('when Codex is named as the review provider then refuses without running any CLI', async () => {
      const { run, calls } = cli(verdict());
      await assert.rejects(providerAiReviewer({ run, reviewProvider: 'codex' })(input({ provider: 'codex' })), /trusted/);
      assert.equal(calls.length, 0);
    });
    it('when the Claude CLI is not installed then rejects the review and never falls back to Codex', async () => {
      const { run, calls } = cli(() => ({ ok: false, timedOut: false, code: null, error: 'spawn claude ENOENT', stdout: '', stderr: '' }));
      await assert.rejects(providerAiReviewer({ run })(input({ provider: 'codex' })));
      assert.deepEqual(calls.map(c => c.command), ['claude']);
    });
  });

  describe('given a run of the fake provider', () => {
    it('when the real adapter is asked to review it then refuses without running a CLI', async () => {
      const { run, calls } = cli(verdict());
      await assert.rejects(providerAiReviewer({ run })(input({ provider: 'fake' })));
      assert.equal(calls.length, 0);
    });
  });
});
