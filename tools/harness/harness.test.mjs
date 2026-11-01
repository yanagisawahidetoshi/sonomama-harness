import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, readdir, writeFile, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, judge, providerCommand, runExitCode } from './index.mjs';
import { execute } from './io.mjs';

import { fixture, update, runFixture as runHarness } from './test-fixture.mjs';

describe('Local Harness', () => {
  describe('given a valid workspace with placeholder apps', () => {
    it('when checked then accepts the configuration and SBI', () => fixture(async root => {
      assert.equal((await check(root)).ok, true);
    }));
    it('when the fake agent runs then records FAIL → repair → PASS → review → DONE', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.iterations.length, 2);
      assert.equal(run.iterations[0].verification.status, 'FAIL');
      assert.equal(run.iterations[1].verification.status, 'PASS');
      assert.equal(run.iterations[1].review.status, 'PASS');
      assert.equal(run.iterations[1].verification.checks.filter(c => c.status === 'SKIP').length, 14);
      for (let i = 1; i <= 2; i++) {
        for (const file of ['agent.log', 'verify.log', 'result.json']) {
          assert.ok((await readFile(join(root, run.runDir, `iteration-${i}`, file), 'utf8')).length);
        }
      }
      assert.equal(JSON.parse(await readFile(join(root, run.runDir, 'summary.json'))).executionStatus, 'DONE');
      assert.equal(JSON.parse(await readFile(join(root, '.harness/state/runs', `${run.id}.json`))).executionStatus, 'DONE');
      const second = await runHarness({ root, quiet: true });
      assert.notEqual(second.id, run.id);
      assert.equal(second.iterations[0].verification.status, 'FAIL');
    }));
    it('when three consecutive verifications fail then escalates and stops', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: async () => ({ files: [{ path: 'greeting.mjs', content: 'export const greet = () => "wrong";' }] }) });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.iterations.length, 3);
      assert.match(run.reason, /3/);
    }));
    it('when review rejects a verified change then retries with review feedback', () => fixture(async root => {
      let count = 0;
      const run = await runHarness({ root, quiet: true, reviewer: async () => ++count === 1 ? { status: 'FAIL', reasons: ['Please repair review finding'] } : { status: 'PASS', reasons: [] } });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.iterations.length, 3);
      assert.equal(run.iterations[1].review.status, 'FAIL');
      assert.match(await readFile(join(root, run.runDir, 'iteration-3/prompt.txt'), 'utf8'), /Please repair review finding/);
    }));
  });
  describe('given unsafe or incomplete input', () => {
    for (const risk of ['AuthN', 'AuthZ', 'RLS', 'PII', 'Migration', 'ADR']) {
      // #175: the human approved this Risk with the SBI, so the run implements it and keeps level 3 for the review after implementation.
      it(`when an approved SBI declares ${risk} then invokes the agent without an implementation gate and keeps level 3`, () => fixture(async root => {
        await update(root, '.harness/state/sample-sbi.json', s => s.risks = [risk]);
        let called = false;
        const run = await runHarness({ root, quiet: true, agent: async () => { called = true; return { escalation: 'stop after the first call', files: [] }; } });
        assert.equal(called, true);
        assert.equal(run.gate.required, false);
        assert.equal(run.events.some(e => e.status === 'WAITING_FOR_HUMAN_GATE'), false);
        assert.equal(run.riskPreflight.level, 3);
      }));
    }
    for (const flag of ['ambiguous', 'requiresDesignDecision']) {
      it(`when ${flag} is set then immediately escalates`, () => fixture(async root => {
        await update(root, '.harness/state/sample-sbi.json', s => s[flag] = true);
        const run = await runHarness({ root, quiet: true });
        assert.equal(run.status, 'ESCALATED');
        assert.equal(run.iterations.length, 0);
      }));
    }
    it('when agent requests human input then immediately escalates', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: async () => ({ escalation: '仕様が曖昧', files: [] }) });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.iterations.length, 1);
    }));
    it('when an agent tries path traversal then escalates without writing outside workspace', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: async () => ({ files: [{ path: '../escape.mjs', content: 'bad' }] }) });
      assert.equal(run.status, 'ESCALATED');
      assert.equal(run.iterations.length, 1);
      assert.match(run.reason, /scope|path/i);
    }));
    it('when a formerly missing app exists but lacks a configured verifier then never marks DONE', () => fixture(async root => {
      await writeFile(join(root, 'apps/api/Gemfile'), '# Rails');
      await update(root, '.harness/state/sample-sbi.json', s => s.requiredVerifiers = ['rails']);
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.status, 'ESCALATED');
      assert.ok(run.iterations[0].verification.checks.some(c => c.id === 'rails' && ['FAIL', 'NOT_CONFIGURED'].includes(c.status)));
    }));
    it('when acceptance criteria are empty then check rejects the SBI', () => fixture(async root => {
      await update(root, '.harness/state/sample-sbi.json', s => s.acceptanceCriteria = []);
      await assert.rejects(check(root), /acceptance/i);
    }));
    it('when a required directory is missing then check fails', () => fixture(async root => {
      await rm(join(root, '.harness/skills'), { recursive: true });
      await assert.rejects(check(root), /skills/);
    }));
  });
});

