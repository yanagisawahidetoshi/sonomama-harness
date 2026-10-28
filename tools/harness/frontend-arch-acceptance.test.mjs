import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
// Runs the Trusted Acceptance script on a copy of the worktree with extra source files under apps/<app>/src.
const acceptance=(app,files={})=>{
  const root=mkdtempSync(join(tmpdir(),`${app}-arch-acceptance-`));
  try{
    for(const path of [`apps/${app}`,'docs/architecture','.harness/config/harness.json']) cpSync(join(repo,path),join(root,path),{recursive:true,filter:p=>!['node_modules','dist'].includes(basename(p))});
    for(const [path,text] of Object.entries(files)){const file=join(root,`apps/${app}/src`,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}
    const run=spawnSync(process.execPath,[join(repo,`.harness/verification/${app}-arch.mjs`),root],{encoding:'utf8'});
    return {status:run.status,stderr:run.stderr};
  }finally{rmSync(root,{recursive:true,force:true});}
};
for(const [app,component] of [['admin','HomePage'],['mobile','HomeScreen']]){
  describe(`${app} Trusted Acceptance for the frontend layers`,()=>{
    describe('given the current source tree',()=>{
      it('when the acceptance runs then app / features / shared / providers pass',()=>{
        const run=acceptance(app);
        assert.equal(run.status,0,run.stderr);
      });
      it('when only a declaration file is added next to the layers then it still passes',()=>{
        const run=acceptance(app,{'assets.d.ts':'declare module "*.png";\n'});
        assert.equal(run.status,0,run.stderr);
      });
    });
    describe('given an unclassified top-level directory src/lib',()=>{
      it('when features/A reaches features/B through it with the alias then the acceptance fails',()=>{
        const run=acceptance(app,{'lib/bridge.ts':`export { ${component} } from '@/features/home';\n`,'features/other/index.ts':`export { ${component} } from '@/lib/bridge';\n`});
        assert.equal(run.status,1);
        assert.match(run.stderr,/features\/other\/index\.ts → @\/lib\/bridge/);
        assert.match(run.stderr,/lib\/bridge\.ts → @\/features\/home/);
      });
      it('when a feature imports it through a relative path then the acceptance fails',()=>{
        const run=acceptance(app,{'lib/format.ts':'export const format = String;\n','features/home/format.ts':"export { format } from '../../lib/format';\n"});
        assert.equal(run.status,1);
        assert.match(run.stderr,/features\/home\/format\.ts → \.\.\/\.\.\/lib\/format/);
      });
    });
    describe('given a declaration file outside the layers',()=>{
      it('when a feature imports it then the acceptance fails, so it cannot become a detour',()=>{
        const run=acceptance(app,{'assets.d.ts':'declare module "*.png";\n','features/home/assets.ts':"import '@/assets.d';\n"});
        assert.equal(run.status,1);
        assert.match(run.stderr,/features\/home\/assets\.ts → @\/assets\.d/);
      });
    });
  });
}
