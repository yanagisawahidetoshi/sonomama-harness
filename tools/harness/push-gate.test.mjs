import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commitFixture, fixture } from './test-fixture.mjs';
import { git } from './workspace.mjs';
import { planPushGate, runPushGate } from './push-gate.mjs';
const exec=promisify(execFile);
const root=new URL('../../',import.meta.url).pathname;
// git hands the pushed refs to pre-push on stdin; the hook must read them before anything else consumes stdin.
const hook=(env,input='')=>{ const run=exec('sh',[join(root,'.githooks/pre-push')],{cwd:root,env}); run.child.stdin.end(input); return run; };
const zero='0'.repeat(40), sha=c=>c.repeat(40);
describe('Versioned pre-push quality gate',()=>{
  describe('given a failing check or test',()=>{
    for(const fail of ['harness:check','harness:push-gate','none']) {
      it(`when ${fail} fails then push gate returns the correct exit status`,async()=>{
        const temp=await mkdtemp(join(tmpdir(),'harness-hook-'));
        try {
          await writeFile(join(temp,'pnpm'),`#!/bin/sh\necho "$1" >> "$GATE_LOG"\n[ "$1" != "$GATE_FAIL" ]\n`);
          await chmod(join(temp,'pnpm'),0o755);
          let failed=false;
          try { await hook({...process.env,PATH:`${temp}:${process.env.PATH}`,GATE_LOG:join(temp,'log'),GATE_FAIL:fail}); } catch { failed=true; }
          assert.equal(failed,fail!=='none');
          assert.equal(await readFile(join(temp,'log'),'utf8'),fail==='harness:check'?'harness:check\n':'harness:check\nharness:push-gate\n');
        } finally { await rm(temp,{recursive:true,force:true}); }
      });
    }
  });
  describe('given git exported GIT_DIR of the pushing worktree to the hook',()=>{
    it('when the gate runs tests then git fixtures do not inherit the repository location',async()=>{
      const temp=await mkdtemp(join(tmpdir(),'harness-hook-'));
      try {
        await writeFile(join(temp,'pnpm'),`#!/bin/sh\necho "${'$'}{GIT_DIR-unset} ${'$'}{GIT_WORK_TREE-unset} ${'$'}{GIT_INDEX_FILE-unset}" >> "$GATE_LOG"\n`);
        await chmod(join(temp,'pnpm'),0o755);
        await hook({...process.env,PATH:`${temp}:${process.env.PATH}`,GATE_LOG:join(temp,'log'),GIT_DIR:join(root,'.git'),GIT_WORK_TREE:root,GIT_INDEX_FILE:join(root,'.git/index')});
        assert.equal(await readFile(join(temp,'log'),'utf8'),'unset unset unset\nunset unset unset\n');
      } finally { await rm(temp,{recursive:true,force:true}); }
    });
  });
  describe('given the refs git hands to pre-push',()=>{
    it('when the hook runs then passes the refs from stdin to the Harness push gate',async()=>{
      const temp=await mkdtemp(join(tmpdir(),'harness-hook-'));
      try {
        await writeFile(join(temp,'pnpm'),`#!/bin/sh\necho "$1 ${'$'}{HARNESS_PUSH_REFS-unset}" >> "$GATE_LOG"\n`);
        await chmod(join(temp,'pnpm'),0o755);
        const refs=`refs/heads/x ${sha('a')} refs/heads/x ${sha('b')}`;
        await hook({...process.env,PATH:`${temp}:${process.env.PATH}`,GATE_LOG:join(temp,'log')},`${refs}\n`);
        assert.equal(await readFile(join(temp,'log'),'utf8'),`harness:check unset\nharness:push-gate ${refs}\n`);
      } finally { await rm(temp,{recursive:true,force:true}); }
    });
    it('when an outer push gate exported its refs then the hook passes only the refs of this push',async()=>{
      const temp=await mkdtemp(join(tmpdir(),'harness-hook-'));
      try {
        await writeFile(join(temp,'pnpm'),`#!/bin/sh\necho "$1 ${'$'}{HARNESS_PUSH_REFS-unset}" >> "$GATE_LOG"\n`);
        await chmod(join(temp,'pnpm'),0o755);
        const refs=`refs/heads/x ${sha('a')} refs/heads/x ${sha('b')}`;
        await hook({...process.env,PATH:`${temp}:${process.env.PATH}`,GATE_LOG:join(temp,'log'),HARNESS_PUSH_REFS:`refs/heads/outer ${sha('c')} refs/heads/outer ${zero}`},`${refs}\n`);
        assert.equal(await readFile(join(temp,'log'),'utf8'),`harness:check unset\nharness:push-gate ${refs}\n`);
      } finally { await rm(temp,{recursive:true,force:true}); }
    });
    it('when reading the hook then it names no verifier, because Impact Analysis in the Harness decides them',async()=>{
      const text=await readFile(join(root,'.githooks/pre-push'),'utf8');
      const config=JSON.parse(await readFile(join(root,'.harness/config/harness.json'),'utf8'));
      for (const {id} of config.verifiers) assert.doesNotMatch(text,new RegExp(`\\b${id}\\b`),id);
      assert.doesNotMatch(text,/harness:(test|verify)|no-verify/);
    });
  });
});

