import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeInputAdmission} from '../scripts/analyze-input-admission.mjs';

const stamp=(inputId:number,observedAtMs:number)=>({inputId,observedAtMs,captureTime:observedAtMs/1000});
const consider=(id:number,at:number,expected:string)=>({kind:'consider',stamp:stamp(id,at),
  gates:{capturing:true,checkingCompletion:false},expected});
const frozen=(id:number,at:number,succeeded=true)=>({kind:'frozen',stamp:stamp(id,at),succeeded,freezeMs:1});
const trace=(facts:object[])=>({complete:true,dropped:0,events:facts.map((value,i)=>({seq:i+1,type:'input-admission',value}))});

test('admission analysis distinguishes near-period callbacks from successful frozen inputs',()=>{
  const r=analyzeInputAdmission(trace([consider(1,0,'freeze'),frozen(1,0),consider(2,20,'cadence'),
    consider(3,32,'cadence'),consider(4,34,'freeze'),frozen(4,34,false)]));
  assert.equal(r.status,'measured');assert.equal(r.considered,4);
  assert.equal(r.successfulFreezes,1);assert.equal(r.failedFreezes,1);
  assert.deepEqual(r.reasons,{freeze:2,cadence:2});
  assert.deepEqual(r.cadenceSpacing,{samples:2,p50Ms:20,p95Ms:32,below25Ms:1,from25To33Ms:1,atLeast33Ms:0});
});
test('missing, partial and unsettled admission facts do not claim full measurement',()=>{
  assert.equal(analyzeInputAdmission(trace([])).considered,null);
  assert.equal(analyzeInputAdmission(trace([])).status,'unmeasured');
  assert.equal(analyzeInputAdmission(trace([consider(1,0,'freeze')])).status,'partial');
  assert.equal(analyzeInputAdmission({...trace([consider(1,0,'freeze'),frozen(1,0)]),dropped:1}).status,'partial');
});
test('admission analysis rejects incompatible decisions and invalid ordering',()=>{
  assert.throws(()=>analyzeInputAdmission(trace([consider(1,0,'cadence')])),/differs/);
  const t=trace([consider(1,0,'freeze')]);
  assert.throws(()=>analyzeInputAdmission({...t,events:[t.events[0],t.events[0]]}),/ordered/);
});
