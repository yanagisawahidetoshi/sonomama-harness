import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, commitFixture } from './test-fixture.mjs';
import { verifySecurity } from './security-enforcement.mjs';
import { runCompletionJudge, runVerifier } from './impact.mjs';
import { readJson } from './io.mjs';

// A Security rule, not the SBI's requiredVerifiers, decides that a command verifier runs. It runs in the verifier matrix, and the
// Completion Judge only reads the matrix result: running it in the judge would run the PR's code there (#165 review).
const policy = JSON.parse(await readFile(new URL('../../.harness/rules/security.json', import.meta.url), 'utf8'));
const examples = 'require "rails_helper"\n\nRSpec.describe "Lessons", type: :request do\n  it "returns 401" do\n    expect(response).to have_http_status(:unauthorized)\n  end\nend\n';
const needs = verifiers => ({ impact: { result: 'success' }, verifiers: { result: verifiers }, 'harness-test': { result: 'skipped' }, 'harness-demo': { result: 'skipped' } });
const write = async (root, path, content) => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); };

for (const [id, ruleId, path, added, spec] of [
  ['authn-test', 'SEC-AUTH-001', 'apps/api/app/controllers/application_controller.rb', 'before_action :authenticate_user!', 'apps/api/spec/authentication/lessons_spec.rb'],
  ['rails-rls-test', 'SEC-RLS-001', 'apps/api/db/rls.sql', 'CREATE POLICY tenant ON lessons', 'apps/api/spec/rls/lessons_spec.rb'],
  ['data-lifecycle-test', 'SEC-DESTRUCTIVE-001', 'apps/api/app/jobs/purge_job.rb', 'Lesson.destroy_all', 'apps/api/spec/data_lifecycle/lessons_spec.rb'],
]) {
  describe(`${id} required by ${ruleId} but not listed in the SBI's requiredVerifiers`, () => {
    // The fixture's verifier runs only the static step, so the test stays hermetic.
    const pullRequest = async (root, specs) => {
      await update(root, '.harness/config/harness.json', c => { c.securityVerifiers.find(v => v.id === id).commands = [['node', 'tools/harness/security-specs.mjs', id]]; });
      await commitFixture(root);
      await write(root, path, `${added}\n`);
      for (const file of specs) await write(root, file, examples);
      const sample = await readJson(join(root, '.harness/state/sample-sbi.json'));
      await writeFile(join(root, '.harness/state/sbi-matrix.json'), JSON.stringify({ ...sample, id: 'SBI-MATRIX', allowedFiles: [path, ...specs], requiredSecurityRules: [ruleId], requiredVerifiers: [] }));
      await commitFixture(root);
    };
    describe('given a Production pull request whose SBI declares only the rule', () => {
      it(`when the impact is analyzed then ${id} is a mandatory leg of the verifier matrix and runs there`, () => fixture(async root => {
        await pullRequest(root, [spec]);
        const { impact, result, passed } = await runVerifier({ root, base: 'HEAD~1', id });
        assert.equal(impact.verifiers.find(v => v.id === id)?.mandatory, true, JSON.stringify(impact.verifiers));
        assert.deepEqual(result.checks.map(c => [c.id, c.status]), [[id, 'PASS']]);
        assert.equal(passed, true);
      }));
      it(`when the verifier matrix failed then the Completion Judge FAILs ${id}`, () => fixture(async root => {
        await pullRequest(root, [spec]);
        const result = await runCompletionJudge({ root, base: 'HEAD~1', needs: needs('failure') });
        const check = result.security.checks.find(c => c.id === id);
        assert.equal(check?.status, 'FAIL', JSON.stringify(result.security.checks));
        assert.match(check.reason, /verifier matrix: failure/);
        assert.equal(result.status, 'FAIL');
      }));
      it(`when the Completion Judge runs then it takes ${id} from the verifier matrix and never runs it itself`, () => fixture(async root => {
        // No spec exists, so running the verifier in the judge would FAIL; the judge reports the matrix result instead.
        await pullRequest(root, []);
        const result = await runCompletionJudge({ root, base: 'HEAD~1', needs: needs('success') });
        const check = result.security.checks.find(c => c.id === id);
        assert.equal(check?.status, 'PASS', JSON.stringify(result.security.checks));
        assert.match(check.reason, /verifier matrix: success/);
      }));
    });
  });
}

describe('A required command verifier that did not run in the verifier matrix', () => {
  describe('given Security is verified without running commands, as the Completion Judge does', () => {
    it('when the verifier is connected then FAILs it and never runs the command', () => fixture(async root => {
      await write(root, 'tools/harness/marker.mjs', 'import { writeFileSync } from "node:fs"; writeFileSync("ran", "");');
      const config = { securityVerifiers: [{ id: 'rails-rls-test', directory: '.', isolation: 'harness', commands: [['node', 'tools/harness/marker.mjs']] }] };
      const evidence = await verifySecurity({ workspace: root, assessment: { requiredVerifiers: ['rails-rls-test'] }, policy, config, headSha: 'a'.repeat(40), changed: [], runCommands: false });
      const check = evidence.checks.find(c => c.id === 'rails-rls-test');
      assert.equal(check.status, 'FAIL');
      assert.match(check.reason, /verifier matrix/);
      assert.equal(evidence.status, 'FAIL');
      await assert.rejects(lstat(join(root, 'ran')), { code: 'ENOENT' });
    }));
    it('when the verifier has no commands then stays NOT_CONFIGURED', async () => {
      const evidence = await verifySecurity({ workspace: '.', assessment: { requiredVerifiers: ['rails-rls-test'] }, policy, config: { securityVerifiers: [] }, headSha: 'a'.repeat(40), changed: [], runCommands: false });
      assert.equal(evidence.checks.find(c => c.id === 'rails-rls-test').status, 'NOT_CONFIGURED');
    });
  });
});
