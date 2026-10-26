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
    it('when light gates pass then permits review without production human approval or auto merge',()=>fixture(async root=>{
      const {agent}=await prototype(root);
      const run=await runFixture({root,quiet:true,agent});
      assert.equal(run.lane.name,'prototype'); assert.equal(run.gate.required,false);
      assert.equal(run.executionStatus,'DONE'); assert.equal(run.status,'MERGE_ALLOWED');
      assert.equal(run.risk.level,1);
      assert.ok(run.risk.reasons.includes('explicit_safe_prototype_only')); assert.equal(run.merge.requiredApprovals,0);assert.equal(run.merge.autoMergeEligible,false);
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
      assert.equal(run.status,'WAITING_FOR_DESIGN_APPROVAL');
      assert.deepEqual(run.gate,{required:false,state:'NOT_REQUIRED'});
      assert.equal(JSON.parse(await readFile(join(root,run.runDir,'human-gate.json'),'utf8')).state,'NOT_REQUIRED');
      await assert.rejects(recordDecision({root,runId:run.id,purpose:'merge',identityProvider:human('designer')}),/gate|Execution/);
      await recordDecision({root,runId:run.id,purpose:'design-approval',identityProvider:human('designer')});
      const done=await resumeRun({root,runId:run.id,quiet:true,agent});
      assert.equal(done.designApproval.state,'APPROVED');assert.equal(done.executionStatus,'DONE');
      assert.deepEqual(done.gate,{required:false,state:'NOT_REQUIRED'});
      assert.equal(JSON.parse(await readFile(join(root,run.runDir,'human-gate.json'),'utf8')).state,'NOT_REQUIRED');
      assert.equal(done.lane.name,'production');assert.equal(done.status,'WAITING_FOR_HUMAN_REVIEW');assert.equal(done.merge.validApprovals,0);
      await recordDecision({root,runId:run.id,purpose:'merge',identityProvider:human('reviewer')});
      assert.equal((await resumeRun({root,runId:run.id,quiet:true})).status,'MERGE_ALLOWED');
      await recordDecision({root,runId:run.id,purpose:'design-approval',decision:'REVOKE',identityProvider:human('designer')});
      const revoked=await resumeRun({root,runId:run.id,quiet:true});
      assert.equal(revoked.status,'WAITING_FOR_DESIGN_APPROVAL');
      assert.equal(revoked.merge.state,'WAITING_FOR_DESIGN_APPROVAL');
      assert.deepEqual(revoked.gate,{required:false,state:'NOT_REQUIRED'});
      assert.equal(revoked.designApproval.state,'WAITING_FOR_DESIGN_APPROVAL');
    }));
  });
});
