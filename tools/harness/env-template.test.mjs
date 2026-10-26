import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,commitFixture} from './test-fixture.mjs';
import {prepareWorkspace,git,assertWritablePath} from './workspace.mjs';
import {isSecretPath} from './evidence-protection.mjs';

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
  describe('given real credentials or a live environment filename',()=>{
    for(const [name,content] of [
      ['.env.example','API_KEY=ghp_'+'x'.repeat(36)],
      ['.env.sample','PASSWORD=actual-sensitive-value'],
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
