import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
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
      it(`when SBI declares ${risk} then stops before invoking any agent`, () => fixture(async root => {
        await update(root, '.harness/state/sample-sbi.json', s => s.risks = [risk]);
        const run = await runHarness({ root, quiet: true, agent: async () => { throw new Error('must not run'); } });
        assert.equal(run.status, 'WAITING_FOR_HUMAN_GATE');
        assert.equal(run.iterations.length, 0);
        assert.match(run.reason, /Human Gate/);
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
      for (const command of ['planner:sbi', 'harness:run', 'harness:approve']) {
        const at = stderr.indexOf(`pnpm ${command}`);
        assert.ok(at > userFacing && at < internal, `${command} is user-facing`);
      }
      for (const command of ['harness:resume', 'harness:pr', 'harness:impact', 'harness:verify', 'harness:judge', 'harness:check', 'harness:export', 'harness:cleanup']) {
        assert.ok(stderr.indexOf(`pnpm ${command}`) > internal, `${command} is internal`);
      }
      assert.match(stderr.slice(userFacing, internal), /--provider codex/);
      assert.match(stderr.slice(userFacing, internal), /pnpm harness:run SBI_URL/);
      assert.match(stderr.slice(userFacing, internal), /pnpm harness:approve SBI_URL/);
      assert.ok(stderr.indexOf('--sbi PATH') > internal, '--sbi is for Harness self-tests');
    });
  });
});

// harness:run / approve / resume / pr exit 0 when the run stopped where a human or GitHub CI takes over, and 2 when the run itself failed.
describe('Exit code of a run command', () => {
  const run = (overrides = {}) => ({ publish: true, executionStatus: 'DONE', status: 'BLOCKED', merge: { reasons: ['required_ci_not_passed'] }, gate: { state: 'NOT_REQUIRED' }, designApproval: { state: 'NOT_REQUIRED' },
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
    it('when the run waits at the implementation gate as its Risk requires then exits 0', () => {
      assert.equal(runExitCode(run({ executionStatus: 'PENDING', status: 'WAITING_FOR_HUMAN_GATE', gate: { state: 'WAITING_FOR_HUMAN_GATE' }, pullRequest: undefined })), 0);
    });
    it('when the run waits for Design Approval then exits 0', () => {
      assert.equal(runExitCode(run({ executionStatus: 'PENDING', status: 'WAITING_FOR_DESIGN_APPROVAL', designApproval: { state: 'WAITING_FOR_DESIGN_APPROVAL' }, pullRequest: undefined })), 0);
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
    it('when a human requested changes at the gate then exits 2', () => {
      assert.equal(runExitCode(run({ executionStatus: 'PENDING', status: 'WAITING_FOR_HUMAN_GATE', gate: { state: 'REJECTED' }, pullRequest: undefined })), 2);
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
