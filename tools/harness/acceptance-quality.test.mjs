import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectGeneratedAcceptance, acceptanceDirectory } from './acceptance-quality.mjs';

// The approved spec of SBI Issue #7 and what the generation agent returned for it.
const spec = {
  sbiIssue: 7,
  acceptanceCriteria: [{ id: 'AC-1', description: '担当講師は閲覧できる' }, { id: 'AC-2', description: '担当外の講師は403になる' }],
  scenarios: ['担当講師が閲覧する', '担当外の講師が閲覧する'],
};
const path = 'apps/api/spec/acceptance/sbi_7/courses_spec.rb';
const source = examples => `# frozen_string_literal: true

require "rails_helper"

RSpec.describe "講座の閲覧", type: :request do
${examples}
end
`;
const owner = `  it "担当講師が閲覧する: 200を返す" do
    get "/api/v1/courses/1", headers: auth(owner)
    expect(response).to have_http_status(:ok)
  end`;
const stranger = `  it "担当外の講師が閲覧する: 403を返す" do
    get "/api/v1/courses/1", headers: auth(stranger)
    expect(response).to have_http_status(:forbidden)
  end`;
const generated = (overrides = {}) => ({
  files: [{ path, content: source(`${owner}\n\n${stranger}`) }],
  mapping: [
    { scenario: '担当講師が閲覧する', acceptanceIds: ['AC-1'], examples: [{ path, description: '担当講師が閲覧する: 200を返す' }] },
    { scenario: '担当外の講師が閲覧する', acceptanceIds: ['AC-2'], examples: [{ path, description: '担当外の講師が閲覧する: 403を返す' }] },
  ],
  ...overrides,
});
const inspect = value => inspectGeneratedAcceptance({ spec, generated: value });

describe('Generated Trusted Acceptance quality: mapping', () => {
  it('when every AC and Scenario maps to an existing example with an expectation then it passes', () => {
    assert.deepEqual(inspect(generated()), { status: 'PASS', findings: [] });
  });
  it('when the files live outside the protected acceptance directory of the SBI then it fails', () => {
    const elsewhere = 'apps/api/spec/requests/courses_spec.rb';
    const value = generated({ files: [{ path: elsewhere, content: source(owner) }] });
    assert.match(inspect(value).findings.map(f => f.message).join('\n'), new RegExp(acceptanceDirectory(7).replaceAll('/', '\\/')));
  });
  it('when an acceptance criterion has no example then it fails and names it', () => {
    const value = generated({ mapping: [generated().mapping[0]] });
    assert.match(inspect(value).findings.map(f => f.message).join('\n'), /AC-2/);
  });
  it('when a Scenario has no example then it fails and names it', () => {
    const value = generated({ mapping: [generated().mapping[0], { ...generated().mapping[1], scenario: '別のScenario' }] });
    assert.match(inspect(value).findings.map(f => f.message).join('\n'), /担当外の講師が閲覧する/);
  });
  it('when the mapping names an example that does not exist in the file then it fails instead of trusting the list', () => {
    const value = generated({ files: [{ path, content: source(owner) }] });
    assert.match(inspect(value).findings.map(f => f.message).join('\n'), /担当外の講師が閲覧する: 403を返す/);
  });
  describe('given an example description that contains an escaped quote', () => {
    const quoted = (literal, metadata = '') => `  it ${literal}${metadata} do
    get "/api/v1/health"
    expect(response).to have_http_status(:ok)
  end`;
    const withExample = (literal, description, metadata) => generated({
      files: [{ path, content: source(`${quoted(literal, metadata)}\n\n${stranger}`) }],
      mapping: [{ ...generated().mapping[0], examples: [{ path, description }] }, generated().mapping[1]],
    });
    it('when a double-quoted description escapes " and the mapping names the text Ruby reads then it passes', () => {
      assert.deepEqual(inspect(withExample('"担当講師が閲覧する: body は {\\"status\\":\\"ok\\"}"', '担当講師が閲覧する: body は {"status":"ok"}')), { status: 'PASS', findings: [] });
    });
    it("when a single-quoted description escapes ' and the mapping names the text Ruby reads then it passes", () => {
      assert.deepEqual(inspect(withExample("'担当講師が閲覧する: it\\'s ok'", "担当講師が閲覧する: it's ok")), { status: 'PASS', findings: [] });
    });
    it('when the mapping names the description with its backslashes then it fails because Ruby reads no backslash there', () => {
      const value = withExample('"担当講師が閲覧する: {\\"status\\"}"', '担当講師が閲覧する: {\\"status\\"}');
      assert.match(inspect(value).findings.map(f => f.message).join('\n'), /is not in the generated files/);
    });
    it('when skip metadata follows a description with an escaped quote then it still fails as not run normally', () => {
      const value = withExample('"担当講師が閲覧する: {\\"status\\"}"', '担当講師が閲覧する: {"status"}', ', :skip');
      assert.match(inspect(value).findings.map(f => f.message).join('\n'), /skips or focuses it/);
    });
  });
  it('when the mapping names an AC the spec does not have then it fails', () => {
    const value = generated({ mapping: [...generated().mapping, { scenario: '担当講師が閲覧する', acceptanceIds: ['AC-9'], examples: generated().mapping[0].examples }] });
    assert.match(inspect(value).findings.map(f => f.message).join('\n'), /AC-9/);
  });
});

