import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAgent } from './index.mjs';
import { execute, readJson } from '../io.mjs';

async function mockCli(name, body, test) {
  const root = await mkdtemp(join(tmpdir(), 'harness-provider-'));
  const previous = process.env.PATH;
  try {
    await mkdir(join(root, 'iteration'));
    const command = join(root, name);
    await writeFile(command, `#!${process.execPath}\n${body}`);
    await chmod(command, 0o755);
    process.env.PATH = `${root}:${previous}`;
    await test(root);
  } finally { process.env.PATH = previous; await rm(root, { recursive: true, force: true }); }
}
const options = root => ({ iteration: 1, prompt: 'trusted prompt', directory: join(root, 'iteration'), workspace: root, timeoutMs: 3000 });

describe('CLI adapter protocol', () => {
  describe('given a stub CLI with no model connection', () => {
    it('when Codex writes a structured response then parses the output file and saves process evidence', () => mockCli('codex', `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({files: [], escalation: 'question'}));
    `, async root => {
      const response = await runAgent({ ...options(root), provider: 'codex' });
      assert.equal(response.escalation, 'question');
      assert.equal((await readJson(join(root, 'iteration/provider-process.json'))).code, 0);
    }));
    it('when Claude returns structured_output then parses it', () => mockCli('claude', `
      console.log(JSON.stringify({is_error: false, structured_output: {files: [{path: 'greeting.mjs', content: 'sample'}], escalation: null}}));
    `, async root => {
      const response = await runAgent({ ...options(root), provider: 'claude' });
      assert.equal(response.files[0].content, 'sample');
    }));
    it('when Claude returns a failure then never accepts its content', () => mockCli('claude', `
      console.log(JSON.stringify({is_error: true, result: 'authentication failed'}));
    `, async root => {
      await assert.rejects(runAgent({ ...options(root), provider: 'claude' }), /authentication failed/);
    }));
    it('when a CLI exits nonzero then retains the error evidence', () => mockCli('codex', `
      console.error('permission denied'); process.exitCode = 1;
    `, async root => {
      await assert.rejects(runAgent({ ...options(root), provider: 'codex' }), /permission denied/);
      assert.equal((await readJson(join(root, 'iteration/provider-process.json'))).code, 1);
    }));
    it('when a process exceeds its deadline then kills it and returns a failure', async () => {
      const result = await execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 });
      assert.equal(result.timedOut, true);
      assert.equal(result.ok, false);
    });
  });
});
