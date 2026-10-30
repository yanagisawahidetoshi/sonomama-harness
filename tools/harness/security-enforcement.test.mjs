import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, human, runFixture as runHarness } from './test-fixture.mjs';
import { classifySecurity, verifySecurity, securityPassed } from './security-enforcement.mjs';
import { withEvidenceProtection, redact, isSecretPath } from './evidence-protection.mjs';
import { exportRun } from './review-export.mjs';
import { resumeRun, judge } from './index.mjs';
import { recordDecision } from './human-approvals.mjs';
import { mergeDecision } from './merge-policy.mjs';
import { execute, readJson } from './io.mjs';
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
const basic = { risks: [], acceptanceCriteria: [], securityImpact: [], requiredSecurityRules: [], requiredVerifiers: [] };
const assess = (files, sbi = {}) => classifySecurity({ files, sbi: { ...basic, ...sbi } }, policy);
const pass = { id: 'secret-scan', required: true, status: 'PASS' };
const security = status => ({ status, requiredVerifiers: ['secret-scan'], violations: [], checks: [{ ...pass, status }] });
const baseResult = { verification: { status: 'PASS', checks: [{ id: 'bdd', required: true, status: 'PASS' }], acceptance: ['AC'] }, review: { status: 'PASS' }, security: { status: 'PASS' }, gateApproved: true };
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
      ['apps/api/pii/access.rb', 'PII'], ['.upload-access-key', 'Secret'], ['apps/api/db/migrate/001.rb', 'Migration'],
      ['apps/api/db/schema.rb', 'DBSchema'], ['apps/api/roles/model.rb', 'RolePermission'],
      ['.github/workflows/deploy.yml', 'CICDSecurity'], ['infra/main.tf', 'InfrastructureSecurity'],
      ['docs/security/authorization.md', 'SecurityConfig'],
    ]) {
      it(`when ${impact} changes then requires an implementation gate and minimum risk 3`, () => {
        const result = assess([{ path, status: 'M' }]);
        assert.ok(result.impacts.includes(impact));
        assert.equal(result.requiresPreImplementationGate, true);
        assert.equal(result.minimumRiskLevel, 3);
        assert.ok(result.matchedRules.length);
      });
    }
    it('when logging contains PII then requires the PII log check', () => {
      const result = assess([{ path: 'apps/api/logger.rb', added: 'logger.info(user.email)' }]);
      assert.ok(result.impacts.includes('PIILogging'));
      assert.ok(result.requiredVerifiers.includes('pii-log-check'));
    });
    it('when explicit SBI security metadata declares RLS then cannot be downgraded', () => {
      const result = assess([], { securityImpact: ['RLS'], minimumRiskLevel: 3, preImplementationGate: true });
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
        const checks = ['verification', 'policy-review', 'security', 'completion'].map(id => ({ id, required: true, status: 'PASS' }));
        const result = mergeDecision({ risk: { level: 3, requiredHumanApprovals: 2 }, headSha, contextDigest, approvals, checks, humanGate: true, gateApproved, securityVerification: security('FAIL') });
        assert.notEqual(result.decision, 'MERGE_ALLOWED');
      });
    }
  });
});

describe('Security enforcement in the execution loop', () => {
  describe('given RLS metadata and no installed RLS verifier', () => {
    it('when gate approval is granted then reports NOT_CONFIGURED and never DONE', () => fixture(async root => {
      await update(root, '.harness/state/sample-sbi.json', s => s.securityImpact = ['RLS']);
      const run = await runHarness({ root, quiet: true });
      assert.equal(run.status, 'WAITING_FOR_HUMAN_GATE');
      await recordDecision({ root, runId: run.id, purpose: 'implementation-gate', identityProvider: human('Designer') });
      const resumed = await resumeRun({ root, runId: run.id, quiet: true });
      assert.notEqual(resumed.executionStatus, 'DONE');
      const evidence = await readJson(join(root, run.runDir, 'security-verification.json'));
      assert.equal(evidence.checks.find(c => c.id === 'rails-rls-test').status, 'NOT_CONFIGURED');
    }));
    it('when a trusted RLS command is configured then verifies it and still requires two merge reviewers', () => fixture(async root => {
      await update(root, '.harness/state/sample-sbi.json', s => s.securityImpact = ['RLS']);
      await update(root, '.harness/config/harness.json', c => c.securityVerifiers = [{ id: 'rails-rls-test', directory: 'apps/api', commands: [['node', '-e', 'require("node:assert/strict").ok(true)']] }]);
      const run = await runHarness({ root, quiet: true });
      await recordDecision({ root, runId: run.id, purpose: 'implementation-gate', identityProvider: human('Designer') });
      let resumed = await resumeRun({ root, runId: run.id, quiet: true });
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
      for (const id of ['A', 'B']) await recordDecision({ root, runId: run.id, purpose: 'implementation-gate', identityProvider: human(id) });
      await resumeRun({ root, runId: run.id, quiet: true, agent });
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
    it('when unsafe TLS settings are proposed then classifies them as security sensitive', () => {
      const result = assess([{path:'apps/admin/client.js',added:'process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0'}]);
      assert.equal(result.minimumRiskLevel,3);
      assert.ok(result.matchedRules.includes('SEC-CONFIG-001'));
    });
    it('when agent introduces PII after an RLS-only gate then stops before applying it', () => fixture(async root => {
      await update(root,'.harness/state/sample-sbi.json',s=>s.securityImpact=['RLS']);
      const run=await runHarness({root,quiet:true});
      await recordDecision({root,runId:run.id,purpose:'implementation-gate',identityProvider:human('Designer')});
      const resumed=await resumeRun({root,runId:run.id,quiet:true,agent:async()=>({files:[{path:'greeting.mjs',content:good+'\n// logger.info(user.email)'}]})});
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
