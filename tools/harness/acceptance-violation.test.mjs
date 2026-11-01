import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectViolation, judgeViolation, violationLimits, violationResponseSchema } from './acceptance-violation.mjs';

// #147: controlled violation. For a Scenario that already passes before the implementation, the generation agent proposes a minimal change
// to the application that must make that Scenario's expected outcome fail. The Harness accepts or rejects the proposal mechanically.
const controller = 'apps/api/app/controllers/courses_controller.rb';
const original = 'class CoursesController < ApplicationController\n  def show\n    head :ok\n  end\nend\n';
const violated = original.replace('head :ok', 'head :not_found');
async function workspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'harness-violation-'));
  try {
    await mkdir(join(root, 'apps/api/app/controllers'), { recursive: true });
    await writeFile(join(root, controller), original);
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const proposal = (files, scenario = '担当講師が閲覧する') => ({ scenario, files });

describe('Static checks of a controlled violation proposal', () => {
  it('when the proposal changes a few lines of an existing application file then it is accepted with its digest and changed line count', () => workspace(async root => {
    const result = await inspectViolation({ workspace: root, proposal: proposal([{ path: controller, content: violated }]) });
    assert.deepEqual(result.findings, []);
    assert.equal(result.changedLines, 2);
    assert.match(result.patchDigest, /^[0-9a-f]{64}$/);
  }));
  for (const [name, path] of [
    ['a request spec', 'apps/api/spec/requests/courses_spec.rb'],
    ['the generated acceptance', 'apps/api/spec/acceptance/sbi_7/courses_spec.rb'],
    ['spec support', 'apps/api/spec/rails_helper.rb'],
    ['a fixture', 'apps/api/spec/fixtures/courses.yml'],
    ['config', 'apps/api/config/routes.rb'],
    ['a migration', 'apps/api/db/migrate/001_courses.rb'],
    ['the DB schema', 'apps/api/db/schema.rb'],
    ['the Harness', 'tools/harness/index.mjs'],
    ['a registration', '.harness/acceptance/sbi-7.json'],
    ['another app', 'apps/admin/src/main.ts'],
  ]) {
    it(`when the proposal touches ${name} then it is rejected`, () => workspace(async root => {
      const result = await inspectViolation({ workspace: root, proposal: proposal([{ path, content: 'x\n' }]) });
      assert.ok(result.findings.some(f => f.path === path), JSON.stringify(result.findings));
    }));
  }
  it('when the proposal adds a file that does not exist then it is rejected, since a violation changes existing behavior only', () => workspace(async root => {
    const path = 'apps/api/app/controllers/other_controller.rb';
    const result = await inspectViolation({ workspace: root, proposal: proposal([{ path, content: 'class OtherController; end\n' }]) });
    assert.ok(result.findings.some(f => f.path === path && /does not exist/.test(f.message)));
  }));
  it('when the proposal changes nothing then it is rejected', () => workspace(async root => {
    const result = await inspectViolation({ workspace: root, proposal: proposal([{ path: controller, content: original }]) });
    assert.ok(result.findings.some(f => /changes nothing/.test(f.message)));
  }));
  it('when the proposal changes more lines than the limit then it is rejected as not minimal', () => workspace(async root => {
    const big = `${original}${Array.from({ length: violationLimits.changedLines + 1 }, (_, i) => `# ${i}`).join('\n')}\n`;
    const result = await inspectViolation({ workspace: root, proposal: proposal([{ path: controller, content: big }]) });
    assert.ok(result.findings.some(f => /lines/.test(f.message)));
  }));
  it('when the proposal changes more files than the limit then it is rejected', () => workspace(async root => {
    const files = [];
    for (let i = 0; i <= violationLimits.files; i += 1) {
      const path = `apps/api/app/controllers/c${i}_controller.rb`;
      await writeFile(join(root, path), 'class C; end\n');
      files.push({ path, content: 'class D; end\n' });
    }
    const result = await inspectViolation({ workspace: root, proposal: proposal(files) });
    assert.ok(result.findings.some(f => /files/.test(f.message)));
  }));
  it('when the proposal names the same file twice, carries a credential or goes through a symlink then it is rejected', () => workspace(async root => {
    await symlink(join(root, 'apps/api/app/controllers'), join(root, 'apps/api/app/linked'));
    const token = 'ghp_' + 'z'.repeat(36);
    const result = await inspectViolation({ workspace: root, proposal: proposal([
      { path: controller, content: violated }, { path: controller, content: violated },
    ]) });
    assert.ok(result.findings.some(f => /more than once/.test(f.message)));
    const secret = await inspectViolation({ workspace: root, proposal: proposal([{ path: controller, content: `${violated}# ${token}\n` }]) });
    assert.ok(secret.findings.some(f => /credential/.test(f.message)));
    const linked = await inspectViolation({ workspace: root, proposal: proposal([{ path: 'apps/api/app/linked/courses_controller.rb', content: violated }]) });
    assert.ok(linked.findings.some(f => /symlink/.test(f.message)));
  }));
  it('when the proposal is checked then the workspace is not changed', () => workspace(async root => {
    await inspectViolation({ workspace: root, proposal: proposal([{ path: controller, content: violated }]) });
    assert.equal(await readFile(join(root, controller), 'utf8'), original);
  }));
});

describe('Judging the run of a controlled violation', () => {
  const notMet = 'RSpec::Expectations::ExpectationNotMetError';
  const registration = { mapping: [
    { scenario: '担当講師が閲覧する', acceptanceIds: ['AC-1'], examples: [{ path: 'x', description: '担当講師が閲覧する: 200を返す' }, { path: 'x', description: '担当講師が閲覧する: 講座名を返す' }] },
    { scenario: '担当外の講師が閲覧する', acceptanceIds: ['AC-2'], examples: [{ path: 'x', description: '担当外の講師が閲覧する: 403を返す' }] },
  ] };
  const example = (description, status, exceptionClass = status === 'failed' ? notMet : null) => ({ description, status, exceptionClass, message: status === 'failed' ? 'expected 200, got 404' : null });
  const judge = (examples, extra = {}) => judgeViolation({ registration, scenario: '担当講師が閲覧する', report: { examples, errorsOutsideOfExamples: 0, ...extra } });
  it('when an example of the target Scenario fails on its expectation then the violation is detected and the failed expectation is recorded', () => {
    const result = judge([example('担当講師が閲覧する: 200を返す', 'failed'), example('担当講師が閲覧する: 講座名を返す', 'passed')]);
    assert.equal(result.outcome, 'detected');
    assert.deepEqual(result.failures, [{ description: '担当講師が閲覧する: 200を返す', message: 'expected 200, got 404' }]);
  });
  it('when every example of the target Scenario still passes then the violation is missed', () => {
    const result = judge([example('担当講師が閲覧する: 200を返す', 'passed'), example('担当講師が閲覧する: 講座名を返す', 'passed')]);
    assert.equal(result.outcome, 'missed');
  });
  it('when only another Scenario fails then the violation is missed for the target', () => {
    const result = judge([example('担当講師が閲覧する: 200を返す', 'passed'), example('担当講師が閲覧する: 講座名を返す', 'passed'), example('担当外の講師が閲覧する: 403を返す', 'failed')]);
    assert.equal(result.outcome, 'missed');
  });
  for (const [name, examples, extra] of [
    ['a target example fails with an error that is not an expectation', [example('担当講師が閲覧する: 200を返す', 'failed', 'NoMethodError'), example('担当講師が閲覧する: 講座名を返す', 'failed')], {}],
    ['the specs cannot be loaded', [], { errorsOutsideOfExamples: 1 }],
    ['a target example did not run', [example('担当講師が閲覧する: 200を返す', 'failed')], {}],
    ['a target example is pending', [example('担当講師が閲覧する: 200を返す', 'failed'), example('担当講師が閲覧する: 講座名を返す', 'pending')], {}],
  ]) {
    it(`when ${name} then the violation is undeterminable, never detected`, () => {
      const result = judge(examples, extra);
      assert.equal(result.outcome, 'undeterminable');
      assert.ok(result.reason);
    });
  }
  it('when the run produced no report then it is an environment failure, not a test quality result', () => {
    assert.equal(judge([], { error: 'Docker is not running' }).outcome, 'environment');
  });
});

describe('The response schema handed to the violation agent', () => {
  // The Claude CLI rejects a --json-schema that declares the draft 2020-12 meta-schema before calling the model.
  it('given the schema the Harness passes to the agent when the CLI reads it then it declares no $schema', () => {
    assert.equal(Object.hasOwn(violationResponseSchema, '$schema'), false);
  });
});