describe('Completion Judge', () => {
  describe('given agent self-report without machine evidence', () => {
    it('when claiming DONE then refuses completion', () => {
      assert.equal(judge({ status: 'DONE' }, { acceptanceCriteria: [{ id: 'AC-1' }] }), false);
    });
    it('when a required check is skipped then refuses completion', () => {
      assert.equal(judge({ agent: { status: 'PASS' }, verification: { status: 'PASS', acceptance: ['AC-1'], checks: [{ required: true, status: 'SKIP' }] }, review: { status: 'PASS' } }, { acceptanceCriteria: [{ id: 'AC-1' }] }), false);
    });
  });
});

describe('CLI provider adapters', () => {
  describe('given a requested provider', () => {
    it('when selecting codex then uses structured read-only non-interactive execution', () => {
      const command = providerCommand('codex', '/tmp/schema.json', '/tmp/answer.json');
      assert.equal(command.command, 'codex');
      assert.ok(command.args.includes('read-only'));
      assert.ok(command.args.includes('--output-schema'));
    });
    it('when selecting claude then disables tools and requests structured output', () => {
      const command = providerCommand('claude', '/tmp/schema.json', '/tmp/answer.json', '{}');
      assert.equal(command.command, 'claude');
      assert.ok(command.args.includes('--json-schema'));
      assert.equal(command.args[command.args.indexOf('--tools') + 1], '');
    });
    it('when provider is unknown then fails closed', () => {
      assert.throws(() => providerCommand('unknown'), /provider/);
    });
  });
});

