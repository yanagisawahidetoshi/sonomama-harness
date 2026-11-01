import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, lstat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, human, runFixture as runHarness } from './test-fixture.mjs';
import { classifySecurity, verifySecurity, securityPassed, securityTargets, localTargets } from './security-enforcement.mjs';
import { runCompletionJudge } from './impact.mjs';
import { changedFiles, git } from './workspace.mjs';
import { withEvidenceProtection, redact, isSecretPath } from './evidence-protection.mjs';
import { exportRun } from './review-export.mjs';
import { resumeRun, judge } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { mergeDecision } from './merge-policy.mjs';
import { execute, readJson } from './io.mjs';
import { githubMock } from './test-github.mjs';
import { renderSbiBody } from './planner.mjs';
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
const basic = { risks: [], acceptanceCriteria: [], securityImpact: [], requiredSecurityRules: [], requiredVerifiers: [] };
const assess = (files, sbi = {}) => classifySecurity({ files, sbi: { ...basic, ...sbi } }, policy);
const pass = { id: 'secret-scan', required: true, status: 'PASS' };
const security = status => ({ status, requiredVerifiers: ['secret-scan'], violations: [], checks: [{ ...pass, status }] });
const baseResult = { verification: { status: 'PASS', checks: [{ id: 'bdd', required: true, status: 'PASS' }], acceptance: ['AC'] }, review: { status: 'PASS' }, security: { status: 'PASS' }, gateApproved: true, semanticReview: { enabled: true, status: 'PASS' } };
const ac = { acceptanceCriteria: [{ id: 'AC', verifier: 'bdd' }] };

async function assertNoValue(directory, value) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isDirectory()) await assertNoValue(path, value);
    else if (info.isFile()) assert.equal((await readFile(path)).includes(Buffer.from(value)), false, `raw value leaked in ${name}`);
  }
}

describe('Security Impact Classifier', () => {
  describe('given security rules with stable IDs', () => {
    for (const [path, impact] of [
      ['apps/api/security/rls.sql', 'RLS'], ['apps/api/auth/login.rb', 'AuthN'], ['apps/api/authz/check.rb', 'AuthZ'],
      ['apps/api/pii/access.rb', 'PII'], ['.upload-access-key', 'Secret'], ['apps/api/roles/model.rb', 'RolePermission'],
      ['infra/production/main.tf', 'ProductionInfrastructure'],
    ]) {
      it(`when ${impact} changes then requires an implementation gate and minimum risk 3`, () => {
        const result = assess([{ path, status: 'M' }]);
        assert.ok(result.impacts.includes(impact));
        assert.equal(result.requiresPreImplementationGate, true);
        assert.equal(result.minimumRiskLevel, 3);
        assert.equal(result.requiredHumanApprovals, 2);
        assert.ok(result.matchedRules.length);
      });
    }
    // #157: these categories are detected and still select their Verifier, but the change alone asks for one review instead of a gate and two humans.
    for (const [path, impact, verifier] of [
      ['apps/api/db/migrate/001.rb', 'Migration', 'migration-safety'],
      ['apps/api/db/schema.rb', 'DBSchema', 'migration-safety'],
      ['.github/workflows/deploy.yml', 'CICDSecurity', 'forbidden-pattern-check'],
      ['docs/security/threat-model.md', 'SecurityConfig', 'forbidden-pattern-check'],
      ['docs/adr/0001-example.md', 'SecurityDesign', 'forbidden-pattern-check'],
      ['infra/main.tf', 'InfrastructureSecurity', 'forbidden-pattern-check'],
    ]) {
      it(`when ${impact} changes then requires its Verifier with one review and no implementation gate`, () => {
        const result = assess([{ path, status: 'M' }]);
        assert.ok(result.impacts.includes(impact));
        assert.equal(result.requiresPreImplementationGate, false);
        assert.equal(result.minimumRiskLevel, 2);
        assert.equal(result.requiredHumanApprovals, 1);
        assert.ok(result.requiredVerifiers.includes(verifier));
      });
    }
    // The light content checks run on every change, so an ordinary Production change needs no heavy Security Verifier at all (#157).
    it('when an ordinary Production file changes then only the always required content checks are selected', () => {
      // An authentication filter is an AuthN change (SEC-AUTH-001, #177), so the ordinary change sets up a record instead.
      const result = assess([{ path: 'apps/api/app/controllers/courses_controller.rb', status: 'M', added: 'before_action :set_course' }]);
      assert.deepEqual(result.matchedRules, []);
      assert.equal(result.securitySensitive, false);
      assert.deepEqual(result.requiredVerifiers, ['secret-scan', 'forbidden-pattern-check']);
      assert.equal(result.requiresPreImplementationGate, false);
    });
    it('when ordinary Rails configuration changes then SEC-CONFIG-001 does not match it', () => {
      for (const path of ['apps/api/config/routes.rb', 'apps/api/config/puma.rb', 'apps/admin/src/shared/config/env.ts']) {
        assert.deepEqual(assess([{ path, status: 'M' }]).matchedRules, [], path);
      }
    });
    it('when security relevant Rails configuration changes then SEC-CONFIG-001 still matches it', () => {
      for (const path of ['apps/api/config/database.yml', 'apps/api/config/initializers/cors.rb', 'apps/api/config/initializers/filter_parameter_logging.rb']) {
        assert.ok(assess([{ path, status: 'M' }]).matchedRules.includes('SEC-CONFIG-001'), path);
      }
    });
    it('when logging contains PII then requires the PII log check', () => {
      const result = assess([{ path: 'apps/api/logger.rb', added: 'logger.info(user.email)' }]);
      assert.ok(result.impacts.includes('PIILogging'));
      assert.ok(result.requiredVerifiers.includes('pii-log-check'));
    });
    // The declaration requires the verifiers of the areas the SBI may change (#165); an API SBI gets the Rails RLS test.
    it('when explicit SBI security metadata declares RLS for API files then cannot be downgraded', () => {
      const result = assess([], { securityImpact: ['RLS'], minimumRiskLevel: 3, preImplementationGate: true, allowedFiles: ['apps/api/db/rls.sql'] });
      assert.ok(result.matchedRules.includes('SEC-RLS-001'));
      assert.ok(result.requiredVerifiers.includes('rails-rls-test'));
    });
    it('when SBI names a specific rule then forces its required checks', () => assert.ok(assess([], { requiredSecurityRules: ['SEC-PII-001'] }).requiredVerifiers.includes('pii-log-check')));
    it('when an unknown rule is requested then rejects the request', () => assert.throws(() => assess([], { requiredSecurityRules: ['UNKNOWN'] }), /unknown.*rule/i));
  });
});

