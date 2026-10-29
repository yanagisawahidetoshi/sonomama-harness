import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, update, commitFixture, runFixture } from './test-fixture.mjs';
import { assertWritablePath, prepareWorkspace, git, workspaceIntegrity } from './workspace.mjs';
import { verify, checksPassed } from './verifier.mjs';
import { judge, runHarness, resumeRun, cleanupRun } from './index.mjs';
import { classifyLane } from './lanes.mjs';
import { check } from './check.mjs';
import { runVerifier } from './impact.mjs';
const good = 'export function greet(name) { return `こんにちは、${name?.trim() || "ゲスト"}さん`; }';
const sbiPath = '.harness/state/sample-sbi.json';

describe('Application and trusted acceptance boundary', () => {
  describe('given tests explicitly included in SBI scope', () => {
    for (const path of ['apps/api/spec/widget_spec.rb', 'apps/mobile/src/Widget.test.tsx', 'apps/admin/src/Widget.test.tsx', 'packages/ui/Widget.spec.tsx', 'prototypes/web/Widget.test.tsx']) {
      it(`when writing ${path} then permits the application test`, () => assert.doesNotThrow(() => assertWritablePath(path)));
    }
    for (const path of ['.harness/verification/acceptance.test.mjs', 'tools/harness/verifier.mjs', 'AGENTS.md', '.git/config', '.githooks/pre-push', '.github/workflows/harness.yml', '.ai/coding-rules.md', 'acceptance.test.mjs']) {
      it(`when writing ${path} then refuses the trusted namespace`, () => assert.throws(() => assertWritablePath(path)));
    }
    it('when only application tests pass then refuses DONE even with claimed acceptance', () => {
      const result = { verification: { status: 'PASS', acceptance: ['X'], checks: [{id:'app',status:'PASS',required:true,trust:'application'}] }, review:{status:'PASS'}, security:{status:'PASS'}, gateApproved:true, securityVerification:{status:'PASS',violations:[],requiredVerifiers:['secret-scan'],checks:[{id:'secret-scan',status:'PASS',required:true}]} };
      assert.equal(judge(result,{acceptanceCriteria:[{id:'X',verifier:'app'}]}),false);
    });
    it('when an allowed application test is repaired then trusted verification still decides completion', () => fixture(async root => {
      await update(root,sbiPath,s=>s.allowedFiles.push('apps/admin/widget.test.mjs'));
      await writeFile(join(root,'apps/admin/package.json'),'{"private":true}');
      await update(root,'.harness/config/harness.json',c=>c.verifiers.find(v=>v.id==='admin').commands=[['node','-e','process.exit(0)']]);
      const run=await runFixture({root,quiet:true,agent:async()=>({files:[{path:'greeting.mjs',content:good},{path:'apps/admin/widget.test.mjs',content:'// Given widget; When render; Then visible'}]})});
      assert.equal(run.executionStatus,'DONE');
      assert.equal(run.iterations[0].verification.checks.find(c=>c.id==='sample-bdd').trust,'acceptance');
    }));
  });
  describe('given a trusted acceptance script importing the shared helper in .harness/verification/lib',()=>{
    it('when the run verifies its isolated workspace then the helper loads and the acceptance passes',()=>fixture(async root=>{
      await writeFile(join(root,'.harness/verification/uses-lib.mjs'),'import assert from "node:assert/strict"; import { hasCommand } from "./lib/commands.mjs"; assert.ok(hasCommand([["pnpm","run","check"]],["pnpm","run","check"])); console.log(JSON.stringify({acceptance:["LIB-1"]}));');
      await update(root,'.harness/config/harness.json',c=>c.verifiers.push({id:'uses-lib',trust:'acceptance',trustedScript:'.harness/verification/uses-lib.mjs',directory:'.',planned:['shared helper'],commands:[],acceptanceIds:['LIB-1'],appliesTo:['^never/']}));
      await update(root,sbiPath,s=>s.acceptanceCriteria.push({id:'LIB-1',description:'Shared helper is importable',verifier:'uses-lib'}));
      const run=await runFixture({root,quiet:true,agent:async()=>({files:[{path:'greeting.mjs',content:good}]})});
      const check=run.iterations[0].verification.checks.find(c=>c.id==='uses-lib');
      assert.equal(check.status,'PASS',check.process?.stderr);
      assert.ok(run.iterations[0].verification.acceptance.includes('LIB-1'));
    }));
  });
});

