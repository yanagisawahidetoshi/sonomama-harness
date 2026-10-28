import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const source=new URL('../../',import.meta.url).pathname;
// The scripts only read the worktree, so every input except harness.json is linked to the repository.
function run(script,edit=()=>{}) {
  const root=mkdtempSync(join(tmpdir(),'sonomama-acceptance-'));
  try {
    for(const name of readdirSync(source)) if(name!=='.harness') symlinkSync(join(source,name),join(root,name));
    mkdirSync(join(root,'.harness/config'),{recursive:true});
    for(const name of readdirSync(join(source,'.harness'))) if(name!=='config') symlinkSync(join(source,'.harness',name),join(root,'.harness',name));
    for(const name of readdirSync(join(source,'.harness/config'))) if(name!=='harness.json') symlinkSync(join(source,'.harness/config',name),join(root,'.harness/config',name));
    const config=JSON.parse(readFileSync(join(source,'.harness/config/harness.json'),'utf8'));
    edit(config);
    writeFileSync(join(root,'.harness/config/harness.json'),JSON.stringify(config));
    return spawnSync(process.execPath,[join(source,'.harness/verification',script),root],{encoding:'utf8'});
  } finally { rmSync(root,{recursive:true,force:true}); }
}
const without=(id,...scripts)=>config=>{
  const verifier=config.verifiers.find(v=>v.id===id);
  verifier.commands=verifier.commands.filter(c=>!(c[0]==='pnpm'&&c[1]==='run'&&scripts.includes(c[2])));
};
const cases=[
  ['admin-env.mjs','admin','ADMIN-AC-13',['check','test']],
  ['admin-arch.mjs','admin','ADMIN-ARCH-AC-21',['check','test']],
  ['mobile-env.mjs','expo','MOBILE-AC-15',['check','test']],
  ['mobile-arch.mjs','expo','MOBILE-ARCH-AC-19',['check','test']],
  ['prototype-web-env.mjs','prototype-web','PWEB-AC-7',['build']],
];

describe('Trusted Acceptance of registered Harness commands',()=>{
  for(const [script,id,ac,scripts] of cases) {
    for(const name of scripts) {
      it(`given ${id} keeps only look-alike commands when ${name} is removed then ${script} fails ${ac}`,()=>{
        const result=run(script,without(id,name));
        assert.notEqual(result.status,0,result.stderr);
        assert.doesNotMatch(result.stderr,new RegExp(`PASS ${ac}:`));
      });
    }
  }
  it('given the rails verifier without RuboCop when only a look-alike argument remains then api-env fails API-AC-16',()=>{
    const result=run('api-env.mjs',config=>{
      const rails=config.verifiers.find(v=>v.id==='rails');
      rails.commands=rails.commands.map(c=>c.includes('rubocop')?[...c.slice(0,-1),'rubocop-rspec']:c);
    });
    assert.notEqual(result.status,0,result.stderr);
    assert.doesNotMatch(result.stderr,/PASS API-AC-16:/);
  });
  for(const script of ['admin-env.mjs','admin-arch.mjs','mobile-env.mjs','mobile-arch.mjs','prototype-web-env.mjs','prototype-mobile-env.mjs','api-env.mjs']) {
    it(`given the current Harness config when ${script} runs then every scenario passes`,()=>{
      const result=run(script);
      assert.equal(result.status,0,result.stderr);
      assert.ok(JSON.parse(result.stdout).acceptance.length>0);
    });
  }
});
