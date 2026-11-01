import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, human, runFixture as runHarness } from './test-fixture.mjs';
import { resumeRun, judge } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { mergeDecision } from './merge-policy.mjs';
import { readJson } from './io.mjs';
import { runAiReview } from './ai-review.mjs';
import { providerAiReviewer } from './agents/ai-review-adapter.mjs';
// #175: a human approved the SBI (its Risk, Security Impact and scope), so the Harness implements it without another Human Gate.
// Humans come back only after implementation (merge review by Risk) or when a new decision the SBI cannot settle appears.
const sbiPath = '.harness/state/sample-sbi.json';
const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
const agent = (content = good) => async () => ({ files: [{ path: 'greeting.mjs', content }] });
const rlsVerifier = root => update(root, '.harness/config/harness.json', c => c.securityVerifiers = [{ id: 'rails-rls-test', directory: 'apps/api', commands: [['node', '-e', 'require("node:assert/strict").ok(true)']] }]);
// A connected adapter reviews the SHA it is given (#187).
const review = (result, name = 'test-adapter') => async ({ headSha }) => ({ adapter: name, headSha, ...result });
const docsSbi = async root => {
  await update(root, sbiPath, s => {
    // #157: LEVEL 1 is the default and an SBI declares its own level; there is no docs-only safe rule any more.
    s.allowedFiles = ['docs/product/intro.md']; s.minimumRiskLevel = 1;
    s.title = 'Write an introduction'; s.description = 'Explain the project';
    s.acceptanceCriteria = [{ id: 'DOC-1', description: 'Introduction exists', verifier: 'docs-bdd' }];
  });
  await mkdir(join(root, '.harness/verification'), { recursive: true });
  await writeFile(join(root, '.harness/verification/docs.mjs'), 'import { readFileSync } from "node:fs"; import { join } from "node:path"; import assert from "node:assert/strict"; assert.equal(readFileSync(join(process.argv[2], "docs/product/intro.md"), "utf8"), "Welcome."); console.log(JSON.stringify({acceptance:["DOC-1"]}));');
  await update(root, '.harness/config/harness.json', c => c.verifiers.push({ trust: 'acceptance', trustedScript: '.harness/verification/docs.mjs', id: 'docs-bdd', directory: 'docs/product', planned: ['BDD'], acceptanceIds: ['DOC-1'], commands: [['node', '-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("intro.md","utf8"),"Welcome.")']] }));
  return async () => ({ files: [{ path: 'docs/product/intro.md', content: 'Welcome.' }] });
};

describe('Implementation of an approved SBI starts without an implementation gate', () => {
  describe('given an approved SBI whose Risk is level 3 only by its declared minimum', () => {
    it('when harness:run starts then the agent implements it at once and two humans review it after implementation', () => fixture(async root => {
      await update(root, sbiPath, s => s.minimumRiskLevel = 3);
      let called = 0;
      const run = await runHarness({ root, quiet: true, agent: async () => { called++; return agent()(); } });
      assert.ok(called > 0);
      assert.equal(run.executionStatus, 'DONE');
      assert.deepEqual(run.gate, { required: false, state: 'NOT_REQUIRED' });
      assert.equal(run.events.some(e => e.status === 'WAITING_FOR_HUMAN_GATE'), false);
      assert.equal(run.risk.level, 3);
      assert.equal(run.status, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(run.merge.requiredApprovals, 2);
    }));
  });
  describe('given an approved SBI that declares RLS, a Human Gate risk with a pre-implementation security rule', () => {
    it('when harness:run starts then implements without a gate, runs the RLS Security Verifier and still needs two different humans to merge', () => fixture(async root => {
      await rlsVerifier(root);
      await update(root, sbiPath, s => s.risks = ['RLS']);
      const run = await runHarness({ root, quiet: true, agent: agent() });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.gate.required, false);
      assert.ok(run.securityAssessment.matchedRules.includes('SEC-RLS-001'));
      assert.equal(run.iterations.at(-1).securityVerification.checks.find(c => c.id === 'rails-rls-test').status, 'PASS');
      assert.equal(run.risk.level, 3);
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('A') });
      assert.equal((await resumeRun({ root, runId: run.id, quiet: true })).status, 'WAITING_FOR_HUMAN_REVIEW');
      await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human('B') });
      const allowed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(allowed.status, 'MERGE_ALLOWED');
      assert.equal(allowed.merge.autoMergeEligible, false);
    }));
    it('when the RLS Security Verifier is not configured then still never reaches DONE', () => fixture(async root => {
      await update(root, sbiPath, s => s.securityImpact = ['RLS']);
      const run = await runHarness({ root, quiet: true, agent: agent() });
      assert.notEqual(run.executionStatus, 'DONE');
      assert.equal(run.escalation.code, 'SECURITY_VERIFIER_NOT_CONFIGURED');
    }));
  });
  describe('given an approved level 2 SBI', () => {
    it('when harness:run starts then implements without a gate and one human reviews it after implementation', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: agent() });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.gate.required, false);
      assert.equal(run.risk.level, 2);
      assert.equal(run.status, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(run.merge.requiredApprovals, 1);
    }));
  });
  describe('given a run that an older Harness stopped at an implementation gate', () => {
    it('when a human tries to approve that gate then nothing is recorded, since the implementation gate no longer exists', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: agent() });
      await assert.rejects(recordDecision({ root, runId: run.id, purpose: 'implementation-gate', identityProvider: human('A') }), /implementation gate/i);
    }));
  });
});