describe('Verifier applicability', () => {
  describe('given separate API, mobile and admin verifiers', () => {
    for (const [path,id] of [['apps/api/file.rb','rails'],['apps/mobile/file.tsx','expo'],['apps/admin/file.tsx','admin']]) {
      it(`when ${path} changes then selects ${id} and skips unrelated verifiers`, () => fixture(async root => {
        const {config,sbi}=await check(root);
        const result=await verify({root,workspace:root,config,sbi:{...sbi,acceptanceCriteria:[]},files:[{path}]});
        assert.equal(result.checks.find(c=>c.id===id).status,'FAIL');
        assert.ok(result.checks.filter(c=>c.id!==id).every(c=>c.status==='SKIP' && c.required===false));
        assert.ok(result.checks.find(c=>c.id===id).selectionReasons.includes('changed-path'));
      }));
    }
    it('when only a shared root file changes then a missing app is skipped as a placeholder', () => fixture(async root => {
      const {config,sbi}=await check(root);
      const ids=['rails','expo','prototype-web','prototype-mobile'];
      // Make every app ungenerated regardless of which apps this repository has already created.
      for (const id of ids) { const v=config.verifiers.find(x=>x.id===id); await rm(join(root,v.directory,v.marker),{force:true}); }
      const result=await verify({root,workspace:root,config,sbi:{...sbi,acceptanceCriteria:[]},files:[{path:'pnpm-lock.yaml'}]});
      for (const id of ids) {
        const rails=result.checks.find(c=>c.id===id);
        assert.equal(rails.status,'SKIP'); assert.equal(rails.required,false); assert.equal(rails.reason,'missing app (placeholder)');
      }
    }));
    it('when a file inside a missing app directory changes then the missing app fails', () => fixture(async root => {
      const {config,sbi}=await check(root);
      const result=await verify({root,workspace:root,config,sbi,files:[{path:'apps/api/config/routes.rb'},{path:'pnpm-lock.yaml'}]});
      assert.equal(result.checks.find(c=>c.id==='rails').status,'FAIL');
    }));
    it('when an explicit required check is outside changed paths then missing app fails', () => fixture(async root => {
      const {config,sbi}=await check(root);
      const result=await verify({root,workspace:root,config,sbi:{...sbi,requiredVerifiers:['rails']},files:[{path:'docs/product/a.md'}]});
      assert.equal(result.checks.find(c=>c.id==='rails').status,'FAIL');
    }));
    it('when Security mandates a general verifier then path mismatch cannot skip it', () => fixture(async root => {
      const {config,sbi}=await check(root);
      const result=await verify({root,workspace:root,config,sbi,files:[],requiredVerifiers:['admin']});
      assert.equal(result.checks.find(c=>c.id==='admin').status,'FAIL');
    }));
    it('when an AC requires an out-of-scope verifier then runs its protected assertion', () => fixture(async root => {
      const {config,sbi}=await check(root);
      await writeFile(join(root,'greeting.mjs'),good);
      const result=await verify({root,workspace:root,config,sbi,files:[]});
      assert.equal(result.checks.find(c=>c.id==='sample-bdd').status,'PASS');
      assert.ok(result.checks.find(c=>c.id==='sample-bdd').selectionReasons.includes('acceptance'));
    }));
    it('when an unknown required verifier is named then fails closed', () => fixture(async root => {
      const {config,sbi}=await check(root);
      const result=await verify({root,workspace:root,config,sbi:{...sbi,requiredVerifiers:['unknown']},files:[]});
      assert.equal(result.checks.find(c=>c.id==='unknown').status,'NOT_CONFIGURED');
      assert.equal(result.status,'FAIL');
    }));
    it('when full verification runs then executes existing configured apps regardless of path', () => fixture(async root => {
      const {config,sbi}=await check(root);
      await writeFile(join(root,'apps/admin/package.json'),'{}');
      config.verifiers.find(v=>v.id==='admin').commands=[['node','-e','process.exit(0)']];
      const result=await verify({root,workspace:root,config,sbi:{...sbi,acceptanceCriteria:[]},files:[],full:true});
      assert.equal(result.checks.find(c=>c.id==='admin').status,'PASS');
    }));
    it('when a required check is skipped then never treats it as successful',()=>assert.equal(checksPassed([{status:'SKIP',required:true,reason:'not applicable to this change'}]),false));
  });
});