describe('Generated Trusted Acceptance quality: the examples really check something', () => {
  for (const [name, example, pattern] of [
    ['has no expectation', `  it "担当外の講師が閲覧する: 403を返す" do\n    get "/api/v1/courses/1"\n  end`, /expect/],
    ['is empty', `  it "担当外の講師が閲覧する: 403を返す" do\n  end`, /expect/],
    ['always passes with a constant expectation', `  it "担当外の講師が閲覧する: 403を返す" do\n    expect(true).to be(true)\n  end`, /constant/],
    ['is skipped', `  xit "担当外の講師が閲覧する: 403を返す" do\n    expect(response).to have_http_status(:forbidden)\n  end`, /xit/],
    ['is pending', `  it "担当外の講師が閲覧する: 403を返す" do\n    pending "later"\n    expect(response).to have_http_status(:forbidden)\n  end`, /pending/],
    ['is focused', `  it "担当外の講師が閲覧する: 403を返す", :focus do\n    expect(response).to have_http_status(:forbidden)\n  end`, /focus/],
    ['stubs the authorization of every instance', `  it "担当外の講師が閲覧する: 403を返す" do\n    allow_any_instance_of(CoursePolicy).to receive(:show?).and_return(false)\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:forbidden)\n  end`, /allow_any_instance_of/],
    ['stubs the policy under test', `  it "担当外の講師が閲覧する: 403を返す" do\n    allow(CoursePolicy).to receive(:new).and_return(double(show?: false))\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:forbidden)\n  end`, /Policy/],
    ['stubs a message chain', `  it "担当外の講師が閲覧する: 403を返す" do\n    allow(Course).to receive_message_chain(:where, :first).and_return(nil)\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:forbidden)\n  end`, /receive_message_chain/],
  ]) {
    it(`when the mapped example ${name} then it fails`, () => {
      const value = generated({ files: [{ path, content: source(`${owner}\n\n${example}`) }] });
      const result = inspect(value);
      assert.equal(result.status, 'FAIL');
      assert.match(result.findings.map(f => f.message).join('\n'), pattern);
    });
  }
  it('when a marker appears only in a comment then it does not count', () => {
    const commented = `  it "担当外の講師が閲覧する: 403を返す" do\n    # xit and pending are not used here\n    get "/api/v1/courses/1"\n    expect(response).to have_http_status(:forbidden)\n  end`;
    assert.equal(inspect(generated({ files: [{ path, content: source(`${owner}\n\n${commented}`) }] })).status, 'PASS');
  });
  it('when the file is not a Ruby spec then it fails', () => {
    const value = generated({ files: [{ path: 'apps/api/spec/acceptance/sbi_7/courses.rb', content: source(owner) }] });
    assert.equal(inspect(value).status, 'FAIL');
  });
});
