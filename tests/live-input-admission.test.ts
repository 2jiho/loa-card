import test from 'node:test';
import assert from 'node:assert/strict';
import {applyLiveInputAdmissionFact,createLiveInputAdmission,hashLiveInputAdmission,parseLiveInputAdmissionFact} from '../src/features/card-scanner/live-input-admission';
import type {InputStamp,LiveInputAdmissionFact,LiveInputGates} from '../src/features/card-scanner/live-input-admission';

const open={capturing:true,checkingCompletion:false};

test('recorded offer-floor experiment admits short gaps without bypassing cost or explicit throttling',()=>{
  for(const [floor,cost,min,at,expected] of [[0,0,0,20,'freeze'],[16,0,0,15,'cadence'],
    [0,10,0,20,'cadence'],[0,0,80,20,'cadence'],[33,0,0,20,'cadence']] as const){
    const policy=createLiveInputAdmission(),gates={...open,offerFloorMs:floor,minIntervalMs:min};
    const first=policy.stamp(0,0);policy.consider(first,gates);policy.frozen(first,{succeeded:true,freezeMs:cost});
    const fact=parseLiveInputAdmissionFact({kind:'consider',stamp:policy.stamp(.02,at),gates,expected});
    const result=applyLiveInputAdmissionFact(policy,fact)!;
    assert.equal(result.kind,expected==='freeze'?'freeze':'skip');
  }
  for(const offerFloorMs of [-1,34,NaN,null,'0'])assert.throws(()=>parseLiveInputAdmissionFact({
    kind:'consider',stamp:{inputId:1,captureTime:0,observedAtMs:0},gates:{...open,offerFloorMs}}),/offer floor/);
});

test('arrival identity precedes decisions and successful freezing alone advances cadence',()=>{
  const admission=createLiveInputAdmission();
  const ended=admission.consider(admission.stamp(9,100),{capturing:false,checkingCompletion:true});
  assert.equal(ended.kind,'skip');if(ended.kind==='skip')assert.equal(ended.reason,'ended');
  const verification=admission.consider(admission.stamp(8,101),{capturing:true,checkingCompletion:true});
  assert.equal(verification.kind,'skip');if(verification.kind==='skip')assert.equal(verification.reason,'verification');
  const failed=admission.stamp(7,102);assert.equal(failed.inputId,3);
  assert.equal(admission.consider(failed,open).kind,'freeze');
  assert.equal(admission.snapshot().lastOfferedAtMs,null);
  admission.frozen(failed,{succeeded:false,freezeMs:300});
  assert.equal(admission.snapshot().offered,0);assert.equal(admission.snapshot().meanFreezeMs,0);
  const accepted=admission.stamp(6,103);assert.equal(admission.consider(accepted,open).kind,'freeze');
  admission.frozen(accepted,{succeeded:true,freezeMs:2});
  assert.equal(admission.snapshot().lastOfferedAtMs,103);assert.equal(admission.snapshot().offered,1);
  const before=admission.consider(admission.stamp(5,135),open);assert.equal(before.kind,'skip');
  if(before.kind==='skip')assert.equal(before.reason,'cadence');
  const exact=admission.consider(admission.stamp(4,136),open);assert.equal(exact.kind,'freeze');
  assert.equal(exact.stamp.captureTime,4,'native source time is never replaced by arrival order or wall time');
  assert.equal(exact.stamp.inputId,6);
});

test('offer interval preserves the 33ms lower, mean-freeze-times-four, and 250ms upper bounds',()=>{
  for(const [freezeMs,interval] of [[0,33],[20,80],[100,250]]){
    const admission=createLiveInputAdmission(),first=admission.stamp(0,0);
    admission.consider(first,open);admission.frozen(first,{succeeded:true,freezeMs});
    const skipped=admission.consider(admission.stamp(.1,interval-.01),open);assert.equal(skipped.kind,'skip');
    const accepted=admission.stamp(.2,interval);assert.equal(admission.consider(accepted,open).kind,'freeze');
    admission.frozen(accepted,{succeeded:true,freezeMs:0});
    assert.equal(admission.snapshot().meanFreezeMs,freezeMs/2,'mean uses successful freezes only');
  }
});