describe('Commands gated on dependency and native config changes', () => {
  // expo-doctor compares against the latest Expo release, so it runs only when this change can move dependencies or native config.
  const gated = async (root, id = 'expo') => {
    const {config,sbi}=await check(root);
    const v=config.verifiers.find(x=>x.id===id);
    const doctor=['node','-e','process.exit(1)'];
    v.commands=[['node','-e','process.exit(0)'],doctor];
    v.gatedCommands[0].command=doctor;
    return {config,sbi:{...sbi,acceptanceCriteria:[]},doctor:doctor.join(' ')};
  };
  const expoCheck = result => result.checks.find(c=>c.id==='expo');
  describe('given the expo verifier with expo-doctor gated', () => {
    it('when only apps/mobile source changes then runs the other commands and records expo-doctor as skipped with a reason', () => fixture(async root => {
      const {config,sbi,doctor}=await gated(root);
      const result=await verify({root,workspace:root,config,sbi,files:[{path:'apps/mobile/src/app/index.tsx'}]});
      assert.equal(expoCheck(result).status,'PASS');
      assert.equal(expoCheck(result).processes.length,1);
      assert.deepEqual(expoCheck(result).skippedCommands.map(c=>c.command),[doctor]);
      assert.match(expoCheck(result).skippedCommands[0].reason,/dependency or native config/);
    }));
    for (const path of ['apps/mobile/package.json','apps/mobile/eas.json','.node-version']) {
      it(`when ${path} changes then runs expo-doctor and its failure fails the verifier`, () => fixture(async root => {
        const {config,sbi}=await gated(root);
        const result=await verify({root,workspace:root,config,sbi,files:[{path}]});
        assert.equal(expoCheck(result).status,'FAIL');
        assert.equal(expoCheck(result).processes.length,2);
        assert.deepEqual(expoCheck(result).skippedCommands,[]);
      }));
    }
    it('when full verification runs without a matching change then still skips expo-doctor', () => fixture(async root => {
      const {config,sbi}=await gated(root);
      const result=await verify({root,workspace:root,config,sbi,files:[],full:true});
      assert.equal(expoCheck(result).status,'PASS');
      assert.equal(expoCheck(result).skippedCommands.length,1);
    }));
    it('when Impact Analysis marks expo mandatory for a mobile area then still skips expo-doctor without a matching change', () => fixture(async root => {
      const {config,sbi}=await gated(root);
      const result=await verify({root,workspace:root,config,sbi,files:[{path:'apps/mobile/src/app/index.tsx'}],only:new Set(['expo']),selected:new Map([['expo',true]])});
      assert.equal(expoCheck(result).status,'PASS');
      assert.equal(expoCheck(result).skippedCommands.length,1);
    }));
    it('when only the root pnpm-lock.yaml changes then skips expo-doctor because another importer may own the update', () => fixture(async root => {
      const {config,sbi}=await gated(root);
      const result=await verify({root,workspace:root,config,sbi,files:[{path:'pnpm-lock.yaml'}]});
      assert.equal(expoCheck(result).status,'PASS');
      assert.equal(expoCheck(result).skippedCommands.length,1);
    }));
    it('when the SBI requires expo then still skips expo-doctor without a matching change', () => fixture(async root => {
      const {config,sbi}=await gated(root);
      const result=await verify({root,workspace:root,config,sbi:{...sbi,requiredVerifiers:['expo']},files:[{path:'apps/mobile/src/app/index.tsx'}]});
      assert.equal(expoCheck(result).status,'PASS');
      assert.equal(expoCheck(result).skippedCommands.length,1);
    }));
    it('when Security requires expo then still skips expo-doctor without a matching change', () => fixture(async root => {
      const {config,sbi}=await gated(root);
      const result=await verify({root,workspace:root,config,sbi,files:[{path:'apps/mobile/src/app/index.tsx'}],requiredVerifiers:['expo']});
      assert.equal(expoCheck(result).status,'PASS');
      assert.equal(expoCheck(result).skippedCommands.length,1);
    }));
    it('when an acceptance criterion needs expo then still skips expo-doctor without a matching change', () => fixture(async root => {
      const {config,sbi}=await gated(root);
      const result=await verify({root,workspace:root,config,sbi,files:[{path:'apps/mobile/src/app/index.tsx'}],only:new Set(['expo']),selected:new Map([['expo',true]]),requiredVerifiers:['expo']});
      assert.equal(expoCheck(result).status,'PASS');
      assert.equal(expoCheck(result).skippedCommands.length,1);
    }));
    it('when the SBI requires expo and package.json changes then runs expo-doctor', () => fixture(async root => {
      const {config,sbi}=await gated(root);
      const result=await verify({root,workspace:root,config,sbi:{...sbi,requiredVerifiers:['expo']},files:[{path:'apps/mobile/package.json'}]});
      assert.equal(expoCheck(result).status,'FAIL');
      assert.deepEqual(expoCheck(result).skippedCommands,[]);
    }));
  });
  describe('given the prototype-mobile verifier with expo-doctor gated', () => {
    it('when prototypes/mobile/metro.config.js changes then runs expo-doctor', () => fixture(async root => {
      const {config,sbi}=await gated(root,'prototype-mobile');
      const result=await verify({root,workspace:root,config,sbi,files:[{path:'prototypes/mobile/metro.config.js'}]});
      assert.equal(result.checks.find(c=>c.id==='prototype-mobile').status,'FAIL');
    }));
    it('when only prototypes/mobile source changes then skips expo-doctor', () => fixture(async root => {
      const {config,sbi}=await gated(root,'prototype-mobile');
      const result=await verify({root,workspace:root,config,sbi,files:[{path:'prototypes/mobile/src/app/index.tsx'}]});
      assert.equal(result.checks.find(c=>c.id==='prototype-mobile').status,'PASS');
    }));
  });
  describe('given the CI matrix job', () => {
    const branch = async (root, sbiFields) => {
      await update(root,'.harness/config/harness.json',c=>{
        const v=c.verifiers.find(x=>x.id==='expo');
        const doctor=['node','-e','process.exit(1)'];
        v.commands=[['node','-e','process.exit(0)'],doctor];
        v.gatedCommands[0].command=doctor;
      });
      await commitFixture(root);
      const sbi=JSON.parse(await readFile(join(root,sbiPath),'utf8'));
      await writeFile(join(root,'.harness/state/sbi-mobile-x.json'),JSON.stringify({...sbi,id:'SBI-MOBILE-X',...sbiFields}));
      await mkdir(join(root,'apps/mobile/src/app'),{recursive:true});
      await writeFile(join(root,'apps/mobile/src/app/extra.ts'),'export {};\n');
      await commitFixture(root);
    };
    it('when a mobile SBI changes only source then the expo job skips expo-doctor', () => fixture(async root => {
      await branch(root,{affectedAreas:['mobile']});
      const {result,passed}=await runVerifier({root,base:'HEAD~1',id:'expo'});
      assert.equal(passed,true);
      assert.equal(result.checks[0].skippedCommands.length,1);
    }));
    it('when the SBI lists expo in requiredVerifiers but changes only source then the expo job skips expo-doctor', () => fixture(async root => {
      await branch(root,{requiredVerifiers:['expo']});
      const {result,passed}=await runVerifier({root,base:'HEAD~1',id:'expo'});
      assert.equal(passed,true);
      assert.equal(result.checks[0].skippedCommands.length,1);
    }));
  });
});