describe('Security cannot be overridden by completion or approval', () => {
  describe('given acceptance and policy checks pass', () => {
    for (const status of ['FAIL', 'SKIP', 'NOT_CONFIGURED']) {
      it(`when a required security verifier is ${status} then cannot mark DONE`, () => {
        assert.equal(judge({ ...baseResult, securityVerification: security(status) }, ac), false);
        assert.equal(securityPassed(security(status)), false);
      });
    }
    it('when gate remains unapproved then cannot mark DONE', () => assert.equal(judge({ ...baseResult, gateApproved: false, securityVerification: security('PASS') }, ac), false));
    it('when a security rule violation remains then cannot mark DONE', () => assert.equal(judge({ ...baseResult, securityVerification: { ...security('PASS'), violations: ['SEC-RLS-001'] } }, ac), false));
    for (const gateApproved of [false, true]) {
      it(`when security fails with two human approvals and gate=${gateApproved} then never permits merge`, () => {
        const headSha = 'a'.repeat(40), contextDigest = 'ctx';
        const approvals = ['A', 'B'].map(reviewer => ({ reviewer, kind: 'human', purpose: 'merge', decision: 'APPROVE', commitSha: headSha, contextDigest }));
        const checks = ['verification', 'policy-review', 'security', 'completion', 'semantic-review'].map(id => ({ id, required: true, status: 'PASS' }));
        const result = mergeDecision({ risk: { level: 3, requiredHumanApprovals: 2 }, headSha, contextDigest, approvals, checks, humanGate: true, gateApproved, securityVerification: security('FAIL') });
        assert.notEqual(result.decision, 'MERGE_ALLOWED');
      });
    }
  });
});