describe('AI Review is required at every Risk level', () => {
  describe('given the demo and test provider', () => {
    it('when no adapter is given then the fake AI Review runs and is recorded as the fake adapter', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: agent() });
      assert.equal(run.iterations.at(-1).semanticReview.status, 'PASS');
      assert.equal(run.iterations.at(-1).semanticReview.adapter, 'fake');
    }));
  });
  describe('given a real provider and no AI Review adapter connected', () => {
    it('when the run verifies the change then records AI Review as NOT_CONFIGURED and blocks the merge decision', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, provider: 'codex', agent: agent() });
      assert.equal(run.iterations.length, 1);
      assert.equal(run.iterations.at(-1).semanticReview.status, 'NOT_CONFIGURED');
      assert.equal(run.status, 'BLOCKED');
      assert.ok(run.merge.reasons.includes('ai_review_not_passed'));
      assert.equal(run.merge.autoMergeEligible, false);
    }));
    it('when the SBI is level 1 then it is still neither MERGE_ALLOWED nor auto merge eligible', () => fixture(async root => {
      const docs = await docsSbi(root);
      const run = await runHarness({ root, quiet: true, provider: 'codex', agent: docs });
      assert.equal(run.risk.level, 1);
      assert.notEqual(run.status, 'MERGE_ALLOWED');
      assert.equal(run.merge.autoMergeEligible, false);
    }));
    it('when the same real provider has a connected adapter then the adapter decides', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, provider: 'codex', agent: agent(), semanticReviewer: review({ status: 'PASS', reasons: [] }) });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.iterations.at(-1).semanticReview.adapter, 'test-adapter');
    }));
  });
  // #220: an --sbi PATH run is a local self-test. It still reaches MERGE_ALLOWED at level 1, but never auto merge; only a run from an approved
  // SBI Issue is eligible (the Merge decision with AI Review below).
  describe('given an approved level 1 SBI', () => {
    it('when AI Review and every required check pass then the --sbi run is MERGE_ALLOWED but never auto merge eligible, and nothing merges', () => fixture(async root => {
      const docs = await docsSbi(root);
      const run = await runHarness({ root, quiet: true, agent: docs });
      assert.equal(run.risk.level, 1);
      assert.equal(run.status, 'MERGE_ALLOWED');
      assert.equal(run.merge.autoMergeEligible, false);
      assert.equal(run.events.some(e => e.status === 'MERGED'), false);
    }));
    for (const [name, reviewer] of [
      ['AI Review fails', review({ status: 'FAIL', reasons: ['the intro misses the purpose'] })],
      ['the AI Review adapter throws', async () => { throw new Error('adapter crashed'); }],
      ['the AI Review result is unknown', review({ status: 'MAYBE' })],
      ['the AI Review adapter returns nothing', async () => undefined],
    ]) {
      it(`when ${name} then the run is never DONE nor auto merge eligible`, () => fixture(async root => {
        const docs = await docsSbi(root);
        const run = await runHarness({ root, quiet: true, agent: docs, semanticReviewer: reviewer });
        assert.notEqual(run.executionStatus, 'DONE');
        assert.equal(run.merge.autoMergeEligible, false);
        assert.equal(run.iterations.at(-1).semanticReview.status, 'FAIL');
      }));
    }
  });
});