describe('Git worktree execution', () => {
  describe('given a clean source repository', () => {
    it('when running then retains original baseline identity, config files and root contents',()=>fixture(async root=>{
      await writeFile(join(root,'.ruby-version'),'3.4.0\n');
      await writeFile(join(root,'.npmrc'),'save-exact=true\n');
      const run=await runFixture({root,quiet:true});
      const workspace=join(root,run.runDir,'workspace');
      assert.equal(run.baselineSha,(await git(root,['rev-parse','HEAD'])).stdout.trim());
      assert.equal((await git(root,['merge-base',run.baselineSha,run.headSha])).stdout.trim(),run.baselineSha);
      assert.equal((await git(workspace,['rev-parse','--path-format=absolute','--git-common-dir'])).stdout.trim(),join(root,'.git'));
      assert.equal(await readFile(join(workspace,'.npmrc'),'utf8'),'save-exact=true\n');
      assert.equal(await readFile(join(workspace,'.ruby-version'),'utf8'),'3.4.0\n');
      assert.equal((await git(root,['status','--porcelain'])).stdout,'');
      await assert.rejects(readFile(join(root,'greeting.mjs')),/ENOENT/);
      assert.equal((await git(root,['rev-parse',`refs/harness/runs/${run.id}`])).stdout.trim(),run.headSha);
      const evidence=await readFile(join(root,run.runDir,'summary.json'),'utf8');
      await cleanupRun({root,runId:run.id});
      await assert.rejects(readFile(join(workspace,'.git')),/ENOENT/);
      assert.ok(evidence.length);
      assert.equal((await git(root,['rev-parse',`refs/harness/runs/${run.id}`])).stdout.trim(),run.headSha);
      assert.equal((await resumeRun({root,runId:run.id,quiet:true})).status,'ESCALATED');
    }));
    it('when source contains uncommitted input then refuses to run',()=>fixture(async root=>{
      await writeFile(join(root,'uncommitted.txt'),'change');
      await assert.rejects(runHarness({root,quiet:true}),/clean|dirty|uncommitted/i);
    }));
    it('when tracked source contains a credential then refuses checkout',()=>fixture(async root=>{
      await writeFile(join(root,'credential.txt'),'ghp_'+'x'.repeat(36));
      await commitFixture(root);
      await assert.rejects(prepareWorkspace(root,join(root,'.harness/runs/secret/workspace'),{}),/tracked.*credential/i);
    }));
    it('when workspace is dirty then refuses cleanup and keeps changes',()=>fixture(async root=>{
      const run=await runFixture({root,quiet:true});
      await writeFile(join(root,run.runDir,'workspace/greeting.mjs'),'keep me');
      await assert.rejects(cleanupRun({root,runId:run.id}),/snapshot|HEAD|changed/);
      assert.equal(await readFile(join(root,run.runDir,'workspace/greeting.mjs'),'utf8'),'keep me');
    }));
    it('when trusted verifier source changes then invalidates prior execution',()=>fixture(async root=>{
      const run=await runFixture({root,quiet:true});
      await writeFile(join(root,'tools/harness/sample-bdd.mjs'),'// changed');
      assert.equal((await resumeRun({root,runId:run.id,quiet:true})).status,'ESCALATED');
    }));
  });
});