describe('Default provider', () => {
  describe('given a run started without --provider', () => {
    it('when harness:run starts then implements with Claude', () => fixture(async root => {
      const used = [];
      const run = await runHarness({ root, quiet: true, provider: undefined, agent: async ({ provider }) => { used.push(provider); return { files: [{ path: 'greeting.mjs', content: 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }' }] }; } });
      assert.equal(run.provider, 'claude');
      assert.deepEqual(used, ['claude']);
    }));
    it('when harness:run starts with --provider codex then implements with Codex instead', () => fixture(async root => {
      const used = [];
      const run = await runHarness({ root, quiet: true, provider: 'codex', agent: async ({ provider }) => { used.push(provider); return { files: [{ path: 'greeting.mjs', content: 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }' }] }; } });
      assert.equal(run.provider, 'codex');
      assert.deepEqual(used, ['codex']);
    }));
  });
});

describe('CLI help', () => {
  describe('given an unknown command', () => {
    it('when the usage is printed then User-facing commands come first and resume / pr are listed only as Internal/Maintenance', async () => {
      const { stderr } = await execute(process.execPath, [new URL('./cli.mjs', import.meta.url).pathname, 'unknown']);
      const userFacing = stderr.indexOf('User-facing'), internal = stderr.indexOf('Internal/Maintenance');
      assert.ok(userFacing >= 0 && internal > userFacing, stderr);
      for (const command of ['planner:sbi', 'harness:run', 'harness:approve', 'harness:reverify']) {
        const at = stderr.indexOf(`pnpm ${command}`);
        assert.ok(at > userFacing && at < internal, `${command} is user-facing`);
      }
      for (const command of ['harness:resume', 'harness:pr', 'harness:impact', 'harness:verify', 'harness:judge', 'harness:check', 'harness:export', 'harness:cleanup']) {
        assert.ok(stderr.indexOf(`pnpm ${command}`) > internal, `${command} is internal`);
      }
      assert.match(stderr.slice(userFacing, internal), /--provider codex/);
      assert.match(stderr.slice(userFacing, internal), /pnpm harness:run SBI_URL/);
      assert.match(stderr.slice(userFacing, internal), /pnpm harness:approve SBI_URL/);
      assert.match(stderr.slice(userFacing, internal), /pnpm harness:reverify PR_URL/);
      assert.ok(stderr.indexOf('--sbi PATH') > internal, '--sbi is for Harness self-tests');
    });
  });
});

describe('OpenAPI Schema as a normal SBI', () => {
  describe('given the commands offered to developers', () => {
    it('when the package scripts are read then the API Schema Planner and its approval are not human commands', async () => {
      const { scripts } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
      assert.equal(scripts['planner:api-schema'], undefined);
      assert.equal(scripts['planner:api-schema-approve'], undefined);
      assert.ok(scripts['planner:sbi'] && scripts['harness:run']);
    });
    it('when the CLI usage is printed then it does not offer pnpm planner:api-schema or planner:api-schema-approve', async () => {
      const { stderr } = await execute(process.execPath, [new URL('./cli.mjs', import.meta.url).pathname, 'unknown']);
      assert.doesNotMatch(stderr, /pnpm planner:api-schema( |-approve)/);
    });
  });
  // #164: the old API Schema Planner, its signed approval ledger and its commands are gone; the merged OpenAPI is the approved contract.
  describe('given the old API Schema Planner was removed', () => {
    const harness = new URL('./', import.meta.url);
    const removed = ['api-schema-planner', 'api-schema-approval', 'api-schema-files', 'api-schema-judge', 'api-schema-render', 'api-schema-security'];
    it('when its modules are looked up then none of them exists', async () => {
      for (const name of removed) await assert.rejects(access(new URL(`${name}.mjs`, harness)), { code: 'ENOENT' }, name);
    });
    it('when the Harness sources are read then none refers to its modules, labels, proposal directory or approval ledger', async () => {
      const legacy = new RegExp(`(${removed.join('|')})\\.mjs|api-schema-approved|needs-api-schema-review|\\.harness/api-schema|human/api-schema|apiSchemaApproval|planApiSchema`);
      for (const file of (await readdir(harness)).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
        assert.doesNotMatch(await readFile(new URL(file, harness), 'utf8'), legacy, file);
      }
    });
    for (const command of ['api-schema', 'api-schema-approve', 'api-schema-status']) {
      it(`when the CLI is asked for ${command} then refuses it as an unknown command`, async () => {
        const { code, stderr } = await execute(process.execPath, [new URL('./cli.mjs', import.meta.url).pathname, command, 'https://github.com/acme/app/issues/12']);
        assert.equal(code, 1);
        assert.match(stderr, /Usage:/);
      });
    }
    it('when the CLI usage is printed then it offers api:mock without an Issue URL and no API Schema command', async () => {
      const { stderr } = await execute(process.execPath, [new URL('./cli.mjs', import.meta.url).pathname, 'unknown']);
      assert.doesNotMatch(stderr, /api-schema(-approve|-status)?( |$)|API Schema Planner/m);
      assert.match(stderr, /pnpm api:mock \[--dynamic\]/);
    });
    it('when the package scripts are read then planner:api-schema-status is gone and api:mock stays', async () => {
      const { scripts } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
      assert.equal(scripts['planner:api-schema-status'], undefined);
      assert.ok(scripts['api:mock']);
    });
    it('when the skills and workflows are looked up then the API Schema Planner skill and workflow are gone', async () => {
      for (const path of ['../../.harness/skills/api-schema.md', '../../.ai/workflows/api-schema.md']) await assert.rejects(access(new URL(path, import.meta.url)), { code: 'ENOENT' }, path);
    });
    it('when the schemas are read then none of the API Schema Planner schemas is exported', async () => {
      const schemas = await import('./schemas.mjs');
      assert.deepEqual(Object.keys(schemas).filter(name => /^apiSchema/.test(name)), []);
    });
  });
});

// harness:run / approve / resume / pr exit 0 when the run stopped where a human or GitHub CI takes over, and 2 when the run itself failed.
describe('Exit code of a run command', () => {
  const run = (overrides = {}) => ({ publish: true, executionStatus: 'DONE', status: 'BLOCKED', merge: { reasons: ['required_ci_not_passed'] }, gate: { state: 'NOT_REQUIRED' },
    pullRequest: { number: 201, url: 'https://github.com/acme/app/pull/201' }, ...overrides });
  describe('given a run that handed over to a human or to GitHub CI', () => {
    it('when the PR was opened and only GitHub CI has not passed yet then exits 0', () => {
      assert.equal(runExitCode(run()), 0);
    });
    it('when the PR was opened and waits for a GitHub Review then exits 0', () => {
      assert.equal(runExitCode(run({ status: 'WAITING_FOR_HUMAN_REVIEW', merge: { reasons: ['insufficient_human_approvals'] } })), 0);
    });
    it('when every merge condition is satisfied then exits 0', () => {
      assert.equal(runExitCode(run({ status: 'MERGE_ALLOWED', merge: { reasons: ['all_conditions_satisfied'] } })), 0);
    });
    it('when a run that never publishes, such as harness:demo, is DONE and waits for review then exits 0', () => {
      assert.equal(runExitCode(run({ publish: false, status: 'WAITING_FOR_HUMAN_REVIEW', pullRequest: undefined })), 0);
    });
  });
  describe('given a run that failed or needs recovery', () => {
    for (const executionStatus of ['FAILED', 'ESCALATED']) {
      it(`when execution is ${executionStatus} then exits 2`, () => {
        assert.equal(runExitCode(run({ executionStatus, status: 'BLOCKED', pullRequest: undefined })), 2);
      });
    }
    it('when the run never started implementing then exits 2, since no implementation gate waits for a human', () => {
      assert.equal(runExitCode(run({ executionStatus: 'PENDING', status: 'PENDING', gate: { required: false, state: 'NOT_REQUIRED' }, pullRequest: undefined })), 2);
    });
    it('when a reviewer requested changes on the PR then exits 2', () => {
      assert.equal(runExitCode(run({ status: 'REJECTED', merge: { reasons: ['github_changes_requested'] } })), 2);
    });
    it('when the PR is blocked for a reason other than CI, such as a commit pushed after verification, then exits 2', () => {
      assert.equal(runExitCode(run({ merge: { reasons: ['tested_sha_mismatch'] } })), 2);
    });
    it('when the merge assessment after DONE failed but can be retried (RETRYABLE) then exits 2', () => {
      assert.equal(runExitCode(run({ status: 'RETRYABLE', merge: { reasons: ['merge_assessment_failed'], failure: { code: 'GITHUB_UNAVAILABLE', retryable: true } } })), 2);
    });
    it('when the merge assessment after DONE stopped because the source moved then exits 2', () => {
      assert.equal(runExitCode(run({ status: 'ESCALATED', merge: { reasons: ['required_ci_not_passed'], failure: { code: 'SOURCE_CHANGED', retryable: false } } })), 2);
    });
    it('when a run meant to publish is DONE without a PR then exits 2', () => {
      assert.equal(runExitCode(run({ status: 'WAITING_FOR_HUMAN_REVIEW', pullRequest: undefined })), 2);
    });
  });
});