describe('Merge decision with AI Review', () => {
  const head = 'a'.repeat(40), base = 'b'.repeat(40);
  const pass = id => ({ id, required: true, status: 'PASS' });
  const checks = ['verification', 'policy-review', 'security', 'completion', 'semantic-review'].map(pass);
  const securityVerification = { status: 'PASS', violations: [], requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }] };
  const github = (overrides = {}) => ({
    pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: head, state: 'open', merged: false, testedShaMatches: true, baseRef: 'main', baseSha: base, remoteBaseSha: base, ...overrides.pullRequest },
    ci: { status: 'PASS', checks: [], ...overrides.ci }, reviews: { approvedHumans: [], changesRequested: false, changesRequestedBy: [], ...overrides.reviews } });
  const decide = (level, extra = {}) => mergeDecision({ risk: { level, requiredHumanApprovals: [0, 0, 1, 2][level] }, checks, securityVerification, headSha: head, contextDigest: 'context',
    github: github(), baseline: { ref: 'main', sha: base }, fromSbiIssue: true, ...extra });
  describe('given a level 1 pull request', () => {
    it('when AI Review, CI, Verifier and Security pass on the tested SHA then it is auto merge eligible with no human', () => {
      const result = decide(1);
      assert.equal(result.decision, 'MERGE_ALLOWED');
      assert.equal(result.requiredApprovals, 0);
      assert.equal(result.autoMergeEligible, true);
    });
    for (const [name, extra] of [
      ['AI Review was not run', { checks: checks.filter(c => c.id !== 'semantic-review') }],
      ['AI Review came from the fake adapter of the demo', { checks: checks.map(c => c.id === 'semantic-review' ? { ...c, adapter: 'fake' } : c) }],
      ['AI Review failed', { checks: checks.map(c => c.id === 'semantic-review' ? { ...c, status: 'FAIL' } : c) }],
      ['AI Review is not configured', { checks: checks.map(c => c.id === 'semantic-review' ? { ...c, status: 'NOT_CONFIGURED' } : c) }],
      ['CI has not finished', { github: github({ ci: { status: 'PENDING' } }) }],
      ['a Verifier failed', { checks: checks.map(c => c.id === 'verification' ? { ...c, status: 'FAIL' } : c) }],
      ['Security failed', { securityVerification: { ...securityVerification, status: 'FAIL' } }],
      ['the PR head is not the tested SHA', { github: github({ pullRequest: { headSha: 'c'.repeat(40), testedShaMatches: false } }) }],
    ]) {
      it(`when ${name} then it is not auto merge eligible`, () => {
        const result = decide(1, extra);
        assert.notEqual(result.decision, 'MERGE_ALLOWED');
        assert.equal(result.autoMergeEligible, false);
      });
    }
  });
  describe('given level 2 and level 3 pull requests', () => {
    it('when level 2 has one human but no AI Review then merge is not allowed', () => {
      assert.notEqual(decide(2, { checks: checks.filter(c => c.id !== 'semantic-review'), github: github({ reviews: { approvedHumans: ['alice'] } }) }).decision, 'MERGE_ALLOWED');
    });
    it('when level 2 has AI Review and no human then it waits for one human', () => {
      const result = decide(2);
      assert.equal(result.decision, 'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(result.requiredApprovals, 1);
    });
    it('when level 3 has AI Review and one human then it waits for a second different human', () => {
      assert.equal(decide(3, { github: github({ reviews: { approvedHumans: ['alice'] } }) }).decision, 'WAITING_FOR_HUMAN_REVIEW');
    });
    it('when level 3 has AI Review and two humans then a human may merge, never automatically', () => {
      const result = decide(3, { github: github({ reviews: { approvedHumans: ['alice', 'bob'] } }) });
      assert.equal(result.decision, 'MERGE_ALLOWED');
      assert.equal(result.autoMergeEligible, false);
    });
  });
  describe('given the Completion Judge', () => {
    it('when AI Review was skipped then the execution is not complete', () => {
      const result = { verification: { status: 'PASS', checks: [{ id: 'bdd', required: true, status: 'PASS', trust: 'acceptance' }], acceptance: ['AC-1'] }, review: { status: 'PASS' },
        security: { status: 'PASS' }, securityVerification: { status: 'PASS', violations: [], requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }] },
        gateApproved: true, semanticReview: { enabled: false, status: 'SKIP' } };
      const sbi = { acceptanceCriteria: [{ id: 'AC-1', verifier: 'bdd' }] };
      assert.equal(judge(result, sbi), false);
      assert.equal(judge({ ...result, semanticReview: { enabled: true, status: 'PASS' } }, sbi), true);
      assert.equal(judge({ ...result, semanticReview: { enabled: true, status: 'FAIL' } }, sbi), false);
    });
    // Until an adapter is connected (#187) the execution may finish, but the merge decision stays blocked on AI Review.
    it('when no AI Review adapter is connected then the execution may complete while the merge stays blocked', () => {
      const result = { verification: { status: 'PASS', checks: [{ id: 'bdd', required: true, status: 'PASS', trust: 'acceptance' }], acceptance: ['AC-1'] }, review: { status: 'PASS' },
        security: { status: 'PASS' }, securityVerification: { status: 'PASS', violations: [], requiredVerifiers: ['secret-scan'], checks: [{ id: 'secret-scan', required: true, status: 'PASS' }] },
        gateApproved: true, semanticReview: { enabled: true, status: 'NOT_CONFIGURED' } };
      assert.equal(judge(result, { acceptanceCriteria: [{ id: 'AC-1', verifier: 'bdd' }] }), true);
    });
  });
});