describe('Security enforcement in the execution loop', () => {
  describe('given RLS metadata and no installed RLS verifier', () => {
    it('when the approved SBI runs then reports NOT_CONFIGURED and never DONE', () => fixture(async root => {
      await update(root, '.harness/state/sample-sbi.json', s => { s.securityImpact = ['RLS']; s.allowedDirs = ['apps/api/db/']; });
      await update(root, '.harness/config/harness.json', c => { c.securityVerifiers = c.securityVerifiers.filter(v => v.id !== 'rails-rls-test'); });
      const run = await runHarness({ root, quiet: true });
      assert.notEqual(run.executionStatus, 'DONE');
      const evidence = await readJson(join(root, run.runDir, 'security-verification.json'));
      assert.equal(evidence.checks.find(c => c.id === 'rails-rls-test').status, 'NOT_CONFIGURED');
    }));
    it('when a trusted RLS command is configured then verifies it and still requires two merge reviewers', () => fixture(async root => {
      await update(root, '.harness/state/sample-sbi.json', s => s.securityImpact = ['RLS']);
      await update(root, '.harness/config/harness.json', c => c.securityVerifiers = [{ id: 'rails-rls-test', directory: 'apps/api', commands: [['node', '-e', 'require("node:assert/strict").ok(true)']] }]);
      const run = await runHarness({ root, quiet: true });
      let resumed = run;
      assert.equal(resumed.executionStatus, 'DONE');
      assert.equal(resumed.risk.level, 3);
      for (const id of ['A', 'B']) await recordDecision({ root, runId: run.id, purpose: 'merge', identityProvider: human(id) });
      resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.equal(resumed.status, 'MERGE_ALLOWED');
      assert.equal(resumed.merge.autoMergeEligible, false);
      const assessment = await readJson(join(root, run.runDir, 'security-assessment.json'));
      assert.ok(assessment.matchedRules.includes('SEC-RLS-001'));
    }));
  });
  // An SBI from an Issue names only directories (allowedFiles is empty), so the content checks must read the committed diff instead.
  // The SBI is approved, so the run implements it without an implementation gate (#175).
  describe('given an approved SecurityConfig SBI that allows a directory and no file by name', () => {
    // Split so this test file's own added lines do not trip the CI forbidden pattern check.
    const tls = `process.env.NODE_TLS_${'REJECT_UNAUTHORIZED'} = '0';\n`;
    const directoryRun = async (root, files) => {
      await writeFile(join(root, '.harness/verification/lib.mjs'), 'console.log(JSON.stringify({ acceptance: ["LIB"] }));');
      await update(root, '.harness/config/harness.json', c => c.verifiers.push({ id: 'lib', trust: 'acceptance', trustedScript: '.harness/verification/lib.mjs', directory: '.', planned: ['lib'], commands: [], acceptanceIds: ['LIB'], appliesTo: ['^never/'] }));
      await update(root, '.harness/state/sample-sbi.json', s => {
        Object.assign(s, { allowedFiles: [], allowedDirs: ['lib/'], securityImpact: ['SecurityConfig'], acceptanceCriteria: [{ id: 'LIB', description: 'lib', verifier: 'lib' }] });
      });
      const agent = async () => ({ files });
      const run = await runHarness({ root, quiet: true, agent });
      return readJson(join(root, run.runDir, 'iteration-1/security-verification.json'));
    };
    it('when the agent adds a forbidden pattern under that directory then the forbidden pattern check fails on that file', () => fixture(async root => {
      const evidence = await directoryRun(root, [{ path: 'lib/tls.mjs', content: tls }]);
      const check = evidence.checks.find(c => c.id === 'forbidden-pattern-check');
      assert.equal(check.status, 'FAIL');
      assert.deepEqual(check.findings.map(f => f.path), ['lib/tls.mjs']);
      assert.equal(securityPassed(evidence), false);
    }));
    it('when the agent changes no file then the content checks do not report PASS for scanning nothing', () => fixture(async root => {
      const evidence = await directoryRun(root, []);
      for (const id of ['secret-scan', 'forbidden-pattern-check']) assert.notEqual(evidence.checks.find(c => c.id === id).status, 'PASS', id);
      assert.equal(securityPassed(evidence), false);
    }));
  });
  // A run from an SBI Issue also commits the Issue snapshot (.harness/state/sbi-<N>.json); the Issue text is not code the agent changed.
  describe('given an approved SecurityConfig SBI Issue whose change area is a directory', () => {
    const issueUrl = 'https://github.com/acme/app/issues/7';
    const pbi = { number: 3, url: 'https://github.com/acme/app/issues/3', title: '通信設定' };
    const planned = purpose => ({
      id: 'SBI-001', kind: 'implementation', title: '通信設定を整える', purpose, scope: { included: ['lib'], excluded: [] },
      acceptanceCriteria: [{ id: 'AC-1', description: '通信設定がある' }],
      scenarios: [{ name: '通信設定', given: ['設定がない'], when: ['設定を読む'], then: ['設定がある'], acceptanceIds: ['AC-1'], test: 'node:test lib' }],
      dependsOn: [], changeAreas: ['lib'], layers: ['設定'], estimatedFiles: 1, oversizeReason: null, riskCandidate: 'L3', securityImpact: ['SecurityConfig'],
      verification: { applicationTest: 'node:test', acceptance: 'Trusted Acceptance', e2e: '不要' } });
    const mockGitHub = githubMock({});
    const issueRun = async (root, purpose, files) => { let evidence; await mockGitHub({ issue: { number: 7, title: 'SBI-001 通信設定を整える', body: renderSbiBody(planned(purpose), pbi), html_url: issueUrl, state: 'open', labels: [{ name: 'sbi' }, { name: 'ready' }] } }, async () => {
      await writeFile(join(root, '.harness/verification/issue-7.mjs'), 'console.log(JSON.stringify({ acceptance: ["AC-1"] }));');
      await mkdir(join(root, '.harness/acceptance'), { recursive: true });
      await writeFile(join(root, '.harness/acceptance/sbi-7.json'), JSON.stringify({ version: 1, sbiIssue: 7, verifiers: [{ id: 'issue-7-acceptance', trustedScript: '.harness/verification/issue-7.mjs', planned: ['通信設定'], acceptanceIds: ['AC-1'] }] }));
      const agent = async () => ({ files });
      const run = await runHarness({ root, quiet: true, agent, issueUrl });
      evidence = await readJson(join(root, run.runDir, 'iteration-1/security-verification.json'));
    }); return evidence; };
    // #184: a Harness run and CI judge zero targets alike, so the SKIP of #181 is now a FAIL; the snapshot is still read by secret-scan.
    it('when the agent changes no file then the content checks fail instead of passing on the Issue snapshot alone', () => fixture(async root => {
      const evidence = await issueRun(root, '通信設定を整える。', []);
      for (const id of ['secret-scan', 'forbidden-pattern-check']) {
        const check = evidence.checks.find(c => c.id === id);
        assert.equal(check.status, 'FAIL', id);
        assert.match(check.reason, /SBI snapshot/, id);
      }
      assert.deepEqual(evidence.checks.find(c => c.id === 'forbidden-pattern-check').excluded, ['.harness/state/sbi-7.json']);
      assert.equal(securityPassed(evidence), false);
    }));
    it('when the Issue text names a forbidden pattern and the agent adds safe code then only the agent code is scanned and passes', () => fixture(async root => {
      const evidence = await issueRun(root, `NODE_TLS_${'REJECT_UNAUTHORIZED'} = 0 を使わない。`, [{ path: 'lib/tls.mjs', content: 'export const verifyTls = true;\n' }]);
      const check = evidence.checks.find(c => c.id === 'forbidden-pattern-check');
      assert.equal(check.status, 'PASS');
      assert.deepEqual(check.scanned, ['lib/tls.mjs']);
    }));
  });
  describe('given required content checks and no list of changed files', () => {
    it('when Security is verified then it refuses instead of scanning the SBI allowedFiles', async () => {
      await assert.rejects(verifySecurity({ workspace: '.', sbi: { allowedFiles: ['greeting.mjs'] }, assessment: { requiredVerifiers: ['secret-scan'] }, policy, config: { securityVerifiers: [] }, headSha: 'x' }), /changed files/);
    });
  });
  describe('given security rules on the docs lane', () => {
    it('when docs/security changes then minimum security risk overrides docs LOW and AI LOW', () => {
      const result = assess([{ path: 'docs/security/pii.md', added: 'Security requirements update.' }]);
      assert.equal(result.minimumRiskLevel, 3);
    });
  });
});

