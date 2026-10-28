import { mkdtemp, cp, mkdir, rm, realpath, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from './workspace.mjs';
import { runHarness } from './index.mjs';
const source = new URL('../../', import.meta.url).pathname;
export async function fixture(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sonomama-risk-')));
  const ignored = (await git(source, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--', 'apps', 'prototypes', 'packages'])).stdout
    .split('\n').filter(Boolean).map(path => join(source, path.replace(/\/$/, '')));
  try {
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
export async function runFixture(options) {
  await commitFixture(options.root);
  return runHarness(options);
}
// Prototype SBI with an independent acceptance script; promotion=true targets apps/admin and requires Design Approval.
export async function prototype(root,{promotion=false,failing=false}={}) {
  const file=promotion?'apps/admin/visual.txt':'prototypes/web/visual.txt';
  await mkdir(join(root,'.harness/verification'),{recursive:true});
  await writeFile(join(root,'.harness/verification/visual.mjs'),'import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{join}from"node:path";assert.equal(readFileSync(join(process.argv[2],'+JSON.stringify(file)+'),"utf8"),"visual");console.log(JSON.stringify({acceptance:["VISUAL"]}));');
  await update(root,'.harness/state/sample-sbi.json',s=>{s.title='Render a static visual';s.description='Use dummy text';s.allowedFiles=[file];s.risks=[];s.acceptanceCriteria=[{id:'VISUAL',description:'Expected text is present',verifier:'visual'}];if(promotion)s.promotion={source:'prototypes/web'};});
  const folder=promotion?'apps/admin':'prototypes/web';
  await writeFile(join(root,folder,'package.json'),JSON.stringify({private:true,scripts:{typecheck:'node -e "process.exit(0)"',lint:`node -e "process.exit(${failing?1:0})"`,'format:check':'node -e "process.exit(0)"',build:'node -e "process.exit(0)"'}}));
  await update(root,'.harness/config/harness.json',c=>{
    c.verifiers.push({id:'visual',trust:'acceptance',trustedScript:'.harness/verification/visual.mjs',directory:'.',planned:['independent visual assertion'],commands:[],acceptanceIds:['VISUAL'],appliesTo:['^never/']});
    if(promotion)c.verifiers.find(v=>v.id==='admin').commands=[[process.execPath,'-e','process.exit(0)']];
    // The fixture package has stub scripts only; the real verifier also installs dependencies and builds Storybook.
    c.verifiers.find(v=>v.id==='prototype-web').commands=['typecheck','lint','format:check','build'].map(script=>['pnpm','run',script]);
  });
  return {file,agent:async()=>({files:[{path:file,content:'visual'}]})};
}
