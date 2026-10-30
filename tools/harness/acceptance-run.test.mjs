import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceCommands, parseRspecJson, judgeDetection, judgeAcceptance } from './acceptance-run.mjs';

const path = 'apps/api/spec/acceptance/sbi_7/courses_spec.rb';
const registration = {
  version: 2, sbiIssue: 7, mapping: [
    { scenario: '担当講師が閲覧する', acceptanceIds: ['AC-1'], examples: [{ path, description: '担当講師が閲覧する: 200を返す' }] },
    { scenario: '担当外の講師が閲覧する', acceptanceIds: ['AC-2'], examples: [{ path, description: '担当外の講師が閲覧する: 403を返す' }] },
  ],
};
const example = (description, status, exceptionClass = null) => ({
  description, full_description: `講座の閲覧 ${description}`, status, file_path: './spec/acceptance/sbi_7/courses_spec.rb',
  ...(exceptionClass ? { exception: { class: exceptionClass, message: 'boom' } } : {}),
});
const report = (examples, errors = 0) => JSON.stringify({ version: '3.13.0', examples, summary: { example_count: examples.length, failure_count: examples.filter(e => e.status === 'failed').length, errors_outside_of_examples_count: errors } });
const notMet = 'RSpec::Expectations::ExpectationNotMetError';

describe('Commands that run the generated acceptance specs', () => {
  const commands = acceptanceCommands(7);
  it('when built then they run only the acceptance directory of the SBI on the local test database and stop the containers', () => {
    const runs = commands.filter(c => c.includes('run'));
    assert.ok(runs.every(c => c.includes('RAILS_ENV=test') && c.some(a => /^DATABASE_URL=postgres:\/\/postgres@db:5432\/[a-z_]+_test$/.test(a))));
    assert.ok(runs.some(c => c.join(' ').endsWith('bundle exec rspec spec/acceptance/sbi_7 --format json')));
    assert.ok(runs.findIndex(c => c.includes('db:prepare')) < runs.findIndex(c => c.includes('rspec')));
    assert.deepEqual(commands.at(-1), ['docker', 'compose', '-f', 'compose.yaml', 'down']);
  });
  it('when built then every command has the form the compose isolation accepts', () => {
    for (const command of commands) assert.deepEqual(command.slice(0, 3), ['docker', 'compose', '-f']);
  });
});

describe('RSpec JSON report', () => {
  it('when Compose and Rails print logs before the report then the report is still read', () => {
    const parsed = parseRspecJson(` Container db-1  Running\nRails Error: something\n${report([example('a', 'passed')])}\n`);
    assert.deepEqual(parsed.examples.map(e => [e.description, e.status]), [['a', 'passed']]);
    assert.equal(parsed.errorsOutsideOfExamples, 0);
  });
  it('when there is no report then it says so instead of returning an empty result', () => {
    assert.equal(parseRspecJson('bundler: command not found: rspec').error, 'no RSpec JSON report in the output');
  });
});

describe('Detection (G): the generated specs run before the implementation', () => {
  const judge = (examples, errors = 0) => judgeDetection({ registration, report: parseRspecJson(report(examples, errors)) });
  it('when every example fails on an expectation then each Scenario detects the missing behavior', () => {
    const result = judge([example('担当講師が閲覧する: 200を返す', 'failed', notMet), example('担当外の講師が閲覧する: 403を返す', 'failed', notMet)]);
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.scenarios.map(s => s.outcome), ['detected', 'detected']);
  });
  it('when an example already passes then it is recorded as already satisfied, without requiring RED', () => {
    const result = judge([example('担当講師が閲覧する: 200を返す', 'passed'), example('担当外の講師が閲覧する: 403を返す', 'failed', notMet)]);
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.scenarios.map(s => s.outcome), ['already satisfied', 'detected']);
  });
  for (const [name, examples, errors, pattern] of [
    ['an example fails with an error that is not an expectation', [example('担当講師が閲覧する: 200を返す', 'failed', 'NameError'), example('担当外の講師が閲覧する: 403を返す', 'failed', notMet)], 0, /NameError/],
    ['the spec file cannot be loaded', [], 1, /outside of examples/],
    ['a mapped example did not run', [example('担当講師が閲覧する: 200を返す', 'failed', notMet)], 0, /403を返す/],
    ['an example is pending', [example('担当講師が閲覧する: 200を返す', 'pending'), example('担当外の講師が閲覧する: 403を返す', 'failed', notMet)], 0, /pending/],
  ]) {
    it(`when ${name} then detection is undeterminable and stops`, () => {
      const result = judge(examples, errors);
      assert.equal(result.status, 'UNDETERMINABLE');
      assert.match(result.reasons.join('\n'), pattern);
    });
  }
  it('when the RSpec report is missing then detection is undeterminable', () => {
    const result = judgeDetection({ registration, report: parseRspecJson('Docker is not running') });
    assert.equal(result.status, 'UNDETERMINABLE');
  });
});

describe('Acceptance (I): the generated specs run after the implementation', () => {
  const judge = examples => judgeAcceptance({ registration, report: parseRspecJson(report(examples)) });
  it('when every mapped example passes then every acceptance criterion is met', () => {
    const result = judge([example('担当講師が閲覧する: 200を返す', 'passed'), example('担当外の講師が閲覧する: 403を返す', 'passed')]);
    assert.deepEqual([result.status, result.acceptance], ['PASS', ['AC-1', 'AC-2']]);
  });
  it('when one example fails then its acceptance criterion is not met and the check fails', () => {
    const result = judge([example('担当講師が閲覧する: 200を返す', 'passed'), example('担当外の講師が閲覧する: 403を返す', 'failed', notMet)]);
    assert.deepEqual([result.status, result.acceptance], ['FAIL', ['AC-1']]);
    assert.match(result.reasons.join('\n'), /AC-2/);
  });
  it('when a mapped example is missing from the report then the check fails', () => {
    const result = judge([example('担当講師が閲覧する: 200を返す', 'passed')]);
    assert.equal(result.status, 'FAIL');
  });
  it('when the report is missing then the check fails and meets nothing', () => {
    const result = judgeAcceptance({ registration, report: parseRspecJson('') });
    assert.deepEqual([result.status, result.acceptance], ['FAIL', []]);
  });
});
