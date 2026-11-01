import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,update,runFixture,human,prototype} from './test-fixture.mjs';
import {resumeRun} from './index.mjs';
import {recordDecision} from './human-approvals.mjs';
const state='.harness/state/sample-sbi.json';
describe('Lane quality and promotion enforcement',()=>{
  describe('given a dummy-data prototype with independent acceptance checks',()=>{
    // #220: this run comes from --sbi PATH, a local self-test, so it is never auto merge eligible; the prototype rule itself is in risk-policy.test.mjs.
    it('when light gates pass then needs no human approval, while the --sbi run is not auto merge eligible',()=>fixture(async root=>{
      const {agent}=await prototype(root);
      const run=await runFixture({root,quiet:true,agent});
      assert.equal(run.lane.name,'prototype'); assert.equal(run.gate.required,false);
      assert.equal(run.executionStatus,'DONE'); assert.equal(run.status,'MERGE_ALLOWED');
      assert.equal(run.risk.level,1);
      assert.ok(run.risk.reasons.includes('default_low')); assert.equal(run.merge.requiredApprovals,0);assert.equal(run.merge.autoMergeEligible,false);
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
    // #175: the approved SBI already names Production API, so the run is promoted to the Production lane and Security level 3, not stopped.
    it('when an approved prototype SBI touches Production API then runs in the Production lane at level 3 without an implementation gate',()=>fixture(async root=>{
      const {agent}=await prototype(root);await update(root,state,s=>s.description='Connect Production API');
      let called=false;
      const run=await runFixture({root,quiet:true,agent:async()=>{called=true;return agent();}});
      assert.equal(run.lane.name,'production');assert.equal(run.gate.required,false);assert.equal(called,true);
      assert.equal(run.riskPreflight.level,3);assert.equal(run.events.some(e=>e.status==='WAITING_FOR_HUMAN_GATE'),false);
    }));
    // #155: the SBI Issue approval already decides the production implementation, so a promotion adds no Design Approval Gate.
    it('when promoting a prototype then the run implements without a Design Approval and only merge approval remains',()=>fixture(async root=>{
      const {agent}=await prototype(root,{promotion:true});
      const run=await runFixture({root,quiet:true,agent});
      assert.equal(run.executionStatus,'DONE');assert.equal(run.designApproval,undefined);
      assert.notEqual(run.status,'WAITING_FOR_DESIGN_APPROVAL');
      assert.deepEqual(run.gate,{required:false,state:'NOT_REQUIRED'});
      assert.equal(run.lane.name,'production');assert.equal(run.status,'WAITING_FOR_HUMAN_REVIEW');
      assert.equal(await readFile(join(root,run.runDir,'design-approval.json'),'utf8').catch(()=>null),null);
      await recordDecision({root,runId:run.id,purpose:'merge',identityProvider:human('reviewer')});
      assert.equal((await resumeRun({root,runId:run.id,quiet:true})).status,'MERGE_ALLOWED');
    }));
    it('when a Design Approval is recorded then it is rejected as an unknown purpose',()=>fixture(async root=>{
      const {agent}=await prototype(root,{promotion:true});
      const run=await runFixture({root,quiet:true,agent});
      await assert.rejects(recordDecision({root,runId:run.id,purpose:'design-approval',identityProvider:human('designer')}),/purpose|Invalid/);
    }));
  });
});
