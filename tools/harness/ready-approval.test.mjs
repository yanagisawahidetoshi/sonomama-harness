import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readyBinding, readReadyBinding } from './ready-approval.mjs';
import { githubCli } from './planner-github.mjs';
import { githubMock } from './test-github.mjs';

const ref = { owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/issues/7' };
// #194: a human approves an SBI Issue by adding ready. GitHub dates that labeled event, every body edit (userContentEdits) and every title change
// (renamed), so the approval covers the Issue exactly as it was when ready was added.
const readyAt = '2026-10-30T10:00:00Z';
const human = (login = 'alice') => ({ login, type: 'User' });
const labeled = (at = readyAt, name = 'ready', actor = human()) => ({ event: 'labeled', label: { name }, created_at: at, actor });
const issue = { title: 'SBI-001 ホームに見出しを表示する', body: '## 目的\n\n見出しを表示する。\n' };
const renamed = (at, from = 'SBI-001 見出しを表示する', to = issue.title) => ({ event: 'renamed', created_at: at, rename: { from, to } });
// A version of the body GitHub keeps in the edit history; the newest one is the current body. lastEditedAt is the newest edit GitHub reports.
const edit = (editedAt, deletedAt = null, body = deletedAt ? null : issue.body) => ({ editedAt, deletedAt, body });
const historyOf = (edits, lastEditedAt = edits.at(-1)?.editedAt ?? null) => ({ lastEditedAt, edits });
const judge = ({ timeline = [labeled()], edits = [], history = historyOf(edits), current = issue } = {}) => readyBinding({ url: ref.url, issue: current, timeline, history });

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

  // #200 review: an empty history is "never edited" only when GitHub also reports no last edit; a permission problem can return an empty connection.
  describe('given the last edit GitHub reports for the Issue', () => {
    it('when GitHub reports a last edit but returns no edit history then the approval does not hold', () => {
      assert.match(judge({ history: historyOf([], '2026-10-30T09:00:00Z') }).join('\n'), /edit history/);
    });
    it('when the last edit GitHub reports is at or after ready then the approval does not hold, whatever the history lists', () => {
      assert.match(judge({ history: historyOf([edit('2026-10-30T09:00:00Z')], '2026-10-30T11:00:00Z') }).join('\n'), /edited/);
    });
    it('when GitHub reports no last edit and no history then the body was never edited and the approval holds', () => {
      assert.deepEqual(judge({ history: historyOf([], null) }), []);
    });
  });

  // The title is on both sides of the digest: the title at ready is the one the last rename before ready left (or the current one without any).
  describe('given the title at ready', () => {
    it('when the last rename before ready left another title than the current one then the approval does not hold', () => {
      assert.match(judge({ timeline: [renamed('2026-10-30T09:00:00Z', issue.title, 'SBI-001 別のtitle'), labeled()] }).join('\n'), /digest/);
    });
  });

  describe('given an edit after ready was added', () => {
    for (const [name, input, pattern] of [
      ['the body was edited after ready', { edits: [edit('2026-10-30T11:00:00Z')] }, /edited/],
      ['the body went from A to B and back to A after ready', { edits: [edit('2026-10-30T11:00:00Z'), edit('2026-10-30T12:00:00Z')] }, /edited/],
      ['the body was edited in the same second as ready, so the order is unknown', { edits: [edit(readyAt)] }, /edited/],
      ['the title was changed after ready', { timeline: [labeled(), renamed('2026-10-30T11:00:00Z')] }, /title/],
      ['an edit has no date', { edits: [edit(null)] }, /edited/],
      ['an earlier edit was deleted from the history after ready', { history: historyOf([edit('2026-10-30T09:00:00Z', '2026-10-30T11:00:00Z')], '2026-10-30T09:00:00Z') }, /edit history/],
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
      assert.match(judge({ history: historyOf([edit('2026-10-30T09:00:00Z', '2026-10-30T09:30:00Z')], '2026-10-30T09:00:00Z') }).join('\n'), /digest/);
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
    const github = ({ timeline = [labeled()], edits = [], fails = null, access = { alice: { permission: 'write', role_name: 'write' } } } = {}) => ({
      issueTimeline: async () => { if (fails === 'timeline') throw new Error('gh: Server Error (HTTP 502)'); return timeline; },
      bodyHistory: async () => { if (fails === 'edits') throw new Error('GraphQL: edit history of acme/app#7 is unavailable'); return historyOf(edits); },
      collaboratorPermission: async (_, login) => { if (fails === 'permission' || !(login in access)) throw new Error('gh: Must have push access to view collaborator permission. (HTTP 403)'); return access[login]; },
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

    // #200: as for harness-spec, only a human with write access approves. The actor of the latest ready decides; GitHub records who added it.
    describe('and the person who added ready', () => {
      const by = (actor, access) => readReadyBinding({ ref, issue, github: github({ timeline: [labeled(readyAt, 'ready', actor)], ...(access ? { access } : {}) }) });
      for (const [name, actor, access] of [
        ['a bot account added ready', { login: 'planner', type: 'Bot' }, { planner: { permission: 'write', role_name: 'write' } }],
        ['an app with a [bot] login added ready', { login: 'harness[bot]', type: 'User' }, { 'harness[bot]': { permission: 'admin', role_name: 'admin' } }],
        ['a person with read access added ready', human('carol'), { carol: { permission: 'read', role_name: 'read' } }],
        ['a person with triage access added ready', human('dave'), { dave: { permission: 'read', role_name: 'triage' } }],
        ['the role of the person is not a write role', human('erin'), { erin: { permission: 'write', role_name: 'triage' } }],
        ['the permission of the person cannot be read', human('frank'), {}],
        ['GitHub records no actor for ready', null, undefined],
      ]) {
        it(`when ${name} then the approval does not hold`, async () => {
          const reasons = await by(actor, access);
          assert.ok(reasons.length && reasons.every(r => r.includes(ref.url)), JSON.stringify(reasons));
          assert.match(reasons.join('\n'), /ready was added by/);
        });
      }
      for (const [name, access] of [['write', { permission: 'write', role_name: 'write' }], ['maintain', { permission: 'write', role_name: 'maintain' }], ['admin', { permission: 'admin', role_name: 'admin' }]]) {
        it(`when a person with ${name} access added ready then the approval holds`, async () => {
          assert.deepEqual(await by(human('alice'), { alice: access }), []);
        });
      }
      it('when ready was removed and added again then the person who added it last decides', async () => {
        const access = { alice: { permission: 'write', role_name: 'write' }, carol: { permission: 'read', role_name: 'read' } };
        const removed = { event: 'unlabeled', label: { name: 'ready' }, created_at: '2026-10-30T11:00:00Z', actor: human('alice') };
        const again = (first, last) => readReadyBinding({ ref, issue, github: github({ access, timeline: [labeled(readyAt, 'ready', human(first)), removed, labeled('2026-10-30T12:00:00Z', 'ready', human(last))] }) });
        assert.match((await again('alice', 'carol')).join('\n'), /ready was added by carol/);
        assert.deepEqual(await again('carol', 'alice'), []);
      });
    });
  });
});

describe('GitHub adapter for the ready approval', () => {
  const mockGitHub = githubMock({ issue: { number: 7, title: 'SBI-001 t', body: '', html_url: ref.url, state: 'open', labels: [{ name: 'sbi' }, { name: 'ready' }] } });
  describe('given the gh CLI', () => {
    it('when the timeline is read then the labeled and renamed events keep their label, actor, date and titles', () => mockGitHub({ issueTimelines: { 7: [labeled(), renamed('2026-10-30T11:00:00Z')] } }, async () => {
      assert.deepEqual((await githubCli.issueTimeline(ref)).map(e => [e.event, e.label?.name, e.actor?.login, e.actor?.type, e.created_at, e.rename?.to]),
        [['labeled', 'ready', 'alice', 'User', readyAt, undefined], ['renamed', undefined, undefined, undefined, '2026-10-30T11:00:00Z', issue.title]]);
    }));
    it('when the permission of a person is read then both the permission and the role name come back', () => mockGitHub({ permissions: { alice: 'write' } }, async () => {
      assert.deepEqual(await githubCli.collaboratorPermission(ref, 'alice'), { permission: 'write', role_name: 'write' });
    }));
    it('when the body history is read then the last edit and every edit of the GraphQL history keep their date and body oldest first, deleted ones included', () => mockGitHub({ issueEdits: { 7: [
      { editedAt: '2026-10-30T11:00:00Z', deletedAt: null, diff: 'B' }, { editedAt: '2026-10-30T09:00:00Z', deletedAt: '2026-10-30T12:00:00Z', diff: null },
    ] }, issueLastEditedAt: { 7: '2026-10-30T11:00:00Z' } }, async () => {
      const history = await githubCli.bodyHistory(ref);
      assert.equal(history.lastEditedAt, '2026-10-30T11:00:00Z');
      assert.deepEqual(history.edits.map(e => [e.editedAt, e.deletedAt, e.body]), [['2026-10-30T09:00:00Z', '2026-10-30T12:00:00Z', null], ['2026-10-30T11:00:00Z', null, 'B']]);
    }));
  });
});