test('acquisition timing delegates to the existing cadence without an extra post-completion delay',()=>{
  const admission=createLiveInputAdmission();admission.completed(0,20);
  assert.equal(admission.snapshot().acquisitionMs,20);
  assert.equal(admission.consider(admission.stamp(1,19),open).kind,'skip');
  const atEnd=admission.stamp(2,20);assert.equal(admission.consider(atEnd,open).kind,'freeze');
  admission.frozen(atEnd,{succeeded:false,freezeMs:0});
  admission.completed(30,1030);assert.equal(admission.snapshot().acquisitionMs,314);
  assert.equal(admission.consider(admission.stamp(3,1029),open).kind,'skip');
  assert.equal(admission.consider(admission.stamp(4,1030),open).kind,'freeze');
});

test('recorded boundary facts reproduce every decision and the final policy hash',async()=>{
  const original=createLiveInputAdmission(),facts:LiveInputAdmissionFact[]=[],choices:unknown[]=[];
  const apply=(fact:LiveInputAdmissionFact)=>{facts.push(structuredClone(fact));const result=applyLiveInputAdmissionFact(original,fact);if(result)choices.push(result);};
  const skipped=original.stamp(5,0);apply({kind:'consider',stamp:skipped,gates:{...open,checkingCompletion:true},expected:'verification'});
  const first=original.stamp(5.1,10);apply({kind:'consider',stamp:first,gates:open,expected:'freeze'});
  apply({kind:'frozen',stamp:first,succeeded:true,freezeMs:10});
  apply({kind:'completed',startedAtMs:10,endedAtMs:100});
  apply({kind:'consider',stamp:original.stamp(5.2,99),gates:open,expected:'cadence'});
  const failed=original.stamp(5.3,100);apply({kind:'consider',stamp:failed,gates:open,expected:'freeze'});
  apply({kind:'frozen',stamp:failed,succeeded:false,freezeMs:20});
  const next=original.stamp(5.4,101);apply({kind:'consider',stamp:next,gates:open,expected:'freeze'});
  apply({kind:'frozen',stamp:next,succeeded:true,freezeMs:20});
  const replay=createLiveInputAdmission(),replayed=JSON.parse(JSON.stringify(facts)).map((fact:unknown)=>applyLiveInputAdmissionFact(replay,fact)).filter(Boolean);
  assert.deepEqual(replayed,choices);assert.deepEqual(replay.snapshot(),original.snapshot());
  assert.equal(await hashLiveInputAdmission(replay.snapshot()),await hashLiveInputAdmission(original.snapshot()));
  const changed={kind:'consider',stamp:{inputId:1,captureTime:0,observedAtMs:0},gates:open,expected:'cadence'};
  assert.throws(()=>applyLiveInputAdmissionFact(createLiveInputAdmission(),changed),/differs from the recorded choice/);
});

test('policy state stays bounded and snapshots do not alias mutable caller metadata',()=>{
  const admission=createLiveInputAdmission();
  for(let i=0;i<5000;i++)admission.consider(admission.stamp(i,i),{capturing:false,checkingCompletion:false});
  assert.equal(admission.snapshot().nextInputId,5000);
  assert.ok(JSON.stringify(admission.snapshot()).length<300);
  const input:InputStamp={inputId:5001,captureTime:2,observedAtMs:5001};
  const decision=admission.consider(input,open),snapshot=admission.snapshot();
  assert.equal(Object.isFrozen(decision.stamp),true);assert.equal(Object.isFrozen(snapshot),true);
  assert.notEqual(decision.stamp,input);assert.equal(snapshot.pending?.captureTime,2);
  admission.frozen(input,{succeeded:true,freezeMs:2});assert.notEqual(snapshot,admission.snapshot());assert.notEqual(snapshot.pending,null);
});

