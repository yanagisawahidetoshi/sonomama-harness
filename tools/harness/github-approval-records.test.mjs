import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commentApprovals, readCommentApprovals, approvalLine } from './github-approval-records.mjs';
import { specApprovals } from './spec-approval.mjs';

const digest = 'a'.repeat(64);
const at = '2026-10-30T00:00:00Z';
const comment = (id, login, body, overrides = {}) => ({ id, body, html_url: `https://github.com/acme/app/issues/8#issuecomment-${id}`, user: { login, type: 'User' }, created_at: at, updated_at: at, ...overrides });
const approve = (id, login = 'alice', overrides) => comment(id, login, `harness-pbi-plan: ${digest}`, overrides);
const revoke = (id, login = 'alice') => comment(id, login, `harness-pbi-plan-revoke: ${digest}`);
const judge = (comments, permissions = { alice: 'write', bob: 'admin' }) => commentApprovals({ comments, prefix: 'harness-pbi-plan', digest, permissions });

describe('Approval records in GitHub Issue comments', () => {
  describe('given comments that carry exactly one approval line for the digest', () => {
    it('when a person with write access posted it then the digest is approved by that person', () => {
      assert.deepEqual(judge([approve(1)]), { approved: true, approvers: ['alice'] });
    });
    it('when the line has surrounding whitespace then it still counts', () => {
      assert.equal(judge([comment(1, 'alice', `\n  harness-pbi-plan: ${digest}  \n`)]).approved, true);
    });
    it('when the approval line is rendered then it is the exact line the checker accepts', () => {
      assert.equal(approvalLine('harness-pbi-plan', digest), `harness-pbi-plan: ${digest}`);
      assert.equal(approvalLine('harness-pbi-plan', digest, 'revoke'), `harness-pbi-plan-revoke: ${digest}`);
    });
  });

  describe('given comments that must not count', () => {
    for (const [name, comments, permissions] of [
      ['the approval is for another digest', [comment(1, 'alice', `harness-pbi-plan: ${'b'.repeat(64)}`)]],
      ['the approval line is only quoted inside another line', [comment(1, 'alice', `> harness-pbi-plan: ${digest}`)]],
      ['the comment explains the decision around the approval line', [comment(1, 'alice', `## SBI構成を確認しました。\n\nharness-pbi-plan: ${digest}\n`)]],
      ['the line is inside an HTML comment', [comment(1, 'alice', `<!--\nharness-pbi-plan: ${digest}\n-->`)]],
      ['the line is inside a code block', [comment(1, 'alice', `\`\`\`\nharness-pbi-plan: ${digest}\n\`\`\``)]],
      ['the line follows a refusal', [comment(1, 'alice', `承認しない:\nharness-pbi-plan: ${digest}`)]],
      ['the approval and the revoke lines are in one comment', [comment(1, 'alice', `harness-pbi-plan: ${digest}\nharness-pbi-plan-revoke: ${digest}`)]],
      ['the line uses another prefix', [comment(1, 'alice', `harness-spec: ${digest}`)]],
      ['the comment was edited after it was posted', [approve(1, 'alice', { updated_at: '2026-10-30T01:00:00Z' })]],
      ['a bot posted it', [approve(1, 'renovate[bot]', { user: { login: 'renovate[bot]', type: 'Bot' } })]],
      ['a user account typed as Bot posted it', [approve(1, 'helper', { user: { login: 'helper', type: 'Bot' } })]],
      ['the person only has read access', [approve(1)], { alice: 'read' }],
      ['the permission of the person could not be read', [approve(1)], { alice: 'unknown' }],
      ['the person later revoked it', [approve(1), revoke(2)]],
      ['the comment has no author', [approve(1, 'alice', { user: null })]],
      ['the comment has no creation time', [approve(1, 'alice', { created_at: undefined })]],
      ['the comment has no update time', [approve(1, 'alice', { updated_at: undefined })]],
      ['the comment has neither time, so an edit cannot be told apart', [approve(1, 'alice', { created_at: undefined, updated_at: undefined })]],
    ]) {
      it(`when ${name} then the digest is not approved`, () => {
        assert.equal(judge(comments, permissions).approved, false);
      });
    }
    it('when a person revoked and then approved again then the latest decision counts', () => {
      assert.deepEqual(judge([approve(1), revoke(2), approve(3)]), { approved: true, approvers: ['alice'] });
    });
    it('when the comments arrive out of order then they are ordered by id before taking the latest decision', () => {
      assert.equal(judge([revoke(2), approve(1)]).approved, false);
    });
    it('when one person revoked but another still approves then it stays approved by the other', () => {
      assert.deepEqual(judge([approve(1), approve(2, 'bob'), revoke(3)]), { approved: true, approvers: ['bob'] });
    });
  });

  describe('given the GitHub adapters', () => {
    it('when the records are read then the comments and the permission of each commenter come from GitHub', async () => {
      const asked = [];
      const result = await readCommentApprovals({
        ref: { owner: 'acme', repo: 'app', number: 8 }, prefix: 'harness-pbi-plan', digest,
        github: { async listComments(ref) { asked.push(['comments', ref.number]); return [approve(1), comment(2, 'carol', 'thanks')]; }, async permission(_ref, login) { asked.push(['permission', login]); return 'write'; } },
      });
      assert.deepEqual(result, { approved: true, approvers: ['alice'] });
      assert.deepEqual(asked, [['comments', 8], ['permission', 'alice']]);
    });
    it('when a permission cannot be read then that person does not count', async () => {
      const result = await readCommentApprovals({
        ref: { owner: 'acme', repo: 'app', number: 8 }, prefix: 'harness-pbi-plan', digest,
        github: { async listComments() { return [approve(1)]; }, async permission() { throw new Error('HTTP 403'); } },
      });
      assert.equal(result.approved, false);
    });
    it('when the comments cannot be read then reading fails', async () => {
      await assert.rejects(readCommentApprovals({
        ref: { owner: 'acme', repo: 'app', number: 8 }, prefix: 'harness-pbi-plan', digest,
        github: { async listComments() { throw new Error('HTTP 502'); }, async permission() { return 'write'; } },
      }), /HTTP 502/);
    });
  });

  describe('given the harness-spec approval of #147', () => {
    it('when it is judged then it uses this check with the harness-spec prefix', () => {
      const specComment = comment(1, 'alice', `harness-spec: ${digest}`);
      assert.deepEqual(specApprovals({ comments: [specComment], permissions: { alice: 'write' }, digest }), commentApprovals({ comments: [specComment], prefix: 'harness-spec', digest, permissions: { alice: 'write' } }));
      assert.equal(specApprovals({ comments: [comment(1, 'alice', `harness-pbi-plan: ${digest}`)], permissions: { alice: 'write' }, digest }).approved, false);
    });
  });
});