describe('Secret protection and review export', () => {
  describe('given a credential value stored in a prohibited source file', () => {
    it('when copying, prompting, logging, and exporting then never emits the value', () => fixture(async root => {
      const value = `fixture-only-${Date.now()}-sentinel`;
      await writeFile(join(root, 'apps/admin/.upload-access-key'), value);
      await writeFile(join(root, 'apps/admin/.env.local'), `UPLOAD_TOKEN=${value}`);
      await writeFile(join(root, 'apps/admin/.env.extra'), `UPLOAD_TOKEN=${value}`);
      const run = await runHarness({ root, quiet: true, agent: async () => { throw new Error(`failure: ${value}`); } });
      assert.equal(run.status, 'ESCALATED');
      await assertNoValue(join(root, run.runDir), value);
      const files = await readdir(join(root, run.runDir, 'workspace/apps/admin'));
      assert.equal(files.includes('.upload-access-key'), false);
      assert.equal(files.includes('.env.local'), false);
      assert.equal(files.includes('copied-credential.txt'), false);
      // Also defend export of pre-existing or manually contaminated evidence.
      await writeFile(join(root, run.runDir, 'legacy.log'), `legacy: ${value}`);
      await writeFile(join(root, run.runDir, '.upload-access-key'), value);
      const exported = await exportRun({ root, runId: run.id });
      const listing = await execute('unzip', ['-Z1', exported.path]);
      assert.equal(listing.ok, true);
      assert.equal(listing.stdout.includes('.upload-access-key'), false);
      assert.equal(listing.stdout.includes('/.git/'), false);
      const contents = await execute('unzip', ['-p', exported.path]);
      assert.equal(contents.stdout.includes(value), false);
    }));
    it('when an agent proposes a hardcoded credential then redacts before writing or committing it', () => fixture(async root => {
      const value = 'ghp_' + 'x'.repeat(36);
      const run = await runHarness({ root, quiet: true, agent: async () => ({ files: [{ path: 'greeting.mjs', content: good + `\n// ${value}` }] }) });
      assert.equal(run.status, 'ESCALATED');
      await assertNoValue(join(root, run.runDir), value);
    }));
    it('when rendering structured evidence then supports custom redaction extensions', () => fixture(async root => {
      await withEvidenceProtection(root, async () => {
        assert.equal(redact({ message: 'custom-sensitive' }).message.includes('custom-sensitive'), false);
      }, { extensions: [text => text.replaceAll('custom-sensitive', '[REDACTED]')] });
    }));
    for (const path of ['.env', '.env.prod', 'tls/server.pem', 'tls/cert.pfx', 'apps/api/credentials.yml', 'apps/mobile/secrets.json', '.upload-access-key']) {
      it(`when ${path} is encountered then treats it as excluded evidence`, () => assert.equal(isSecretPath(path), true));
    }
    it('when the security policy documentation is named secrets.md then preserves the policy document', () => assert.equal(isSecretPath('docs/security/secrets.md'), false));
  });
});