test('invalid and out-of-order facts fail rather than coercing timestamps or assigning freshness',()=>{
  const admission=createLiveInputAdmission();
  for(const time of [-1,Infinity,NaN])assert.throws(()=>admission.stamp(time,0),/times/);
  assert.equal(admission.snapshot().nextInputId,0);
  const first=admission.stamp(3,0);admission.consider(first,open);
  assert.throws(()=>admission.consider(admission.stamp(4,1),open),/settle/);
  assert.throws(()=>admission.frozen({...first,captureTime:9},{succeeded:true,freezeMs:1}),/does not match/);
  admission.frozen(first,{succeeded:false,freezeMs:1});
  assert.throws(()=>admission.consider(first,open),/increasing/);
  assert.throws(()=>admission.completed(10,9),/precedes/);
  const valid={kind:'consider',stamp:{inputId:1,captureTime:1,observedAtMs:1},gates:open,expected:'freeze'};
  for(const invalid of [null,[],{},Object.create(valid),{...valid,stamp:Object.create(valid.stamp)},
    {...valid,gates:Object.create(open)}, {...valid,pixels:[]},{...valid,expected:'other'},
    {...valid,stamp:{...valid.stamp,frame:{}}},{...valid,gates:{...open,other:true}},
    {...valid,stamp:{...valid.stamp,inputId:0}},{...valid,stamp:{...valid.stamp,captureTime:'1'}},
    {kind:'frozen',stamp:valid.stamp,succeeded:1,freezeMs:0},
    {kind:'completed',startedAtMs:2,endedAtMs:1},
  ])assert.throws(()=>parseLiveInputAdmissionFact(invalid));
});

test('optional source coordinates survive recorded facts without changing arrival time or admission policy',async()=>{
  const withSource=createLiveInputAdmission(),withoutSource=createLiveInputAdmission(),replay=createLiveInputAdmission();
  const metadata={mediaTime:4.5,presentedFrames:135,frameTimestampUs:9_500_000};
  const stamp=withSource.stamp(.2,200,metadata),ordinary=withoutSource.stamp(.2,200);
  metadata.mediaTime=10;
  assert.equal(stamp.captureTime,.2);assert.equal(stamp.source?.mediaTime,4.5);
  assert.equal(Object.isFrozen(stamp.source),true);
  const fact:LiveInputAdmissionFact={kind:'consider',stamp,gates:open,expected:'freeze'};
  const parsed=parseLiveInputAdmissionFact(JSON.parse(JSON.stringify(fact)));
  assert.equal(parsed.kind,'consider');if(parsed.kind!=='consider')return;
  assert.deepEqual(parsed.stamp,stamp);assert.notEqual(parsed.stamp.source,stamp.source);
  assert.equal(withSource.consider(stamp,open).kind,withoutSource.consider(ordinary,open).kind);
  applyLiveInputAdmissionFact(replay,parsed);
  assert.throws(()=>withSource.frozen({...stamp,source:{...stamp.source,mediaTime:6}},{succeeded:true,freezeMs:2}),/does not match/);
  const frozen:LiveInputAdmissionFact={kind:'frozen',stamp,succeeded:true,freezeMs:2};
  withSource.frozen(stamp,frozen);withoutSource.frozen(ordinary,frozen);applyLiveInputAdmissionFact(replay,JSON.parse(JSON.stringify(frozen)));
  assert.deepEqual(replay.snapshot(),withSource.snapshot());
  assert.equal(await hashLiveInputAdmission(replay.snapshot()),await hashLiveInputAdmission(withoutSource.snapshot()),
    'settled policy hash is independent of optional source diagnostics');
  assert.throws(()=>parseLiveInputAdmissionFact({...fact,stamp:{...stamp,source:{mediaTime:4.5,pixels:[]}}}));
});

test('omitted minimum interval preserves legacy wire facts and zero preserves the same policy state/hash',async()=>{
  const fact:LiveInputAdmissionFact={kind:'consider',stamp:{inputId:1,captureTime:2,observedAtMs:0},gates:open,expected:'freeze'};
  const parsed=parseLiveInputAdmissionFact(fact);assert.equal(parsed.kind,'consider');if(parsed.kind!=='consider')return;
  assert.equal(Object.hasOwn(parsed.gates,'minIntervalMs'),false);
  assert.equal(JSON.stringify(parsed),JSON.stringify(fact),'legacy serialization gains no optional default key');
  const withUndefined=parseLiveInputAdmissionFact({...fact,gates:{...open,minIntervalMs:undefined}});
  assert.deepEqual(withUndefined,parsed);assert.equal(JSON.stringify(withUndefined),JSON.stringify(fact));
  const legacy=createLiveInputAdmission(),zero=createLiveInputAdmission();
  for(const [index,at]of [0,79,80,123,124,156,157].entries()){
    const before=legacy.consider(legacy.stamp(10-index,at),open);
    const after=zero.consider(zero.stamp(10-index,at),{...open,minIntervalMs:0});
    assert.deepEqual(after,before);
    if(before.kind==='freeze'){
      const freezeMs=at===0?20:at===80?2:0;
      legacy.frozen(before.stamp,{succeeded:true,freezeMs});zero.frozen(after.stamp,{succeeded:true,freezeMs});
    }
  }
  assert.deepEqual(zero.snapshot(),legacy.snapshot());
  assert.equal(await hashLiveInputAdmission(zero.snapshot()),await hashLiveInputAdmission(legacy.snapshot()));
});