describe('A decision the approved SBI cannot settle goes back to a human', () => {
  describe('given the agent needs a file outside the approved scope', () => {
    it('when it proposes that file then the run stops as NEEDS_HUMAN_DECISION with the scope reason and applies nothing', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: async () => ({ files: [{ path: 'greeting.mjs', content: good }, { path: 'apps/admin/extra.txt', content: 'x' }] }) });
      assert.equal(run.status, 'ESCALATED');
      assert.deepEqual({ code: run.escalation.code, decision: run.escalation.decision }, { code: 'SCOPE_VIOLATION', decision: 'NEEDS_HUMAN_DECISION' });
      assert.match(run.escalation.detail, /apps\/admin\/extra\.txt/);
      assert.equal(run.headSha, run.baselineSha);
      const evidence = await readJson(join(root, run.runDir, 'escalation.json'));
      assert.equal(evidence.decision, 'NEEDS_HUMAN_DECISION');
      assert.match(evidence.action, /SBIを更新し、再承認後に新しいrunで再開/);
    }));
  });
  describe('given an approved RLS SBI', () => {
    it('when the agent introduces PII logging, a new security decision, then stops as NEEDS_HUMAN_DECISION before applying code', () => fixture(async root => {
      await rlsVerifier(root);
      await update(root, sbiPath, s => s.securityImpact = ['RLS']);
      // Split so this test file's own added lines do not trip the CI pii-log-check.
      const run = await runHarness({ root, quiet: true, agent: agent(good + `\n// ${'logger'}.info(user.email)`) });
      assert.equal(run.status, 'ESCALATED');
      assert.deepEqual({ code: run.escalation.code, decision: run.escalation.decision }, { code: 'NEW_SECURITY_SCOPE', decision: 'NEEDS_HUMAN_DECISION' });
      assert.match(run.reason, /SEC-(PII|LOG)-001/);
      assert.match(run.reason, /update the SBI/);
      assert.doesNotMatch(run.reason, /Human Gate|implementation gate/i);
      assert.equal(run.headSha, run.baselineSha);
    }));
  });
  describe('given high risk content the SBI did not declare', () => {
    // #157: a breaking API change is LEVEL 2 now; a data deletion stays LEVEL 3 and matches no Security rule.
    it('when a level 2 SBI proposes a data deletion then stops as NEW_HIGH_RISK with the matched rule', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: agent(good + '\n// data deletion') });
      assert.equal(run.status, 'ESCALATED');
      assert.deepEqual({ code: run.escalation.code, decision: run.escalation.decision }, { code: 'NEW_HIGH_RISK', decision: 'NEEDS_HUMAN_DECISION' });
      assert.match(run.reason, /data_retention/);
      assert.doesNotMatch(run.reason, /implementation gate/i);
      assert.equal(run.headSha, run.baselineSha);
    }));
    it('when the SBI already declared level 3 then the same change continues without escalation', () => fixture(async root => {
      await update(root, sbiPath, s => s.minimumRiskLevel = 3);
      const run = await runHarness({ root, quiet: true, agent: agent(good + '\n// data deletion') });
      assert.equal(run.executionStatus, 'DONE');
      assert.equal(run.risk.level, 3);
    }));
  });
  describe('given the agent reports a decision it cannot make from the SBI', () => {
    it('when it escalates then the run stops as NEEDS_HUMAN_DECISION with the agent reason', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: async () => ({ escalation: 'API契約とDesignが矛盾しています。どちらを正とするか決めてください', files: [] }) });
      assert.deepEqual({ code: run.escalation.code, decision: run.escalation.decision }, { code: 'AGENT_ESCALATION', decision: 'NEEDS_HUMAN_DECISION' });
      assert.match(run.escalation.detail, /API契約とDesign/);
    }));
  });
  describe('given the human updated the SBI after an escalation', () => {
    it('when the escalated run is resumed then it does not continue on the old approval and the agent never runs again', () => fixture(async root => {
      const run = await runHarness({ root, quiet: true, agent: async () => ({ escalation: '範囲外の変更が必要です', files: [] }) });
      await update(root, sbiPath, s => s.allowedFiles.push('apps/admin/extra.txt'));
      let called = false;
      const resumed = await resumeRun({ root, runId: run.id, quiet: true, agent: async () => { called = true; return agent()(); } });
      assert.equal(resumed.status, 'ESCALATED');
      assert.equal(resumed.iterations.length, run.iterations.length);
      assert.equal(called, false);
    }));
  });
});