describe('Security rule and evidence boundaries', () => {
  describe('given a change outside the approved security scope', () => {
    // The forbidden pattern check reports the finding as a violation, so the merge is blocked whatever the Risk Level is.
    it('when unsafe TLS settings are proposed then classifies them as security sensitive', () => {
      const result = assess([{path:'apps/admin/client.js',added:'process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0'}]);
      assert.equal(result.securitySensitive,true);
      assert.equal(result.minimumRiskLevel,2);
      assert.ok(result.matchedRules.includes('SEC-CONFIG-001'));
      assert.ok(result.requiredVerifiers.includes('forbidden-pattern-check'));
    });
    it('when agent introduces PII in an approved RLS-only SBI then stops before applying it', () => fixture(async root => {
      await update(root,'.harness/state/sample-sbi.json',s=>s.securityImpact=['RLS']);
      // Split so this test file's own added lines do not trip the CI pii-log-check.
      const resumed=await runHarness({root,quiet:true,agent:async()=>({files:[{path:'greeting.mjs',content:good+`\n// ${'logger'}.info(user.email)`}]})});
      assert.equal(resumed.status,'ESCALATED');
      assert.match(resumed.reason,/security scope/);
      assert.equal(resumed.headSha,resumed.baselineSha);
    }));
    it('when an old run alone contains a secret then export discovers and redacts it', () => fixture(async root => {
      const value=`legacy-fixture-${Date.now()}-credential`;
      const run=await runHarness({root,quiet:true});
      await writeFile(join(root,run.runDir,'.upload-access-key'),value);
      await writeFile(join(root,run.runDir,'old.log'),`old value: ${value}`);
      const output=await exportRun({root,runId:run.id});
      const result=await execute('unzip',['-p',output.path]);
      assert.equal(result.stdout.includes(value),false);
    }));
    it('when a process emits nested JSON containing a new secret file then redacts the file content', () => fixture(async root => {
      await withEvidenceProtection(root,async()=>{
        const value='newly-created-fixture-credential';
        const safe=redact({stdout:JSON.stringify({files:[{path:'.upload-access-key',content:value}]})});
        assert.equal(safe.stdout.includes(value),false);
      });
    }));
    it('when a generated native dependency tree exceeds the discovery limit then skips it and still redacts app secrets', () => fixture(async root => {
      const pods=join(root,'apps/mobile/ios/Pods/Vendor');
      await mkdir(pods,{recursive:true});
      await Promise.all(Array.from({length:30001},(_,i)=>writeFile(join(pods,`f${i}.h`),'')));
      const value='native-fixture-credential-value';
      await writeFile(join(root,'apps/mobile/ios/.upload-access-key'),value);
      await withEvidenceProtection(root,async()=>{
        assert.equal(redact({text:`key ${value}`}).text.includes(value),false);
      });
    }));
    it('when harmless JSON text is used as metadata then preserves it exactly', () => fixture(async root => {
      await withEvidenceProtection(root,async()=>{
        assert.equal(redact({text:'{ "ordinary": true }'}).text,'{ "ordinary": true }');
      });
    }));
  });
});

describe('Security floors outrank LOW proposals', () => {
  describe('given safe-looking docs and AI LOW', () => {
    it('when a security rule requires HIGH then final risk stays at level 3', async () => {
      const { assessRisk } = await import('./risk-classifier.mjs');
      const riskPolicy = await readJson(new URL('../../.harness/rules/pr-risk.json',import.meta.url));
      const securityAssessment=assess([],{securityImpact:['RLS']});
      const result=assessRisk({files:[{path:'docs/intro.md',status:'A',added:'Welcome.'}],metadata:{},aiRisk:1,securityAssessment},riskPolicy);
      assert.equal(result.level,3);
      assert.equal(result.autoMergeAllowed,false);
    });
  });
});

describe('Excluded source still contributes security impact', () => {
  describe('given a credential in an ordinary allowed source file', () => {
    it('when a tracked credential exists then refuses worktree creation before checkout', () => fixture(async root => {
      const value='ghp_'+'q'.repeat(36);
      await writeFile(join(root,'greeting.mjs'),`// ${value}\n${good}`);
      await assert.rejects(runHarness({root,quiet:true}), /tracked.*credential|credential.*tracked/i);
      await assertNoValue(join(root,'.harness/runs'),value);
    }));
  });
});