test('minimum interval only raises dynamic spacing and preserves fractional millisecond boundaries',()=>{
  for(const [freezeMs,minIntervalMs,interval]of [[20,0,80],[20,33,80],[100,80,250],[0,166.667,166.667],[0,250,250],[100,1000,1000]]){
    const policy=createLiveInputAdmission(),first=policy.stamp(9,0),gates={...open,minIntervalMs};
    assert.equal(policy.consider(first,gates).kind,'freeze');policy.frozen(first,{succeeded:true,freezeMs});
    const tooSoon=policy.consider(policy.stamp(8,interval-.001),gates);
    assert.equal(tooSoon.kind,'skip');if(tooSoon.kind==='skip')assert.equal(tooSoon.reason,'cadence');
    const atBoundary=policy.stamp(7,interval),accepted=policy.consider(atBoundary,gates);
    assert.equal(accepted.kind,'freeze');assert.equal(accepted.stamp.captureTime,7);
    policy.frozen(atBoundary,{succeeded:true,freezeMs:0});
    assert.equal(Object.hasOwn(policy.snapshot(),'minIntervalMs'),false,'the per-arrival gate is not hidden persistent state');
  }
  const policy=createLiveInputAdmission(),first=policy.stamp(4,0);
  policy.consider(first,{...open,minIntervalMs:1000});policy.frozen(first,{succeeded:true,freezeMs:0});
  assert.equal(policy.consider(policy.stamp(3,33),open).kind,'freeze','removing the gate restores the existing interval');
});

test('custom spacing cannot bypass acquisition completion, ended or verification gates',()=>{
  const policy=createLiveInputAdmission(),gates={...open,minIntervalMs:250},first=policy.stamp(5,0);
  policy.consider(first,gates);policy.frozen(first,{succeeded:true,freezeMs:0});policy.completed(10,300);
  const busy=policy.consider(policy.stamp(4,250),gates);assert.equal(busy.kind,'skip');
  if(busy.kind==='skip')assert.equal(busy.reason,'cadence');
  const ready=policy.stamp(3,300);assert.equal(policy.consider(ready,gates).kind,'freeze');policy.frozen(ready,{succeeded:true,freezeMs:0});
  const ended=policy.consider(policy.stamp(2,301),{capturing:false,checkingCompletion:true,minIntervalMs:1000});
  assert.equal(ended.kind,'skip');if(ended.kind==='skip')assert.equal(ended.reason,'ended');
  const verification=policy.consider(policy.stamp(1,302),{...open,checkingCompletion:true,minIntervalMs:1000});
  assert.equal(verification.kind,'skip');if(verification.kind==='skip')assert.equal(verification.reason,'verification');
});

test('invalid minimum intervals are rejected before policy mutation and never coerced by wire parsing',()=>{
  const stamp:InputStamp={inputId:17,captureTime:2,observedAtMs:10};
  for(const minIntervalMs of [null,NaN,Infinity,-Infinity,-.001,1000.001,'250',true,[],{}]){
    const policy=createLiveInputAdmission(),before=policy.snapshot(),gates={...open,minIntervalMs} as unknown as LiveInputGates;
    assert.throws(()=>policy.consider(stamp,gates),/minimum input interval/);assert.deepEqual(policy.snapshot(),before);
    assert.equal(policy.consider(stamp,open).kind,'freeze','an invalid gate does not consume the input identity');
    assert.throws(()=>parseLiveInputAdmissionFact({kind:'consider',stamp,gates}),/minimum input interval/);
  }
  assert.throws(()=>parseLiveInputAdmissionFact({kind:'consider',stamp,gates:{...open,minIntervalMs:250,pixels:[]}}));
});

