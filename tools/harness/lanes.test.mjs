import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,update,runFixture,human} from './test-fixture.mjs';
import {resumeRun} from './index.mjs';
import {recordDecision} from './human-approvals.mjs';
const state='.harness/state/sample-sbi.json';
async function prototype(root,{promotion=false,failing=false}={}) {
  const file=promotion?'apps/admin/visual.txt':'prototypes/web/visual.txt';
  await mkdir(join(root,'.harness/verification'),{recursive:true});
  await writeFile(join(root,'.harness/verification/visual.mjs'),'import assert from "node:assert/strict";import{readFileSync}from"node:fs";import{join}from"node:path";assert.equal(readFileSync(join(process.argv[2],'+JSON.stringify(file)+'),"utf8"),"visual");console.log(JSON.stringify({acceptance:["VISUAL"]}));');
  await update(root,state,s=>{s.title='Render a static visual';s.description='Use dummy text';s.allowedFiles=[file];s.risks=[];s.acceptanceCriteria=[{id:'VISUAL',description:'Expected text is present',verifier:'visual'}];if(promotion)s.promotion={source:'prototypes/web'};});
  const folder=promotion?'apps/admin':'prototypes/web';
  await writeFile(join(root,folder,'package.json'),JSON.stringify({private:true,scripts:{typecheck:'node -e "process.exit(0)"',lint:`node -e "process.exit(${failing?1:0})"`,'format:check':'node -e "process.exit(0)"',build:'node -e "process.exit(0)"'}}));
  await update(root,'.harness/config/harness.json',c=>{
    c.verifiers.push({id:'visual',trust:'acceptance',trustedScript:'.harness/verification/visual.mjs',directory:'.',planned:['independent visual assertion'],commands:[],acceptanceIds:['VISUAL'],appliesTo:['^never/']});
    if(promotion)c.verifiers.find(v=>v.id==='admin').commands=[[process.execPath,'-e','process.exit(0)']];
  });
  return {file,agent:async()=>({files:[{path:file,content:'visual'}]})};
}
describe('Lane quality and promotion enforcement',()=>{
  describe('given a dummy-data prototype with independent acceptance checks',()=>{
    it('when light gates pass then permits review without production human approval or auto merge',()=>fixture(async root=>{
      const {agent}=await prototype(root);
      const run=await runFixture({root,quiet:true,agent});
      assert.equal(run.lane.name,'prototype'); assert.equal(run.gate.required,false);
      assert.equal(run.executionStatus,'DONE'); assert.equal(run.status,'MERGE_ALLOWED');
      assert.equal(run.risk.level,2); assert.equal(run.merge.requiredApprovals,0);assert.equal(run.merge.autoMergeEligible,false);
      const check=run.iterations[0].verification.checks.find(c=>c.id==='prototype-web');
      assert.equal(check.processes.length,4);assert.equal(check.status,'PASS');
      assert.ok(run.iterations[0].securityVerification.requiredVerifiers.includes('secret-scan'));
    }));
    it('when lint fails then refuses completion',()=>fixture(async root=>{
      const {agent}=await prototype(root,{failing:true});
      const run=await runFixture({root,quiet:true,agent});
      assert.equal(run.status,'ESCALATED');assert.notEqual(run.executionStatus,'DONE');
      assert.equal(run.iterations[0].verification.checks.find(c=>c.id==='prototype-web').status,'FAIL');
    }));
    it('when a prototype touches Production API then stops for Security before calling agent',()=>fixture(async root=>{
      await prototype(root);await update(root,state,s=>s.description='Connect Production API');
      const run=await runFixture({root,quiet:true,agent:async()=>{throw Error('must not run')}});
      assert.equal(run.lane.name,'production');assert.equal(run.gate.required,true);assert.equal(run.status,'WAITING_FOR_HUMAN_GATE');assert.equal(run.iterations.length,0);
    }));
    it('when promoting then Design Approval is independent from post-implementation merge approval',()=>fixture(async root=>{
      const {agent}=await prototype(root,{promotion:true});
      const run=await runFixture({root,quiet:true,agent});
      assert.equal(run.executionStatus,'PENDING');assert.equal(run.designApproval.required,true);
      await assert.rejects(recordDecision({root,runId:run.id,purpose:'merge',identityProvider:human('designer')}),/gate|Execution/);
      await recordDecision({root,runId:run.id,purpose:'design-approval',identityProvider:human('designer')});
      const done=await resumeRun({root,runId:run.id,quiet:true,agent});
      assert.equal(done.designApproval.state,'APPROVED');assert.equal(done.executionStatus,'DONE');
      assert.equal(done.lane.name,'production');assert.equal(done.status,'WAITING_FOR_HUMAN_REVIEW');assert.equal(done.merge.validApprovals,0);
    }));
  });
});