// #184: the content checks never pass on zero targets by accident. Every diff entry lands in exactly one bucket (scanned, deleted, excluded,
// uninspectable or a secret path); the CI form (the added lines as text) is used here, and the Harness run shares securityTargets.
describe('Security content targets (#184)', () => {
  const unsafe = ['NODE', 'TLS', 'REJECT', 'UNAUTHORIZED'].join('_');
  const token = 'ghp_' + 'z'.repeat(36);
  const snapshot = '.harness/state/sbi-9.json';
  const contentChecks = { requiredVerifiers: ['secret-scan', 'forbidden-pattern-check'] };
  const scan = (files, extra = {}) => verifySecurity({ workspace: '.', assessment: contentChecks, policy, config: { securityVerifiers: [] }, headSha: 'a'.repeat(40),
    changed: securityTargets(files).map(t => ({ ...t, text: t.added ?? '' })), entries: files.length, ...extra });
  const check = (evidence, id = 'forbidden-pattern-check') => evidence.checks.find(c => c.id === id);
  const safe = { path: 'lib/greet.mjs', status: 'A', added: 'export const greet = () => "hi";' };

  describe('given a PR diff with no entry', () => {
    it('when the content checks run then they fail instead of passing on nothing', async () => {
      const evidence = await scan([]);
      for (const id of contentChecks.requiredVerifiers) {
        assert.equal(check(evidence, id).status, 'FAIL', id);
        assert.match(check(evidence, id).reason, /no changed file/, id);
      }
      assert.equal(securityPassed(evidence), false);
    });
  });

  describe('given a deletion-only diff', () => {
    it('when every entry deletes a file then the content checks pass as deletion-only and keep the deleted files', async () => {
      const evidence = await scan([{ path: 'lib/old.mjs', status: 'D', added: '', deleted: 'export const old = 1;\nexport const older = 2;' }]);
      for (const id of contentChecks.requiredVerifiers) {
        const c = check(evidence, id);
        assert.equal(c.status, 'PASS', id);
        assert.equal(c.reason, 'deletion-only', id);
        assert.deepEqual(c.scanned, [], id);
        assert.deepEqual(c.deleted, ['lib/old.mjs'], id);
        assert.deepEqual(c.diff, { entries: 1, deletedFiles: 1, deletedLines: 2 }, id);
      }
      assert.equal(securityPassed(evidence), true);
    });
    it('when a modified file only loses lines then the change is deletion-only as well', async () => {
      const c = check(await scan([{ path: 'lib/greet.mjs', status: 'M', added: '', deleted: 'export const unused = 1;' }]));
      assert.equal(c.status, 'PASS');
      assert.equal(c.reason, 'deletion-only');
    });
    it('when the deletion-only change also commits the SBI snapshot then it stays deletion-only', async () => {
      const c = check(await scan([{ path: 'lib/old.mjs', status: 'D', added: '', deleted: 'x' }, { path: snapshot, status: 'A', added: '{"source":{}}' }]));
      assert.equal(c.status, 'PASS');
      assert.equal(c.reason, 'deletion-only');
      assert.deepEqual(c.excluded, [snapshot]);
    });
    it('when a file is moved and edited then the change is not deletion-only, because the new path adds lines', async () => {
      const c = check(await scan([{ path: 'lib/old.mjs', status: 'D', added: '', deleted: 'export const a = 1;' }, { path: 'lib/new.mjs', status: 'A', added: 'export const a = 2;' }]));
      assert.equal(c.status, 'PASS');
      assert.notEqual(c.reason, 'deletion-only');
      assert.deepEqual(c.scanned, ['lib/new.mjs']);
    });
    it('when only a file mode changes then the change is not deletion-only', async () => {
      const c = check(await scan([{ path: 'bin/run.sh', status: 'M', added: '', deleted: '', modeChanged: true }]));
      assert.notEqual(c.reason, 'deletion-only');
    });
    it('when a deletion removes a protection then the security rule for removed lines still matches', async () => {
      const files = [{ path: 'infra/production/main.tf', status: 'D', added: '', deleted: 'lifecycle { prevent_destroy = true }' }];
      assert.ok(assess(files).matchedRules.includes('SEC-PRODINFRA-001'));
      assert.equal(check(await scan(files)).reason, 'deletion-only');
    });
  });

  describe('given entries that are not accounted for', () => {
    it('when a changed file that is not deleted cannot be read then fails instead of dropping it', async () => {
      const evidence = await verifySecurity({ workspace: '.', assessment: contentChecks, policy, config: { securityVerifiers: [] }, headSha: 'a'.repeat(40),
        changed: securityTargets([{ path: 'lib/missing-184.mjs', status: 'A', added: 'x' }]), entries: 1 });
      assert.deepEqual(evidence.violations.map(v => [v.code, v.path]), [['missing_changed_file', 'lib/missing-184.mjs']]);
      assert.equal(check(evidence).status, 'FAIL');
    });
    it('when the targets do not add up to the number of diff entries then fails', async () => {
      const c = check(await scan([safe], { entries: 2 }));
      assert.equal(c.status, 'FAIL');
      assert.match(c.reason, /1 of 2 diff entries/);
    });
  });

  describe('given the SBI snapshot the Harness commits from the Issue', () => {
    it('when the diff has only the snapshot then fails, because nothing but the Issue text changed', async () => {
      const evidence = await scan([{ path: snapshot, status: 'A', added: '{"source":{}}' }]);
      for (const id of contentChecks.requiredVerifiers) assert.equal(check(evidence, id).status, 'FAIL', id);
    });
    it('when the Issue text names a forbidden pattern then forbidden-pattern-check excludes the snapshot and secret-scan still reads it', async () => {
      const evidence = await scan([{ path: snapshot, status: 'A', added: `{"purpose":"${unsafe} = 0 を使わない"}` }, safe]);
      assert.equal(check(evidence).status, 'PASS');
      assert.deepEqual(check(evidence).scanned, [safe.path]);
      assert.deepEqual(check(evidence).excluded, [snapshot]);
      assert.deepEqual(check(evidence, 'secret-scan').scanned, [snapshot, safe.path]);
    });
    it('when the snapshot carries a credential then secret-scan fails', async () => {
      const evidence = await scan([{ path: snapshot, status: 'A', added: `{"purpose":"${token}"}` }, safe]);
      assert.equal(check(evidence, 'secret-scan').status, 'FAIL');
    });
  });

  describe('given a content scan exception in the policy', () => {
    const excepted = 'tools/harness/security-enforcement.test.mjs';
    it('when the excepted file holds the named fixture literal then passes and records the exception with its reason', async () => {
      const c = check(await scan([{ path: excepted, status: 'M', added: `assess([{path:'apps/admin/client.js',added:'process.env.${unsafe} = 0'}]);` }]));
      assert.equal(c.status, 'PASS');
      assert.deepEqual(c.exceptions.map(e => e.path), [excepted]);
      assert.ok(c.exceptions[0].reason);
    });
    it('when another file holds the same literal then fails', async () => {
      assert.equal(check(await scan([{ path: 'lib/client.mjs', status: 'A', added: `added:'process.env.${unsafe} = 0'` }])).status, 'FAIL');
    });
    it('when the excepted file adds another forbidden form then fails', async () => {
      assert.equal(check(await scan([{ path: excepted, status: 'M', added: `process.env.${unsafe} = '0';` }])).status, 'FAIL');
    });
  });
});