test('recorded per-arrival intervals are detached and drive the same decisions on replay',async()=>{
  const original=createLiveInputAdmission(),gates={...open,minIntervalMs:250},facts:LiveInputAdmissionFact[]=[],choices:unknown[]=[];
  const apply=(fact:LiveInputAdmissionFact)=>{const parsed=parseLiveInputAdmissionFact(fact);facts.push(parsed);
    const choice=applyLiveInputAdmissionFact(original,parsed);if(choice)choices.push(choice);};
  const first=original.stamp(5,10);apply({kind:'consider',stamp:first,gates,expected:'freeze'});
  apply({kind:'frozen',stamp:first,succeeded:true,freezeMs:0});apply({kind:'completed',startedAtMs:10,endedAtMs:20});
  apply({kind:'consider',stamp:original.stamp(4,200),gates,expected:'cadence'});
  const next=original.stamp(3,260);apply({kind:'consider',stamp:next,gates,expected:'freeze'});
  apply({kind:'frozen',stamp:next,succeeded:true,freezeMs:0});
  gates.minIntervalMs=1000;
  for(const fact of facts.filter((fact)=>fact.kind==='consider')){
    assert.equal(fact.gates.minIntervalMs,250);assert.equal(Object.isFrozen(fact.gates),true);
  }
  const replay=createLiveInputAdmission(),replayed=JSON.parse(JSON.stringify(facts)).map((fact:unknown)=>applyLiveInputAdmissionFact(replay,fact)).filter(Boolean);
  assert.deepEqual(replayed,choices);assert.deepEqual(replay.snapshot(),original.snapshot());
  assert.equal(await hashLiveInputAdmission(replay.snapshot()),await hashLiveInputAdmission(original.snapshot()));
  const changed=facts.map(fact=>fact.kind==='consider'&&fact.expected==='cadence'?{...fact,gates:open}:fact);
  assert.throws(()=>{const invalid=createLiveInputAdmission();for(const fact of changed)applyLiveInputAdmissionFact(invalid,fact);},/differs from the recorded choice/);
});

test('source capacity defers repeated arrivals without a freeze or calibration and admits a new arrival when credit returns',()=>{
  const policy=createLiveInputAdmission();policy.completed(0,20);
  for(const at of [20,21,22]){
    const stamp=policy.stamp(at/1000,at),decision=policy.consider(stamp,{...open,sourceCapacity:false});
    assert.deepEqual(decision,{kind:'skip',stamp,reason:'source-capacity'});
    assert.deepEqual(policy.snapshot(),{nextInputId:stamp.inputId,lastConsideredId:stamp.inputId,offered:0,meanFreezeMs:0,
      lastOfferedAtMs:null,lastCompletedAtMs:20,acquisitionMs:20,pending:null});
    assert.throws(()=>policy.frozen(stamp,{succeeded:true,freezeMs:100}),/does not match/);
  }
  const next=policy.stamp(.023,22);
  assert.equal(policy.consider(next,{...open,sourceCapacity:true}).kind,'freeze','credit recovery does not add a post-deferral cadence delay');
  policy.frozen(next,{succeeded:true,freezeMs:2});
  assert.equal(policy.snapshot().offered,1);assert.equal(policy.snapshot().meanFreezeMs,2);
  assert.equal(policy.snapshot().lastOfferedAtMs,22);assert.equal(policy.snapshot().pending,null);
});

test('source capacity precedence follows ended and verification but precedes cadence without bypassing it',()=>{
  const policy=createLiveInputAdmission();policy.completed(0,200);
  const consider=(at:number,gates:LiveInputGates)=>policy.consider(policy.stamp(at/1000,at),gates);
  assert.equal((consider(1,{capturing:false,checkingCompletion:true,sourceCapacity:false}) as {reason:string}).reason,'ended');
  assert.equal((consider(2,{...open,checkingCompletion:true,sourceCapacity:false}) as {reason:string}).reason,'verification');
  assert.equal((consider(3,{...open,sourceCapacity:false}) as {reason:string}).reason,'source-capacity');
  assert.equal((consider(4,{...open,sourceCapacity:true}) as {reason:string}).reason,'cadence');
  const available=consider(200,{...open,sourceCapacity:true});assert.equal(available.kind,'freeze');
  policy.frozen(available.stamp,{succeeded:true,freezeMs:20});
  assert.equal((consider(201,{...open,sourceCapacity:false}) as {reason:string}).reason,'source-capacity');
  assert.equal((consider(202,{...open,sourceCapacity:true}) as {reason:string}).reason,'cadence');
  assert.equal(consider(280,{...open,sourceCapacity:true}).kind,'freeze');
});

