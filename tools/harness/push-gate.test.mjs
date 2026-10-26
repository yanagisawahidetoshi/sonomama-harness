import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const root=new URL('../../',import.meta.url).pathname;
describe('Versioned pre-push quality gate',()=>{
  describe('given a failing check or test',()=>{
    for(const fail of ['harness:check','harness:test','none']) {
      it(`when ${fail} fails then push gate returns the correct exit status`,async()=>{
        const temp=await mkdtemp(join(tmpdir(),'harness-hook-'));
        try {
          await writeFile(join(temp,'pnpm'),`#!/bin/sh\necho "$1" >> "$GATE_LOG"\n[ "$1" != "$GATE_FAIL" ]\n`);
          await chmod(join(temp,'pnpm'),0o755);
          let failed=false;
          try { await exec('sh',[join(root,'.githooks/pre-push')],{cwd:root,env:{...process.env,PATH:`${temp}:${process.env.PATH}`,GATE_LOG:join(temp,'log'),GATE_FAIL:fail}}); } catch { failed=true; }
          assert.equal(failed,fail!=='none');
          assert.equal(await readFile(join(temp,'log'),'utf8'),fail==='harness:check'?'harness:check\n':'harness:check\nharness:test\n');
        } finally { await rm(temp,{recursive:true,force:true}); }
      });
    }
  });
});