describe('Prototype and production lanes',()=>{
  describe('given path based lane rules',()=>{
    for (const path of ['prototypes/web/View.tsx','prototypes/mobile/View.tsx']) {
      it(`when ${path} changes then selects light prototype gates`,()=>{
        const lane=classifyLane([{path}],{});
        assert.equal(lane.name,'prototype');
        assert.deepEqual(lane.qualityGates,['typecheck','lint','format','build','secret-scan']);
        assert.equal(lane.requiresDesignApproval,false);
      });
    }
    for (const path of ['apps/admin/View.tsx','apps/mobile/View.tsx','apps/api/file.rb','packages/ui/View.tsx','packages/api-schema/schema.yml']) {
      it(`when ${path} joins a prototype change then production takes priority`,()=>assert.equal(classifyLane([{path:'prototypes/web/View.tsx'},{path}],{}).name,'production'));
    }
    for (const text of ['AuthN','AuthZ','PII','Secret','Production API','Cognito User Pool','本番データ','security-sensitive config']) {
      it(`when prototype declares ${text} then escalates to production security`,()=>{
        const lane=classifyLane([{path:'prototypes/web/View.tsx',added:text}],{});
        assert.equal(lane.name,'production'); assert.equal(lane.requiresSecurityGate,true);
      });
    }
    it('when promoting a prototype then requires separate production SBI and Design Approval',()=>{
      const lane=classifyLane([{path:'apps/admin/View.tsx'}],{promotion:{source:'prototypes/web',designApproval:null}});
      assert.equal(lane.requiresDesignApproval,true);
      assert.equal(lane.designApproved,false);
    });
  });
});
