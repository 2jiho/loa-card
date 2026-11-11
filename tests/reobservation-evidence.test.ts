import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateReobservationSweep,type ReobservedRead,type ReobservedSource} from '../src/features/card-scanner/session/reobservation-evidence';
const source=(frame:string,time:number,slot=0):ReobservedSource=>({sessionId:'s',accountEpoch:'account',sortEpoch:'sort',physicalFrame:frame,
 observationId:`${frame}-${slot}`,slot,captureTime:time,captureOrder:time*100});
const barrier=source('f1',1);
const read=(frame:string,time:number,id='a',mode:'single'|'repeat-candidate'='single'):ReobservedRead=>({source:source(frame,time),
 directName:{id,verified:true},fields:{awakening:2,copies:4,evidence:mode,verified:true},usable:true});
// The resolver is synthetic. It demonstrates a contract, not physical provenance.
const verifier={verifyBarrier:(value:unknown)=>value as ReobservedSource,verifyRead:(value:unknown)=>value as ReobservedRead};
const check=(x:ReobservedRead,y?:ReobservedRead)=>evaluateReobservationSweep(barrier,['a'],[{id:'a',primary:x,...(y?{corroboration:y}:{})}],verifier);
test('without an independent verifier evidence cannot be completed',()=>{
 assert.equal(evaluateReobservationSweep(barrier,['a'],[{id:'a',primary:read('f2',2)}]).status,'unresolved');
 assert.equal(check(read('f2',2)).status,'conditional');
});
test('old, same physical frame, wrong session or unverified epochs are rejected',()=>{
 for(const s of [source('f1',2),source('f2',1),{...source('f2',2),captureOrder:100},
  {...source('f2',2),sessionId:'other'},{...source('f2',2),accountEpoch:'other'},
  {...source('f2',2),sortEpoch:'other'},{...source('f2',2),physicalFrame:''}]){
  assert.equal(check({...read('f2',2),source:s}).status,'unresolved');
 }
});
test('direct verified identity and jointly valid single-observation values are required',()=>{
 const good=read('f2',2);
 for(const candidate of [{...good,directName:{id:'a',verified:false}},{...good,directName:{id:'b',verified:true}},
  {...good,usable:false},{...good,fields:{...good.fields,verified:false}},
  {...good,fields:{...good.fields,awakening:4,copies:10}},{...good,fields:{...good.fields,awakening:6}},
  {...good,fields:{...good.fields,copies:-1}}])assert.equal(check(candidate).status,'unresolved');
});
test('repeated fields require two later distinct physical frames and equal full values',()=>{
 const first=read('f2',2,'a','repeat-candidate');
 assert.equal(check(first).status,'unresolved');assert.equal(check(first,read('f3',3,'a','repeat-candidate')).status,'conditional');
 assert.equal(check(first,read('f2',3)).status,'unresolved');assert.equal(check(first,read('f3',2)).status,'unresolved');
 assert.equal(check(first,{...read('f3',3),fields:{...read('f3',3).fields,copies:5}}).status,'unresolved');
});
test('one physical slot cannot establish different card IDs and missing cards cannot be inferred',()=>{
 const a=read('f2',2),b=read('f2',2,'b');
 assert.equal(evaluateReobservationSweep(barrier,['a','b'],[{id:'a',primary:a},{id:'b',primary:b}],verifier).status,'unresolved');
 assert.equal(evaluateReobservationSweep(barrier,['a','b'],[{id:'a',primary:a}],verifier).status,'unresolved');
 assert.equal(evaluateReobservationSweep(barrier,['a','a'],[{id:'a',primary:a},{id:'a',primary:a}],verifier).status,'unresolved');
});