describe('AI Review result bound to the reviewed SHA (#187)', () => {
  const head = 'a'.repeat(40);
  const reviewed = { headSha: head };
  describe('given a connected adapter', () => {
    it('when its review is for another SHA then AI Review fails', async () => {
      const result = await runAiReview({ provider: 'codex', semanticReviewer: async () => ({ adapter: 'codex', headSha: 'c'.repeat(40), status: 'PASS', reasons: [] }), input: reviewed });
      assert.equal(result.status, 'FAIL');
    });
    it('when its review names no SHA then AI Review fails', async () => {
      const result = await runAiReview({ provider: 'codex', semanticReviewer: async () => ({ adapter: 'codex', status: 'PASS', reasons: [] }), input: reviewed });
      assert.equal(result.status, 'FAIL');
    });
    it('when a real provider run gets a review from the fake adapter then AI Review fails', async () => {
      const result = await runAiReview({ provider: 'claude', semanticReviewer: async () => ({ adapter: 'fake', headSha: head, status: 'PASS', reasons: [] }), input: reviewed });
      assert.equal(result.status, 'FAIL');
    });
  });
  describe('given the real adapter over a provider CLI that passes the head SHA it was shown', () => {
    const answering = sha => providerAiReviewer({ run: async (_command, _args, { input }) => ({ ok: true, code: 0, stderr: '',
      stdout: JSON.stringify({ is_error: false, structured_output: { headSha: sha ?? input.match(/"headSha": "([0-9a-f]{40})"/)[1], status: 'PASS', riskLevel: 1, reasons: ['matches the SBI'] } }) }) });
    // #220: these runs come from --sbi PATH, a local self-test. The adapter's PASS lets them reach MERGE_ALLOWED, but only a run from an
    // approved SBI Issue is auto merge eligible (the Merge decision with AI Review above).
    it('when an approved level 1 SBI passes every required check then the --sbi run is MERGE_ALLOWED but not auto merge eligible', () => fixture(async root => {
      const docs = await docsSbi(root);
      const run = await runHarness({ root, quiet: true, provider: 'claude', agent: docs, semanticReviewer: answering() });
      assert.equal(run.iterations.at(-1).semanticReview.adapter, 'claude');
      assert.equal(run.risk.level, 1);
      assert.equal(run.status, 'MERGE_ALLOWED');
      assert.equal(run.merge.autoMergeEligible, false);
    }));
    it('when the CLI answers for another SHA then the run is never DONE nor auto merge eligible', () => fixture(async root => {
      const docs = await docsSbi(root);
      const run = await runHarness({ root, quiet: true, provider: 'claude', agent: docs, semanticReviewer: answering('c'.repeat(40)) });
      assert.notEqual(run.executionStatus, 'DONE');
      assert.equal(run.merge.autoMergeEligible, false);
    }));
    it('when Codex implemented the run then Claude reviews it and the --sbi run reaches MERGE_ALLOWED without auto merge', () => fixture(async root => {
      const docs = await docsSbi(root);
      const run = await runHarness({ root, quiet: true, provider: 'codex', agent: docs, semanticReviewer: answering() });
      assert.equal(run.iterations.at(-1).semanticReview.adapter, 'claude');
      assert.equal(run.status, 'MERGE_ALLOWED');
      assert.equal(run.merge.autoMergeEligible, false);
    }));
    it('when the run uses the fake provider then the fake adapter reviews it and no CLI runs', () => fixture(async root => {
      let called = 0;
      const real = providerAiReviewer({ run: async () => { called++; throw new Error('no CLI in a fake run'); } });
      const run = await runHarness({ root, quiet: true, agent: agent(), semanticReviewer: real });
      assert.equal(called, 0);
      assert.equal(run.iterations.at(-1).semanticReview.adapter, 'fake');
      assert.equal(run.iterations.at(-1).semanticReview.status, 'PASS');
    }));
  });
});
