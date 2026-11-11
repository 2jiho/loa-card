import test from 'node:test';
import assert from 'node:assert/strict';
import {InputAcquisitionEvidence,parseInputAcquisitionSkip} from '../src/features/card-scanner/acquisition/input-acquisition-evidence';

const start=(seq:number,inputId=1,captureTime=2)=>({version:1,seq,atMs:seq,kind:'started',inputId,captureTime});
const finish=(seq:number,inputId=1,captureTime=2,outcome='completed')=>({version:1,seq,atMs:seq,kind:'finished',inputId,captureTime,outcome});
const link=(inputId=1,captureTime=2,phase='input')=>({inputId,frameId:10,captureTime,phase});
const skip=(inputId=1,captureTime=2,reason='not-ready')=>({version:1,inputId,captureTime,reason});
const evidence=()=>{const x=new InputAcquisitionEvidence();x.contract({version:1});return x;};

test('the versioned contract accepts linked and explicitly skipped attempts but does not certify skipped pixels',()=>{
 const x=evidence();x.decision(start(1));x.link(link());x.decision(finish(2));
 x.decision(start(3,2,3));x.skip(skip(2,3,'zero-dimensions'));x.decision(finish(4,2,3));
 assert.deepEqual(x.summary(),{supported:true,complete:true,started:2,linked:1,skipped:1,failed:0,unresolved:0,inFlight:false,pixelCoverage:'partial'});
});
test('a finished attempt without link or explicit skip stays unresolved even if its pipeline claims success',()=>{
 const x=evidence();x.decision(start(1));x.decision(finish(2));
 assert.deepEqual(x.summary(),{supported:true,complete:false,started:1,linked:0,skipped:0,failed:0,unresolved:1,inFlight:false,pixelCoverage:'unknown'});
});
test('a late, duplicate, wrong-ID or wrong-time link or skip cannot certify an attempt',()=>{
 for(const attempt of [
  (x:InputAcquisitionEvidence)=>x.link(link(2)),(x:InputAcquisitionEvidence)=>x.link(link(1,3)),
  (x:InputAcquisitionEvidence)=>x.skip(skip(2)),(x:InputAcquisitionEvidence)=>x.skip(skip(1,3)),
  (x:InputAcquisitionEvidence)=>{x.link(link());x.skip(skip());},
  (x:InputAcquisitionEvidence)=>{x.skip(skip());x.link(link());},
  (x:InputAcquisitionEvidence)=>{x.link(link());x.link(link());},
  (x:InputAcquisitionEvidence)=>{x.decision(finish(2));x.link(link());},
 ]){
  const x=evidence();x.decision(start(1));assert.throws(()=>attempt(x));assert.equal(x.summary().complete,false);
 }
});
test('error, in-flight work, duplicate starts and missing pipeline decisions never produce complete evidence',()=>{
 for(const afterLink of [false,true]){
  const x=evidence();x.decision(start(1));if(afterLink)x.link(link());x.decision(finish(2,1,2,'error'));
  assert.equal(x.summary().failed,1);assert.equal(x.summary().complete,false);
 }
 const pending=evidence();pending.decision(start(1));pending.link(link());assert.equal(pending.summary().complete,false);
 const duplicate=evidence();duplicate.decision(start(1));assert.throws(()=>duplicate.decision(start(2,2,3)));
 const missing=evidence();missing.decision(start(1));missing.link(link());assert.throws(()=>missing.decision(finish(3)),/순서/);
});
test('recovery links do not close or change the normal acquisition attempt',()=>{
 for(const phase of ['input','recovery']){
  const x=evidence();
  x.recovery({version:1,seq:1,kind:'retained',stamp:{inputId:999,captureTime:1,observedAtMs:1}});
  x.recovery({version:1,seq:2,kind:'started',inputId:999});x.link(link(999,1,phase));
  assert.equal(x.summary().linked,0);
  x.recovery({version:1,seq:3,kind:'finished',inputId:999,outcome:'completed'});
  x.recovery({version:1,seq:4,kind:'released',inputId:999,reason:'processed',failed:false});
  x.decision(start(1));x.link(link());x.decision(finish(2));assert.equal(x.summary().complete,true);
 }
});
test('recovery and normal starts cannot overlap, and an unexpected recovery link cannot satisfy a normal attempt',()=>{
 const x=evidence();x.decision(start(1));
 x.recovery({version:1,seq:1,kind:'retained',stamp:{inputId:999,captureTime:1,observedAtMs:1}});
 assert.throws(()=>x.recovery({version:1,seq:2,kind:'started',inputId:999}),/충돌/);
 const y=evidence();y.decision(start(1));assert.throws(()=>y.link(link(1,2,'recovery')),/연결/);
 const orphan=evidence();assert.throws(()=>orphan.link(link()),/연결/);
 const orphanSkip=evidence();assert.throws(()=>orphanSkip.skip(skip()),/연결/);
 const missingFirst=evidence();assert.throws(()=>missingFirst.decision(start(2)),/순서/);
});
test('legacy without contract remains unsupported; a late or duplicate contract is rejected',()=>{
 const old=new InputAcquisitionEvidence();old.decision(start(1));old.link(link());old.decision(finish(2));
 assert.equal(old.summary().supported,false);assert.equal(old.summary().complete,null);
 assert.throws(()=>old.contract({version:1}),/계약/);
 const duplicate=evidence();assert.throws(()=>duplicate.contract({version:1}),/계약/);
 const empty=evidence();assert.equal(empty.summary().complete,false,'a declaration alone proves no attempts');
});
test('skip parser rejects unknown reasons, invalid IDs, mutable prototypes and extra fields',()=>{
 for(const value of [skip(0),skip(1,-1),skip(1,2,'other'),{...skip(),extra:1},Object.create({version:1})])
  assert.throws(()=>parseInputAcquisitionSkip(value));
 assert.ok(Object.isFrozen(parseInputAcquisitionSkip(skip())));
});