describe('Push gate planning',()=>{
  const head=sha('a');
  describe('given a single branch push of HEAD',()=>{
    it('when the remote branch exists then analyses the impact against the remote commit',()=>{
      assert.deepEqual(planPushGate({refs:`refs/heads/x ${head} refs/heads/x ${sha('b')}\n`,head,fallbackBase:'origin/main'}),{mode:'impact',base:sha('b'),reasons:['remote:refs/heads/x']});
    });
    it('when the branch is new then analyses the impact against the default branch',()=>{
      assert.deepEqual(planPushGate({refs:`refs/heads/x ${head} refs/heads/x ${zero}\n`,head,fallbackBase:'origin/main'}),{mode:'impact',base:'origin/main',reasons:['new-branch:origin/main']});
    });
  });
  describe('given a push the gate cannot scope safely',()=>{
    for (const [name,refs,fallbackBase,reason] of [
      ['no ref is given','',  'origin/main','push refs unknown'],
      ['several refs are pushed',`refs/heads/x ${head} refs/heads/x ${sha('b')}\nrefs/heads/y ${head} refs/heads/y ${sha('c')}\n`,'origin/main','several refs pushed'],
      ['the pushed commit is not HEAD',`refs/heads/x ${sha('d')} refs/heads/x ${sha('b')}\n`,'origin/main','pushed commit is not HEAD'],
      ['a new branch has no default branch to compare with',`refs/heads/x ${head} refs/heads/x ${zero}\n`,null,'no base for a new branch'],
      ['a line is malformed','refs/heads/x\n','origin/main','push refs unknown'],
    ]) {
      it(`when ${name} then runs the Full Gate`,()=>{
        assert.deepEqual(planPushGate({refs,head,fallbackBase}),{mode:'full',reasons:[reason]});
      });
    }
  });
  describe('given only a branch deletion',()=>{
    it('when nothing new is pushed then runs no verifier beyond harness:check',()=>{
      assert.deepEqual(planPushGate({refs:`(delete) ${zero} refs/heads/x ${sha('b')}\n`,head,fallbackBase:'origin/main'}),{mode:'skip',reasons:['delete only']});
    });
  });
});

describe('Push gate execution',()=>{
  const branch=async (root,paths)=>{
    const base=(await git(root,['rev-parse','HEAD'])).stdout.trim();
    await git(root,['switch','-c','feature']);
    for (const path of paths) { await mkdir(join(root,path,'..'),{recursive:true}); await writeFile(join(root,path),'export const changed = true;\n'); }
    await commitFixture(root);
    const head=(await git(root,['rev-parse','HEAD'])).stdout.trim();
    return `refs/heads/feature ${head} refs/heads/feature ${base}\n`;
  };
  const gate=async (root,refs,results={})=>{
    const verified=[]; let full=0;
    const result=await runPushGate({root,refs,runFull:async()=>{ full++; return true; },verifyOne:async id=>{ verified.push(id); return results[id] ?? true; }});
    return {...result,verified,full};
  };
  describe('given a change in one application area',()=>{
    for (const [area,path,expected] of [['Admin','apps/admin/src/main.ts',['admin']],['Mobile','apps/mobile/src/app/index.tsx',['expo']],['Rails','apps/api/app/models/lesson.rb',['rails']]]) {
      it(`when only ${area} changes then runs only the verifiers Impact Analysis selects, not the full Harness test`,()=>fixture(async root=>{
        const result=await gate(root,await branch(root,[path]));
        assert.equal(result.mode,'impact');
        assert.deepEqual(result.verified,expected);
        assert.equal(result.full,0);
        assert.equal(result.passed,true);
      }));
    }
    it('when a required verifier fails then stops the push',()=>fixture(async root=>{
      const result=await gate(root,await branch(root,['apps/admin/src/main.ts']),{admin:false});
      assert.equal(result.passed,false);
    }));
  });
  describe('given a change that Impact Analysis sends to the Full Gate',()=>{
    for (const path of ['tools/harness/verifier.mjs','.harness/config/lanes.json','.github/workflows/harness.yml','.githooks/pre-push']) {
      it(`when ${path} changes then runs the full Harness test`,()=>fixture(async root=>{
        const result=await gate(root,await branch(root,[path]));
        assert.equal(result.mode,'full');
        assert.deepEqual(result.reasons,[`diff:${path}`]);
        assert.equal(result.full,1);
      }));
    }
    it('when only .node-version changes then runs the full Harness test for the toolchain',()=>fixture(async root=>{
      const result=await gate(root,await branch(root,['.node-version']));
      assert.equal(result.mode,'full');
      assert.deepEqual(result.reasons,['toolchain:.node-version']);
      assert.equal(result.full,1);
    }));
    it('when the full Harness test fails then stops the push',()=>fixture(async root=>{
      const refs=await branch(root,['tools/harness/verifier.mjs']);
      const result=await runPushGate({root,refs,runFull:async()=>false,verifyOne:async()=>true});
      assert.equal(result.passed,false);
    }));
  });
  describe('given a remote commit this clone does not have',()=>{
    it('when the impact cannot be computed then runs the Full Gate',()=>fixture(async root=>{
      await branch(root,['apps/admin/src/main.ts']);
      const head=(await git(root,['rev-parse','HEAD'])).stdout.trim();
      const result=await gate(root,`refs/heads/feature ${head} refs/heads/feature ${sha('e')}\n`);
      assert.equal(result.mode,'full');
      assert.deepEqual(result.reasons,['remote commit unknown locally']);
      assert.equal(result.full,1);
    }));
  });
  describe('given only documentation changes',()=>{
    it('when no verifier is required then passes after harness:check alone',()=>fixture(async root=>{
      const result=await gate(root,await branch(root,['docs/architecture/notes.md']));
      assert.equal(result.mode,'impact');
      assert.deepEqual(result.verified,[]);
      assert.equal(result.full,0);
      assert.equal(result.passed,true);
    }));
  });
});
