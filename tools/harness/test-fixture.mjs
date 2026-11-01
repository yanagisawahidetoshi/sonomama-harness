import { mkdtemp, cp, mkdir, rm, realpath, readFile, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from './workspace.mjs';
import { execute } from './io.mjs';
import { runHarness } from './index.mjs';
const source = new URL('../../', import.meta.url).pathname;
// #197: the fixture inputs are copied, git-initialized and committed once per test process; each fixture is a copy of that template
// (working tree and .git), so it starts as the same clean repository without repeating the copy and the commit.
let template;
async function makeTemplate() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-fixture-template-')));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  const ignored = (await git(source, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--', 'apps', 'prototypes', 'packages'])).stdout
    .split('\n').filter(Boolean).map(path => join(source, path.replace(/\/$/, '')));
  // The repository's API contract is not a fixture input: a fixture starts without one, and a test that needs a contract writes its own.
  ignored.push(join(source, 'packages/api-schema/openapi.yaml'));
  for (const path of ['apps', 'prototypes', 'packages', 'docs', '.harness/config', '.harness/acceptance', '.harness/verification', '.harness/rules', '.harness/skills', '.harness/state/sample-sbi.json', 'tools/harness', 'AGENTS.md', 'package.json', 'pnpm-workspace.yaml', '.gitignore']) {
    await mkdir(join(root, path, '..'), { recursive: true });
    // Locally installed dependencies and build output are not fixture inputs; only the files Git would see are copied.
    await cp(join(source, path), join(root, path), { recursive: true, filter: src => !ignored.some(dir => src === dir || src.startsWith(`${dir}/`)) });
  }
  await mkdir(join(root, '.harness/runs'), { recursive: true });
  await git(root, ['init', '--template=', '--initial-branch=main']);
  // A detached auto gc can still be writing packs while the fixture is removed (ENOTEMPTY on .git/objects/pack).
  await git(root, ['config', 'gc.auto', '0']);
  await git(root, ['config', 'maintenance.auto', 'false']);
  await commitFixture(root);
  // One pack instead of a loose object per file keeps each copy small.
  await git(root, ['repack', '-a', '-d', '-q']);
  return root;
}
export async function fixture(fn) {
  template ??= makeTemplate();
  const from = await template;
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-risk-')));
  try {
    // The native cp is several times faster than fs.cp for the many small files of the template.
    const copied = await execute('cp', ['-pR', `${from}/.`, root]);
    if (!copied.ok) throw new Error(`fixture copy failed: ${copied.stderr || copied.error}`);
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5 }); }
}
export async function update(root, path, fn) {
  const value = JSON.parse(await readFile(join(root, path), 'utf8'));
  fn(value);
  await writeFile(join(root, path), JSON.stringify(value));
}
export const human = id => () => ({ id, kind: 'human', source: 'test-authenticated-adapter' });

export async function commitFixture(root) {
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--allow-empty', '-m', 'Fixture inputs']);
}
// The repository default provider is claude; fixtures use the fake agent unless a test chooses a provider.
export async function runFixture(options) {
  await commitFixture(options.root);
  return runHarness({ provider: 'fake', ...options });
}
// Prototype SBI with an independent acceptance script; promotion=true adopts it into apps/admin as a production SBI.
export async function prototype(root,{promotion=false,failing=false}={}) {
  const file=promotion?'apps/admin/visual.txt':'prototypes/web/visual.txt';
  await mkdir(join(root,'.harness/verification'),{recursive:true});
  await writeFile(join(root,'.harness/verification/visual.mjs'),'import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{join}from"node:path";assert.equal(readFileSync(join(process.argv[2],'+JSON.stringify(file)+'),"utf8"),"visual");console.log(JSON.stringify({acceptance:["VISUAL"]}));');
  // A static visual declares no risk of its own and stays at the default LEVEL 1; adopting it into Production asks for one review (#157).
  await update(root,'.harness/state/sample-sbi.json',s=>{s.title='Render a static visual';s.description='Use dummy text';s.allowedFiles=[file];s.risks=[];s.minimumRiskLevel=promotion?2:1;s.acceptanceCriteria=[{id:'VISUAL',description:'Expected text is present',verifier:'visual'}];if(promotion)s.promotion={source:'prototypes/web'};});
  const folder=promotion?'apps/admin':'prototypes/web';
  await writeFile(join(root,folder,'package.json'),JSON.stringify({private:true,scripts:{typecheck:'node -e "process.exit(0)"',lint:`node -e "process.exit(${failing?1:0})"`,'format:check':'node -e "process.exit(0)"',build:'node -e "process.exit(0)"'}}));
  await update(root,'.harness/config/harness.json',c=>{
    c.verifiers.push({id:'visual',trust:'acceptance',trustedScript:'.harness/verification/visual.mjs',directory:'.',planned:['independent visual assertion'],commands:[],acceptanceIds:['VISUAL'],appliesTo:['^never/']});
    if(promotion)Object.assign(c.verifiers.find(v=>v.id==='admin'),{setupCommands:[],commands:[['node','-e','process.exit(0)']]});
    // The fixture package has stub scripts only; the real verifier also installs dependencies (setup) and builds Storybook.
    c.verifiers.find(v=>v.id==='prototype-web').setupCommands=[];
    c.verifiers.find(v=>v.id==='prototype-web').commands=['typecheck','lint','format:check','build'].map(script=>['pnpm','run',script]);
  });
  return {file,agent:async()=>({files:[{path:file,content:'visual'}]})};
}
