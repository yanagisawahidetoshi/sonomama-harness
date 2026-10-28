import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,commitFixture,runFixture} from './test-fixture.mjs';
import {prepareWorkspace,git,assertWritablePath} from './workspace.mjs';
import {isSecretPath,isSafeEnvTemplate} from './evidence-protection.mjs';

describe('Tracked environment templates',()=>{
  describe('given sample configuration containing no real credentials',()=>{
    for(const name of ['.env.example','.env.sample','.env.template','.env.development.example']) {
      it(`when ${name} contains placeholders then checks content and allows checkout`,()=>fixture(async root=>{
        const path=join(root,'apps/admin',name);
        const content='# Public configuration template\nPORT=3000\nAPI_URL=http://localhost:3000\nAPI_KEY=\nPASSWORD=""\nTOKEN=<your-token>\nACCESS_KEY=your_access_key_here\nUPLOAD_TOKEN=${UPLOAD_TOKEN}\nSECRET=replace-me\n';
        await writeFile(path,content);
        await git(root,['add','--force','--',`apps/admin/${name}`]);await commitFixture(root);
        const workspace=join(root,'.harness/runs/template/workspace');
        await prepareWorkspace(root,workspace);
        assert.equal(await readFile(join(workspace,'apps/admin',name),'utf8'),content);
        assert.equal(isSecretPath(`apps/admin/${name}`),true);
        assert.throws(()=>assertWritablePath(`apps/admin/${name}`));
      }));
    }
  });
    it('when Harness starts with a tracked template then redaction discovery preserves safe inputs',()=>fixture(async root=>{
      await writeFile(join(root,'apps/admin/.env.example'),'API_URL=http://localhost:3000\nAPI_KEY=your_api_key_here\n');
      await git(root,['add','--force','--','apps/admin/.env.example']);
      const run=await runFixture({root,quiet:true});
      assert.equal(run.executionStatus,'DONE');
      assert.equal(await readFile(join(root,run.runDir,'workspace/apps/admin/.env.example'),'utf8'),'API_URL=http://localhost:3000\nAPI_KEY=your_api_key_here\n');
    }));
  describe('given real credentials or a live environment filename',()=>{
    for(const [name,content] of [
      ['.env.example','API_KEY=ghp_'+'x'.repeat(36)],
      ['.env.sample','PASSWORD=actual-sensitive-value'],
      ['.env.example','TOKEN=<your-token> # API_KEY=actual-sensitive-value'],
      ['.env.template','DATABASE_URL=postgres://user:private-password@localhost/db'],
      ['.env.example','# ghp_'+'y'.repeat(36)],
      ['.env.example','API_KEY=your_ghp_'+'z'.repeat(36)+'_here'],
      ['.env.local','PORT=3000'],
      ['.env.example.local','PORT=3000'],
    ]) {
      it(`when ${name} is unsafe then refuses materialization without disclosing content`,()=>fixture(async root=>{
        await writeFile(join(root,'apps/admin',name),content);
        await git(root,['add','--force','--',`apps/admin/${name}`]);await commitFixture(root);
        const workspace=join(root,'.harness/runs/unsafe-template/workspace');
        await assert.rejects(prepareWorkspace(root,workspace),error=>/tracked credential/.test(error.message)&&!error.message.includes('actual-sensitive-value'));
        await assert.rejects(readFile(join(workspace,'.git')),/ENOENT/);
      }));
    }
  });
});

describe('Repository .gitignore for environment files',()=>{
  // --no-index evaluates the rules alone, independent of which files this checkout already tracks.
  const ignored=async(root,path)=>(await git(root,['check-ignore','--quiet','--no-index','--',path],true)).ok;
  describe('given live environment filenames',()=>{
    for(const path of ['.env','.env.local','apps/admin/.env','apps/admin/.env.production','apps/admin/.env.development.local','apps/admin/.env.example.local']) {
      it(`when checking ${path} then it stays ignored and Harness treats it as a secret`,()=>fixture(async root=>{
        assert.equal(await ignored(root,path),true);
        assert.equal(isSafeEnvTemplate(path,'PORT=3000\n'),false);
      }));
    }
  });
  describe('given a template inside a directory that is itself a secret path',()=>{
    for(const path of ['secrets/.env.example','apps/admin/.env.d/.env.example']) {
      it(`when checking ${path} then it stays ignored like Harness refuses it`,()=>fixture(async root=>{
        assert.equal(await ignored(root,path),true);
        assert.equal(isSafeEnvTemplate(path,'PORT=3000\n'),false);
      }));
    }
  });
  describe('given a template name Harness accepts',()=>{
    for(const path of ['.env.example','apps/admin/.env.example','apps/mobile/.env.sample','prototypes/web/.env.template','apps/admin/.env.development.example']) {
      it(`when adding ${path} without --force then Git tracks it`,()=>fixture(async root=>{
        assert.equal(isSafeEnvTemplate(path,'PORT=3000\n'),true);
        await mkdir(join(root,path,'..'),{recursive:true});
        await writeFile(join(root,path),'PORT=3000\n');
        await git(root,['add','--',path]);
        assert.equal((await git(root,['ls-files','--',path])).stdout.trim(),path);
      }));
    }
  });
  describe('given a template holding a real credential',()=>{
    it('when it is added without --force then Harness still refuses to materialize it',()=>fixture(async root=>{
      await writeFile(join(root,'apps/admin/.env.sample'),'API_KEY=ghp_'+'x'.repeat(36)+'\n');
      await git(root,['add','--','apps/admin/.env.sample']);await commitFixture(root);
      await assert.rejects(prepareWorkspace(root,join(root,'.harness/runs/unsafe-template/workspace')),/tracked credential/);
    }));
  });
});
