import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readyBinding, readReadyBinding } from './ready-approval.mjs';
import { githubCli } from './planner-github.mjs';
import { githubMock } from './test-github.mjs';

const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
// #194: a human approves an SBI Issue by adding ready. GitHub dates that labeled event, every body edit (userContentEdits) and every title change
// (renamed), so the approval covers the Issue exactly as it was when ready was added.
const readyAt = '2026-10-30T10:00:00Z';
const labeled = (at = readyAt, name = 'ready') => ({ event: 'labeled', label: { name }, created_at: at });
const renamed = at => ({ event: 'renamed', created_at: at });
const issue = { title: 'SBI-001 ホームに見出しを表示する', body: '## 目的\n\n見出しを表示する。\n' };
// A version of the body GitHub keeps in the edit history; the newest one is the current body.
const edit = (editedAt, deletedAt = null, body = deletedAt ? null : issue.body) => ({ editedAt, deletedAt, body });
const judge = ({ timeline = [labeled()], edits = [], current = issue } = {}) => readyBinding({ url: ref.url, issue: current, timeline, edits });

describe('Binding the ready label to the content it approved', () => {
  describe('given an SBI Issue that a human marked ready', () => {
    it('when nothing was edited since ready was added then the approval holds', () => {
      assert.deepEqual(judge(), []);
    });
    it('when the body was only edited before ready was added then the approval holds, since the human approved the edited body', () => {
      assert.deepEqual(judge({ edits: [edit('2026-10-30T09:00:00Z'), edit('2026-10-30T09:30:00Z')] }), []);
    });
    it('when the title was only changed before ready was added then the approval holds', () => {
      assert.deepEqual(judge({ timeline: [renamed('2026-10-30T09:00:00Z'), labeled()] }), []);
    });
  });

  describe('given an edit after ready was added', () => {
    for (const [name, input, pattern] of [
      ['the body was edited after ready', { edits: [edit('2026-10-30T11:00:00Z')] }, /edited/],
      ['the body went from A to B and back to A after ready', { edits: [edit('2026-10-30T11:00:00Z'), edit('2026-10-30T12:00:00Z')] }, /edited/],
      ['the body was edited in the same second as ready, so the order is unknown', { edits: [edit(readyAt)] }, /edited/],
      ['the title was changed after ready', { timeline: [labeled(), renamed('2026-10-30T11:00:00Z')] }, /title/],
      ['an edit has no date', { edits: [edit(null)] }, /edited/],
      ['an earlier edit was deleted from the history after ready', { edits: [edit('2026-10-30T09:00:00Z', '2026-10-30T11:00:00Z')] }, /edit history/],
    ]) {
      it(`when ${name} then the approval does not hold and the reason names the Issue`, () => {
        const reasons = judge(input);
        assert.ok(reasons.length && reasons.every(r => r.includes(ref.url)), JSON.stringify(reasons));
        assert.match(reasons.join('\n'), pattern);
      });
    }
    it('when ready was removed and added again after the edits then the approval of the new content holds', () => {
      const timeline = [labeled(), { event: 'unlabeled', label: { name: 'ready' }, created_at: '2026-10-30T12:30:00Z' }, labeled('2026-10-30T13:00:00Z')];
      assert.deepEqual(judge({ timeline, edits: [edit('2026-10-30T11:00:00Z'), edit('2026-10-30T12:00:00Z')] }), []);
    });
  });

  // The content approved at ready and the content the run takes must have the same digest, whatever the dates say.
  describe('given the body GitHub kept as it was at ready', () => {
    it('when the newest version before ready differs from the current body, though no edit is dated after ready, then the approval does not hold', () => {
      assert.match(judge({ edits: [edit('2026-10-30T09:00:00Z', null, '## 目的\n\n別の内容。\n')] }).join('\n'), /digest/);
    });
    it('when the version at ready was deleted from the history then the approved content is unknown and the approval does not hold', () => {
      assert.match(judge({ edits: [edit('2026-10-30T09:00:00Z', '2026-10-30T09:30:00Z')] }).join('\n'), /digest/);
    });
  });

  describe('given a timeline that does not date the ready label', () => {
    for (const [name, timeline] of [
      ['has no labeled event for ready', [labeled(readyAt, 'sbi')]],
      ['dates the labeled event of ready with no time', [{ event: 'labeled', label: { name: 'ready' } }]],
    ]) {
      it(`when it ${name} then the approval does not hold`, () => {
        assert.match(judge({ timeline }).join('\n'), /ready/);
      });
    }
  });

  describe('given the GitHub adapter', () => {
    const github = ({ timeline = [labeled()], edits = [], fails = null } = {}) => ({
      issueTimeline: async () => { if (fails === 'timeline') throw new Error('gh: Server Error (HTTP 502)'); return timeline; },
      bodyEdits: async () => { if (fails === 'edits') throw new Error('GraphQL: edit history of acme/app#7 is unavailable'); return edits; },
    });
    it('when GitHub shows no edit after ready then the approval holds', async () => {
      assert.deepEqual(await readReadyBinding({ ref, issue, github: github() }), []);
    });
    it('when GitHub shows an edit after ready then the approval does not hold', async () => {
      assert.ok((await readReadyBinding({ ref, issue, github: github({ edits: [edit('2026-10-30T11:00:00Z')] }) })).length);
    });
    for (const fails of ['timeline', 'edits']) {
      it(`when the ${fails} cannot be read then the approval does not hold`, async () => {
        const reasons = await readReadyBinding({ ref, issue, github: github({ fails }) });
        assert.ok(reasons.length && reasons.every(r => r.includes(ref.url)), JSON.stringify(reasons));
      });
    }
  });
});

describe('GitHub adapter for the ready approval', () => {
  const mockGitHub = githubMock({ issue: { number: 7, title: 'SBI-001 t', body: '', html_url: ref.url, state: 'open', labels: [{ name: 'sbi' }, { name: 'ready' }] } });
  describe('given the gh CLI', () => {
    it('when the timeline is read then the labeled and renamed events keep their label and date', () => mockGitHub({ issueTimelines: { 7: [labeled(), renamed('2026-10-30T11:00:00Z')] } }, async () => {
      assert.deepEqual((await githubCli.issueTimeline(ref)).map(e => [e.event, e.label?.name, e.created_at]), [['labeled', 'ready', readyAt], ['renamed', undefined, '2026-10-30T11:00:00Z']]);
    }));
    it('when the body edits are read then every edit of the GraphQL history keeps its date and body oldest first, deleted ones included', () => mockGitHub({ issueEdits: { 7: [
      { editedAt: '2026-10-30T11:00:00Z', deletedAt: null, diff: 'B' }, { editedAt: '2026-10-30T09:00:00Z', deletedAt: '2026-10-30T12:00:00Z', diff: null },
    ] } }, async () => {
      assert.deepEqual((await githubCli.bodyEdits(ref)).map(e => [e.editedAt, e.deletedAt, e.body]), [['2026-10-30T09:00:00Z', '2026-10-30T12:00:00Z', null], ['2026-10-30T11:00:00Z', null, 'B']]);
    }));
  });
});