test('absent source capacity preserves legacy wire bytes, snapshot and policy hash',async()=>{
  const fact:LiveInputAdmissionFact={kind:'consider',stamp:{inputId:1,captureTime:2,observedAtMs:0},gates:open,expected:'freeze'},
    parsed=parseLiveInputAdmissionFact(fact);
  assert.equal(parsed.kind,'consider');if(parsed.kind!=='consider')return;
  assert.equal(Object.hasOwn(parsed.gates,'sourceCapacity'),false);assert.equal(JSON.stringify(parsed),JSON.stringify(fact));
  assert.equal(JSON.stringify(parseLiveInputAdmissionFact({...fact,gates:{...open,sourceCapacity:undefined}})),JSON.stringify(fact));
  const legacy=createLiveInputAdmission(),available=createLiveInputAdmission();
  for(const [policy,gates]of [[legacy,open],[available,{...open,sourceCapacity:true}]] as const){
    const stamp=policy.stamp(2,0);policy.consider(stamp,gates);policy.frozen(stamp,{succeeded:true,freezeMs:2});
  }
  const snapshot={nextInputId:1,lastConsideredId:1,offered:1,meanFreezeMs:2,lastOfferedAtMs:0,lastCompletedAtMs:null,acquisitionMs:0,pending:null};
  assert.deepEqual(legacy.snapshot(),snapshot);assert.deepEqual(available.snapshot(),snapshot);
  assert.equal(await hashLiveInputAdmission(legacy.snapshot()),'475a5a821ffa940d67bf49ed7fba12f05b87e42cbd4c955996154f3941bb6003');
  assert.equal(await hashLiveInputAdmission(available.snapshot()),await hashLiveInputAdmission(legacy.snapshot()));
});

test('source capacity wire facts are detached, strict and replay the recorded deferral choice',async()=>{
  const original=createLiveInputAdmission(),gates={...open,sourceCapacity:false},facts:LiveInputAdmissionFact[]=[],choices:unknown[]=[];
  const apply=(fact:LiveInputAdmissionFact)=>{const parsed=parseLiveInputAdmissionFact(fact);facts.push(parsed);
    const choice=applyLiveInputAdmissionFact(original,parsed);if(choice)choices.push(choice);};
  apply({kind:'consider',stamp:original.stamp(4,100),gates,expected:'source-capacity'});
  gates.sourceCapacity=true;
  const next=original.stamp(3,100);apply({kind:'consider',stamp:next,gates,expected:'freeze'});
  apply({kind:'frozen',stamp:next,succeeded:true,freezeMs:1});
  const deferred=facts[0];assert.equal(deferred.kind,'consider');if(deferred.kind!=='consider')return;
  assert.equal(deferred.gates.sourceCapacity,false);assert.equal(Object.isFrozen(deferred.gates),true);
  const replay=createLiveInputAdmission(),replayed=JSON.parse(JSON.stringify(facts)).map((fact:unknown)=>applyLiveInputAdmissionFact(replay,fact)).filter(Boolean);
  assert.deepEqual(replayed,choices);assert.deepEqual(replay.snapshot(),original.snapshot());
  assert.equal(await hashLiveInputAdmission(replay.snapshot()),await hashLiveInputAdmission(original.snapshot()));
  assert.throws(()=>applyLiveInputAdmissionFact(createLiveInputAdmission(),{...deferred,expected:'freeze'}),/differs from the recorded choice/);
  assert.throws(()=>applyLiveInputAdmissionFact(createLiveInputAdmission(),{...deferred,gates:{...open,sourceCapacity:true}}),/differs from the recorded choice/);
});

test('nonboolean source capacity is rejected before policy mutation and never creates a freeze',()=>{
  const stamp:InputStamp={inputId:17,captureTime:2,observedAtMs:10};
  for(const sourceCapacity of [null,0,1,'false','true',[],{}]){
    const policy=createLiveInputAdmission(),before=policy.snapshot(),gates={...open,sourceCapacity} as unknown as LiveInputGates;
    assert.throws(()=>policy.consider(stamp,gates),/source capacity gate/);assert.deepEqual(policy.snapshot(),before);
    assert.equal(policy.consider(stamp,open).kind,'freeze','an invalid gate does not consume the arrival');
    assert.throws(()=>parseLiveInputAdmissionFact({kind:'consider',stamp,gates}),/source capacity gate/);
  }
});
