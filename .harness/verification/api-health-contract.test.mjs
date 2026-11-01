import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stringify} from 'yaml';
const source=new URL('../../',import.meta.url).pathname;
const script=join(source,'.harness/verification/api-health-contract.mjs');
// The contract SBI #232 asks for: GET /api/v1/health answers 200 application/json {"status":"ok"} with no security requirement.
const contract=()=>({
  openapi:'3.1.0',
  info:{title:'SONOMAMA API',version:'0.1.0'},
  paths:{'/api/v1/health':{get:{operationId:'getHealth',security:[],responses:{'200':{description:'OK',content:{'application/json':{schema:{$ref:'#/components/schemas/Health'}}}}}}}},
  components:{schemas:{Health:{type:'object',required:['status'],properties:{status:{type:'string',enum:['ok']}}}}},
});
function run(edit=()=>{},{file='openapi.yaml',extra=null}={}) {
  const root=mkdtempSync(join(tmpdir(),'sonomama-health-contract-'));
  try {
    mkdirSync(join(root,'packages/api-schema'),{recursive:true});
    const document=contract(); edit(document);
    writeFileSync(join(root,'packages/api-schema',file),file.endsWith('.json')?JSON.stringify(document):stringify(document));
    if(extra) writeFileSync(join(root,'packages/api-schema',extra),stringify(contract()));
    return spawnSync(process.execPath,[script,root],{encoding:'utf8'});
  } finally { rmSync(root,{recursive:true,force:true}); }
}
const passes=(result,ids)=>{ assert.equal(result.status,0,result.stderr); assert.deepEqual(JSON.parse(result.stdout).acceptance,ids); };
const fails=(result,ac)=>{ assert.notEqual(result.status,0,result.stdout); assert.doesNotMatch(result.stderr,new RegExp(`PASS ${ac}:`)); assert.equal(result.stdout,''); };
const health=d=>d.paths['/api/v1/health'].get;

describe('Trusted Acceptance of the health check contract (SBI #232)',()=>{
  it('given the contract the SBI asks for when the script runs then AC-1 to AC-4 pass',()=>passes(run(),['AC-1','AC-2','AC-3','AC-4']));
  it('given the contract written as openapi.json when the script runs then AC-1 to AC-4 pass',()=>passes(run(()=>{},{file:'openapi.json'}),['AC-1','AC-2','AC-3','AC-4']));
  it('given the schema inlined instead of a $ref when the script runs then AC-3 passes',()=>passes(run(d=>{health(d).responses['200'].content['application/json'].schema=contract().components.schemas.Health;}),['AC-1','AC-2','AC-3','AC-4']));
  describe('given a contract that is not valid OpenAPI 3.1',()=>{
    for(const [name,edit,options] of [
      ['no contract file',null,{file:'README.txt'}],
      ['two contract files',()=>{},{extra:'openapi.json'}],
      ['OpenAPI 3.0',d=>{d.openapi='3.0.3';}],
      ['no info.version',d=>{delete d.info.version;}],
      ['no info.title',d=>{d.info.title='';}],
      ['no paths',d=>{delete d.paths;}],
      ['an operation without responses',d=>{health(d).responses={};}],
      ['a $ref to a missing schema',d=>{delete d.components.schemas.Health;}],
      ['a $ref outside the document',d=>{health(d).responses['200'].content['application/json'].schema={$ref:'other.yaml#/Health'};}],
      ['a path that does not start with a slash',d=>{d.paths['api/v1/other']={get:{responses:{'200':{description:'OK'}}}};}],
    ]) it(`when it has ${name} then AC-1 fails`,()=>fails(run(edit??(()=>{}),options),'AC-1'));
  });
  describe('given a contract whose health endpoint differs from the SBI',()=>{
    for(const [name,edit,ac] of [
      ['no GET /api/v1/health',d=>{d.paths={'/api/v1/status':d.paths['/api/v1/health']};},'AC-2'],
      ['POST instead of GET',d=>{d.paths['/api/v1/health']={post:health(d)};},'AC-2'],
      ['no 200 response',d=>{const op=health(d);op.responses={'204':{description:'No Content'}};},'AC-2'],
      ['a 200 response of text/plain',d=>{const r=health(d).responses['200'];r.content={'text/plain':r.content['application/json']};},'AC-2'],
      ['a status that is not required',d=>{d.components.schemas.Health.required=[];},'AC-3'],
      ['a status that is a boolean',d=>{d.components.schemas.Health.properties.status={type:'boolean'};},'AC-3'],
      ['a status that allows other values',d=>{d.components.schemas.Health.properties.status.enum=['ok','degraded'];},'AC-3'],
      ['a status without an enum',d=>{delete d.components.schemas.Health.properties.status.enum;},'AC-3'],
      ['a body that is an array',d=>{d.components.schemas.Health={type:'array',items:{type:'string'}};},'AC-3'],
      ['no security on the operation',d=>{delete health(d).security;},'AC-4'],
      ['a security requirement on the operation',d=>{health(d).security=[{bearerAuth:[]}];},'AC-4'],
    ]) it(`when it has ${name} then ${ac} fails`,()=>fails(run(edit),ac));
  });
});
