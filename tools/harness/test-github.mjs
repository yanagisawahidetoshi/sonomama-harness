import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exists, readJson } from './io.mjs';

// Stub gh on PATH. It answers `gh api` calls for acme/app from a state directory and records every call.
export const githubMock = defaults => async (state, test) => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-gh-'));
  const previous = { PATH: process.env.PATH, GH_MOCK_DIR: process.env.GH_MOCK_DIR, GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY };
  try {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ labels: [], created: [], comments: [], failOnCreate: null, pulls: [], reviews: {}, checkRuns: {}, rules: [], viewer: 'harness-operator', bare: null, ...defaults, ...state }));
    await writeFile(join(dir, 'gh'), `#!${process.execPath}
      const fs = require('node:fs'), path = require('node:path');
      const dir = process.env.GH_MOCK_DIR, file = path.join(dir, 'state.json');
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      const args = process.argv.slice(2);
      const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
      fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, input }) + '\\n');
      const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
      const [endpoint, query = ''] = args.find(a => a.startsWith('repos/')).split('?');
      const params = Object.fromEntries(new URLSearchParams(query));
      const page = list => { const size = Number(params.per_page || 30), index = Number(params.page || 1); return list.slice((index - 1) * size, index * size); };
      const fail = (message, code = 1) => { process.stderr.write(message + '\\n'); process.exit(code); };
      const issueByNumber = number => number === state.issue.number ? state.issue : state.created.find(i => i.number === number);
      if (args[0] !== 'api') fail('unexpected gh command');
      if (state.failOnCreate && method === 'POST' && endpoint === 'repos/acme/app/issues' && state.created.length + 1 === state.failOnCreate) {
        state.failOnCreate = null; fs.writeFileSync(file, JSON.stringify(state)); fail('gh: Validation Failed (HTTP 422)');
      }
      let m;
      if (method === 'GET' && endpoint === 'repos/acme/app/issues') {
        if (!params.labels) fail('label filter required');
        process.stdout.write(JSON.stringify(page(state.created.filter(i => i.labels.some(l => l.name === params.labels)))));
      } else if (method === 'GET' && (m = endpoint.match(/^repos\\/acme\\/app\\/issues\\/(\\d+)\\/comments$/))) {
        process.stdout.write(JSON.stringify(page(state.comments.filter(c => c.issue === Number(m[1])))));
      } else if (method === 'PATCH' && (m = endpoint.match(/^repos\\/acme\\/app\\/issues\\/comments\\/(\\d+)$/))) {
        const comment = state.comments.find(c => c.id === Number(m[1])); if (!comment) fail('gh: Not Found (HTTP 404)');
        comment.body = JSON.parse(input).body; comment.updated = (comment.updated || 0) + 1; process.stdout.write(JSON.stringify(comment));
      } else if (method === 'POST' && (m = endpoint.match(/^repos\\/acme\\/app\\/issues\\/(\\d+)\\/labels$/))) {
        const issue = issueByNumber(Number(m[1])); if (!issue) fail('gh: Not Found (HTTP 404)');
        for (const name of JSON.parse(input).labels) { if (!state.labels.includes(name)) fail('gh: Validation Failed (HTTP 422): label ' + name + ' does not exist'); if (!issue.labels.some(l => l.name === name)) issue.labels.push({ name }); }
        process.stdout.write(JSON.stringify(issue.labels));
      } else if (method === 'DELETE' && (m = endpoint.match(/^repos\\/acme\\/app\\/issues\\/(\\d+)\\/labels\\/(.+)$/))) {
        const issue = issueByNumber(Number(m[1])), name = decodeURIComponent(m[2]);
        if (!issue || !issue.labels.some(l => l.name === name)) fail('gh: Label does not exist (HTTP 404)');
        issue.labels = issue.labels.filter(l => l.name !== name); process.stdout.write(JSON.stringify(issue.labels));
      } else if (method === 'GET' && (m = endpoint.match(/^repos\\/acme\\/app\\/issues\\/(\\d+)$/))) {
        if (Number(m[1]) !== state.issue.number) fail('gh: Not Found (HTTP 404)');
        process.stdout.write(JSON.stringify(state.issue));
      } else if (method === 'GET' && (m = endpoint.match(/^repos\\/acme\\/app\\/labels\\/(.+)$/))) {
        const name = decodeURIComponent(m[1]);
        if (!state.labels.includes(name)) fail('gh: Not Found (HTTP 404)');
        process.stdout.write(JSON.stringify({ name }));
      } else if (method === 'POST' && endpoint === 'repos/acme/app/labels') {
        const label = JSON.parse(input); state.labels.push(label.name); process.stdout.write(JSON.stringify(label));
      } else if (method === 'POST' && endpoint === 'repos/acme/app/issues') {
        const issue = JSON.parse(input); const number = 101 + state.created.length;
        const created = { number, title: issue.title, body: issue.body, state: 'open', html_url: 'https://github.com/acme/app/issues/' + number, labels: (issue.labels || []).map(name => ({ name })) };
        state.created.push(created); process.stdout.write(JSON.stringify(created));
      } else if (method === 'POST' && (m = endpoint.match(/^repos\\/acme\\/app\\/issues\\/(\\d+)\\/comments$/))) {
        const id = 1 + state.comments.length;
        const comment = { id, issue: Number(m[1]), body: JSON.parse(input).body, html_url: 'https://github.com/acme/app/issues/' + m[1] + '#issuecomment-' + id };
        state.comments.push(comment); process.stdout.write(JSON.stringify(comment));
      } else if (method === 'GET' && endpoint === 'repos/acme/app/pulls') {
        process.stdout.write(JSON.stringify(page(state.pulls.filter(p => 'acme:' + p.head.ref === params.head && (params.state === 'all' || p.state === (params.state || 'open'))))));
      } else if (method === 'POST' && endpoint === 'repos/acme/app/pulls') {
        const body = JSON.parse(input), number = 201 + state.pulls.length;
        // The head SHA is whatever the pushed branch points to in the bare remote.
        const sha = require('node:child_process').execFileSync('git', ['--git-dir', state.bare, 'rev-parse', 'refs/heads/' + body.head], { encoding: 'utf8' }).trim();
        const pull = { number, title: body.title, body: body.body, state: 'open', merged: false, html_url: 'https://github.com/acme/app/pull/' + number, user: { login: state.viewer, type: 'User' }, head: { ref: body.head, sha }, base: { ref: body.base } };
        state.pulls.push(pull); process.stdout.write(JSON.stringify(pull));
      } else if (method === 'GET' && (m = endpoint.match(/^repos\\/acme\\/app\\/pulls\\/(\\d+)$/))) {
        const pull = state.pulls.find(p => p.number === Number(m[1])); if (!pull) fail('gh: Not Found (HTTP 404)');
        process.stdout.write(JSON.stringify(pull));
      } else if (method === 'GET' && (m = endpoint.match(/^repos\\/acme\\/app\\/pulls\\/(\\d+)\\/reviews$/))) {
        process.stdout.write(JSON.stringify(page(state.reviews[m[1]] || [])));
      } else if (method === 'GET' && (m = endpoint.match(/^repos\\/acme\\/app\\/commits\\/([0-9a-f]+)\\/check-runs$/))) {
        const runs = state.checkRuns[m[1]] || [];
        process.stdout.write(JSON.stringify({ total_count: runs.length, check_runs: page(runs) }));
      } else if (method === 'GET' && (m = endpoint.match(/^repos\\/acme\\/app\\/rules\\/branches\\/(.+)$/))) {
        process.stdout.write(JSON.stringify(page(state.rules)));
      } else fail('unexpected gh api call: ' + method + ' ' + endpoint);
      fs.writeFileSync(file, JSON.stringify(state));
    `);
    await chmod(join(dir, 'gh'), 0o755);
    process.env.PATH = `${dir}:${previous.PATH}`;
    process.env.GH_MOCK_DIR = dir;
    delete process.env.GITHUB_STEP_SUMMARY;
    const github = {
      state: () => readJson(join(dir, 'state.json')),
      update: async fn => { const value = await readJson(join(dir, 'state.json')); fn(value); await writeFile(join(dir, 'state.json'), JSON.stringify(value)); },
      calls: async () => (await exists(join(dir, 'calls.jsonl'))) ? (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : [],
      dir,
    };
    await test(github);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
};