// #184 review: the same committed diff, read by git, is judged by the Harness run (localTargets, whole files) and by the CI Judge (added lines).
// Neither the diff text nor a .gitattributes of the PR decides what is binary, and an uninspectable file is still read by secret-scan.
describe('Security content targets from a real git diff (#184)', () => {
  const needs = { impact: { result: 'success' }, verifiers: { result: 'success' }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } };
  const contentChecks = { requiredVerifiers: ['secret-scan', 'forbidden-pattern-check'] };
  const token = 'AKIA' + 'Q'.repeat(16);
  const commit = async (root, message) => { await git(root, ['add', '--all']); await git(root, ['commit', '-q', '-m', message]); };
  const pick = evidence => Object.fromEntries(contentChecks.requiredVerifiers.map(id => [id, evidence.checks.find(c => c.id === id)]));
  const judgeBoth = async (root, change) => {
    await git(root, ['switch', '-q', '-c', 'feature']);
    await change(root);
    await commit(root, 'feature');
    const files = await changedFiles(root, 'main', 'HEAD');
    const local = await verifySecurity({ workspace: root, assessment: contentChecks, policy, config: { securityVerifiers: [] }, headSha: 'x', changed: localTargets(files, []), entries: files.length });
    const ci = (await runCompletionJudge({ root, base: 'main', needs })).security;
    return { files, local: pick(local), ci: pick(ci), localEvidence: local, ciEvidence: ci };
  };
  const agree = ({ local, ci }) => { for (const id of contentChecks.requiredVerifiers) assert.equal(local[id].status, ci[id].status, `${id}: the run and CI disagree`); };

  it('when an added text line spells "Binary files" then the file is still text and its credential fails in the run and in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, root => writeFile(join(root, 'docs/b1.txt'), `Binary files a/x and b/x differ ${token}\n`));
    assert.equal(judged.files[0].binary, false);
    agree(judged);
    assert.equal(judged.ci['secret-scan'].status, 'FAIL');
    assert.deepEqual(judged.ci['secret-scan'].scanned, ['docs/b1.txt']);
  }));

  it('when the PR adds a .gitattributes that marks its files -diff then they stay text and their credential fails in the run and in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, async root => {
      await writeFile(join(root, '.gitattributes'), '*.txt -diff\n');
      await writeFile(join(root, 'docs/b2.txt'), `${token}\n`);
    });
    assert.equal(judged.files.find(f => f.path === 'docs/b2.txt').binary, false);
    agree(judged);
    assert.equal(judged.ci['secret-scan'].status, 'FAIL');
    assert.deepEqual(judged.ci['secret-scan'].uninspectable, []);
  }));

  it('when an added line starts with "++" then it is an added line, not a deletion-only change, in the run and in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, root => writeFile(join(root, 'docs/b3.txt'), `++ ${token}\n`));
    assert.match(judged.files[0].added, /^\+\+ AKIA/);
    agree(judged);
    assert.equal(judged.ci['secret-scan'].status, 'FAIL');
    assert.notEqual(judged.ci['secret-scan'].reason, 'deletion-only');
  }));

  it('when a text file holds one NUL byte then it is uninspectable and secret-scan still finds its credential in the run and in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, root => writeFile(join(root, 'docs/b4.txt'), Buffer.from(`hello\0 ${token}\n`, 'latin1')));
    assert.equal(judged.files[0].binary, true);
    agree(judged);
    assert.equal(judged.ci['secret-scan'].status, 'FAIL');
    assert.deepEqual(judged.ci['secret-scan'].uninspectable, ['docs/b4.txt']);
    assert.deepEqual(judged.ci['secret-scan'].scanned, []);
    assert.deepEqual(judged.ciEvidence.violations.map(v => [v.verifier, v.path, v.code]), [['secret-scan', 'docs/b4.txt', 'credential_value'], ['secret-scan', 'docs/b4.txt', 'secret']]);
  }));

  it('when a file holds a credential encoded as UTF-16 then secret-scan finds it in the run and in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, root => writeFile(join(root, 'docs/utf16.txt'), Buffer.from(`${token}\n`, 'utf16le')));
    assert.equal(judged.files[0].binary, true);
    agree(judged);
    assert.equal(judged.ci['secret-scan'].status, 'FAIL');
    assert.deepEqual([...new Set(judged.ci['secret-scan'].findings.map(f => f.path))], ['docs/utf16.txt']);
  }));

  it('when a file name looks like a pathspec then it is read as a literal path and its credential fails in the run and in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, root => writeFile(join(root, ':!keep.md'), `${token}\n`));
    assert.deepEqual(judged.files.map(f => [f.path, f.binary, f.addedLines]), [[':!keep.md', false, 1]]);
    agree(judged);
    assert.equal(judged.ci['secret-scan'].status, 'FAIL');
    assert.deepEqual(judged.ci['secret-scan'].scanned, [':!keep.md']);
  }));

  it('when main tracks a text file with one NUL byte and a credential then --all fails on secret-scan', () => fixture(async root => {
    await writeFile(join(root, 'docs/b4.txt'), Buffer.from(`hello\0 ${token}\n`, 'latin1'));
    await commit(root, 'nul');
    const all = pick((await runCompletionJudge({ root, all: true, needs })).security);
    assert.equal(all['secret-scan'].status, 'FAIL');
    assert.ok(all['secret-scan'].uninspectable.includes('docs/b4.txt'));
  }));

  it('when a binary file without a credential is added then it is uninspectable, not scanned, and passes in the run and in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, root => writeFile(join(root, 'docs/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0])));
    agree(judged);
    for (const id of contentChecks.requiredVerifiers) {
      assert.equal(judged.ci[id].status, 'PASS', id);
      assert.deepEqual(judged.ci[id].scanned, [], id);
      assert.deepEqual(judged.ci[id].uninspectable, ['docs/logo.png'], id);
    }
  }));

  it('when a binary file is added at a secret path then the path check fails in the run and in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, async root => { await mkdir(join(root, 'tls')); await writeFile(join(root, 'tls/server.pem'), Buffer.from([0, 1, 2, 3])); await git(root, ['add', '-f', 'tls/server.pem']); });
    agree(judged);
    for (const evidence of [judged.localEvidence, judged.ciEvidence]) assert.ok(evidence.violations.some(v => v.code === 'prohibited_secret_path' && v.path === 'tls/server.pem'));
  }));

  it('when only the mode of a tracked file changes then it is uninspectable and passes, not as deletion-only, in the run and in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, root => chmod(join(root, 'tools/harness/sample-bdd.mjs'), 0o755));
    assert.equal(judged.files[0].modeChanged, true);
    agree(judged);
    assert.equal(judged.ci['forbidden-pattern-check'].status, 'PASS');
    assert.deepEqual(judged.ci['forbidden-pattern-check'].uninspectable, ['tools/harness/sample-bdd.mjs']);
    assert.notEqual(judged.ci['forbidden-pattern-check'].reason, 'deletion-only');
  }));

  it('when the only change adds one blank line then it is not recorded as deletion-only in the run or in CI', () => fixture(async root => {
    const judged = await judgeBoth(root, async root => writeFile(join(root, 'AGENTS.md'), `${await readFile(join(root, 'AGENTS.md'), 'utf8')}\n`));
    agree(judged);
    for (const checks of [judged.local, judged.ci]) assert.notEqual(checks['forbidden-pattern-check'].reason, 'deletion-only');
  }));

  it('when the change only deletes a file then both judge it deletion-only', () => fixture(async root => {
    const judged = await judgeBoth(root, root => git(root, ['rm', '-q', 'tools/harness/sample-bdd.mjs']));
    agree(judged);
    for (const checks of [judged.local, judged.ci]) assert.equal(checks['forbidden-pattern-check'].reason, 'deletion-only');
  }));
});
