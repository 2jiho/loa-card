import {test} from 'node:test';
import assert from 'node:assert/strict';
import {entryParts,executionSummary} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import type {ExactEvent} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import {InputDecisionReplay,parseInputRecoveryFact} from '../src/features/card-scanner/reproduction/live-input-decision-replay';
import {RunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';

const signal=()=>new AbortController().signal;
const stamp=(id:number,source?:{mediaTime:number;presentedFrames:number})=>({inputId:id,captureTime:id/1000,
  observedAtMs:id,...(source?{source}:{})});
function prepare(kind:'cadence'|'source-capacity',source?:{mediaTime:number;presentedFrames:number}) {
 const replay=new InputDecisionReplay(signal()),events:ExactEvent[]=[];
 const emit=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:0,type,value});
 const admit=(value:unknown)=>{replay.admission(value);emit('input-admission',value);};
 const first=stamp(1);
 if(kind==='cadence'){
  admit({kind:'consider',stamp:first,gates:{capturing:true,checkingCompletion:false},expected:'freeze'});
  admit({kind:'frozen',stamp:first,succeeded:true,freezeMs:1});
 }
 const target=stamp(2,source);
 admit({kind:'consider',stamp:target,gates:{capturing:true,checkingCompletion:false,
   ...(kind==='source-capacity'?{sourceCapacity:false}:{})},expected:kind});
 const recovery=(value:unknown)=>{replay.recovery(value);emit('input-recovery',value);};
 return {replay,events,emit,recovery,target};
}

for(const reason of ['cadence','source-capacity'] as const)test(`v2 ${reason} ownership keeps the original stamp through exact event replay`,async()=>{
 const {replay,events,emit,recovery,target}=prepare(reason,{mediaTime:0.002,presentedFrames:7});
 recovery({version:2,seq:1,kind:'retained',skipReason:reason,stamp:target});
 recovery({version:1,seq:2,kind:'started',inputId:2});
 const link={inputId:2,frameId:23,captureTime:target.captureTime,phase:'input'};
 replay.link(link);emit('input-link',link);
 recovery({version:1,seq:3,kind:'finished',inputId:2,outcome:'completed'});
 recovery({version:1,seq:4,kind:'released',inputId:2,failed:false,reason:'processed'});
 const captured=await replay.summary();assert.equal(captured.settled,true);
 emit('input-checkpoint',{complete:true,hash:captured.hash});
 const blob=new Blob(events.flatMap(event=>entryParts(event)));
 const result=await executionSummary(blob,signal(),{complete:true,dropped:0,events:events.length,frames:0});
 const trace=new RunStateTrace();for(const event of events)assert.equal(trace.record(event.type,event.value,event.time),true);
 const state=await replayRunStateTrace(await trace.snapshotBlob(),signal());
 assert.equal(result.input.hash,captured.hash);assert.equal(result.input.matchesCapturedState,true);
 assert.equal(state.input.hash,captured.hash);assert.equal(state.input.matchesCapturedState,true);
 assert.equal(result.input.recovery?.linked,1);assert.equal(result.input.recovery?.lost,0);
 assert.equal(result.cards.length,0,'input linkage is not card identification evidence');
});

test('v2 cannot borrow another callback stamp, clock, source or skip reason',()=>{
 const source={mediaTime:0.002,presentedFrames:7};
 const mutations=[
  (s:ReturnType<typeof stamp>)=>({...s,inputId:3}),
  (s:ReturnType<typeof stamp>)=>({...s,captureTime:0.003}),
  (s:ReturnType<typeof stamp>)=>({...s,observedAtMs:3}),
  (s:ReturnType<typeof stamp>)=>({...s,source:{...source,presentedFrames:8}}),
  (s:ReturnType<typeof stamp>)=>{const {source:_source,...rest}=s;return rest;},
 ];
 for(const mutate of mutations){
  const {recovery,target}=prepare('cadence',source);
  assert.throws(()=>recovery({version:2,seq:1,kind:'retained',skipReason:'cadence',stamp:mutate(target)}));
 }
 const {recovery,target}=prepare('cadence',source);
 assert.throws(()=>recovery({version:2,seq:1,kind:'retained',skipReason:'source-capacity',stamp:target}));
});

test('v2 cannot adopt a verification skip, duplicate an input or borrow a source annotation',()=>{
 const replay=new InputDecisionReplay(signal()),target=stamp(1);
 replay.admission({kind:'consider',stamp:target,gates:{capturing:true,checkingCompletion:true},expected:'verification'});
 assert.throws(()=>replay.recovery({version:2,seq:1,kind:'retained',skipReason:'cadence',stamp:target}));
 const other=prepare('source-capacity');
 assert.throws(()=>other.recovery({version:2,seq:1,kind:'retained',skipReason:'source-capacity',
  stamp:{...other.target,source:{mediaTime:0.002,presentedFrames:7}}}));
 const duplicate=prepare('source-capacity');
 duplicate.recovery({version:2,seq:1,kind:'retained',skipReason:'source-capacity',stamp:duplicate.target});
 assert.throws(()=>duplicate.recovery({version:2,seq:2,kind:'retained',skipReason:'source-capacity',stamp:duplicate.target}));
});

test('a skipped input cannot be laundered into a normal pipeline offer',()=>{
 for(const reason of ['cadence','source-capacity'] as const){
  const {replay,target}=prepare(reason);
  assert.throws(()=>replay.pipeline({version:1,seq:1,atMs:2,kind:'offered',inputId:2,
    captureTime:target.captureTime,observedAtMs:target.observedAtMs}));
 }
});

test('unretained v2 loss is linked to the exact skip and prevents a settled checkpoint',async()=>{
 for(const reason of ['cadence','source-capacity'] as const){
  const {replay,events,recovery,target}=prepare(reason,{mediaTime:0.002,presentedFrames:7});
  recovery({version:2,seq:1,kind:'lost',skipReason:reason,stamp:target,inputId:target.inputId,reason:'capacity'});
  const result=await replay.summary();assert.equal(result.settled,false);assert.equal(result.recovery?.lost,1);
  const archive=await executionSummary(new Blob(events.flatMap(event=>entryParts(event))),signal(),
   {complete:true,dropped:0,events:events.length,frames:0});
  assert.equal(archive.recordingComplete,false);assert.equal(archive.input.matchesCapturedState,null);
 }
 const {recovery,target}=prepare('source-capacity');
 assert.throws(()=>recovery({version:2,seq:1,kind:'lost',skipReason:'source-capacity',stamp:target,inputId:3,reason:'capacity'}));
});

test('v2 parser rejects unsupported shapes and keeps v1 strict',()=>{
 const value={version:2,seq:1,kind:'retained',stamp:stamp(1),skipReason:'cadence'};
 for(const bad of [{...value,skipReason:'verification'},{...value,version:3},{...value,other:true},
  {...value,kind:'started'}, {...value,version:1}])assert.throws(()=>parseInputRecoveryFact(bad));
 assert.equal(parseInputRecoveryFact(value).version,2);
});
