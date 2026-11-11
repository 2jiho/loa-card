import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeAutoStopInput} from '../scripts/analyze-auto-stop-input.mjs';
import {createLiveInputAdmission} from '../src/features/card-scanner/capture/live-input-admission';
import {createCapturedHeaderReads} from '../src/features/card-scanner/capture/captured-header-read';
import type {CapturedHeaderRegion} from '../src/features/card-scanner/capture/captured-header-read';
import {createCompletionRaceScenario} from '../dev/completion-race-scenario';

type Event={seq:number;type:string;value:unknown};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(ok=>{resolve=ok;});return {promise,resolve};}
const source=(inputId:number|null):CapturedHeaderRegion=>({source:{sessionId:'s',processingFrame:1,acquisitionFrameId:1,
 canonicalSourceFrameId:1,observationFrameId:'s:1',inputId,captureTime:1,phase:'input',sourceWidth:1920,sourceHeight:1080},
 headerBox:{x:100,y:100,width:300,height:40}});
async function scenario({skipBefore=true,sourceId=1 as number|null}={}) {
 const events:Event[]=[],emit=(type:string,value:unknown)=>{events.push({seq:events.length+1,type,value});};
 const admission=createLiveInputAdmission();
 const stamp=admission.stamp(1,1000),gates={capturing:true,checkingCompletion:false};
 const selected=admission.consider(stamp,gates);assert.equal(selected.kind,'freeze');
 emit('input-admission',{kind:'consider',stamp,gates,expected:'freeze'});
 admission.frozen(stamp,{succeeded:true,freezeMs:1});
 emit('input-admission',{kind:'frozen',stamp,succeeded:true,freezeMs:1});
 emit('input-link',{inputId:1,frameId:1,captureTime:1,phase:'input'});
 const ocr=deferred<{owned:number;capacity:number}>();
 const reads=createCapturedHeaderReads(fact=>{emit('inventory-header-read',fact);return true;});
 const read=reads.read(source(sourceId),'auto-completion',()=>ocr.promise);
 const deliver=()=>{
  const skipped=admission.stamp(1.1,1100),paused={capturing:true,checkingCompletion:true};
  const decision=admission.consider(skipped,paused);assert.equal(decision.kind,'skip');
  emit('input-admission',{kind:'consider',stamp:skipped,gates:paused,expected:'verification'});
 };
 if(skipBefore)deliver();
 ocr.resolve({owned:393,capacity:450});await read;
 if(!skipBefore)deliver();
 return {events,complete:true,dropped:0};
}

test('a callback during delayed header OCR is exposed as unknown pixels, not a proven change',async()=>{
 const trace=await scenario();const result=analyzeAutoStopInput(trace);
 assert.equal(result.status,'measured');assert.equal(result.headerReads,1);
 assert.equal(result.checks[0].inputLinkMatches,true);
 assert.equal(result.checks[0].newerVerificationSkips,1);
 assert.equal(result.checks[0].interpretation,'unobserved-input-possible');
 assert.match(result.scope,/does not prove a share stopped/);
});
test('a later callback is not incorrectly attributed to an already completed header read',async()=>{
 const result=analyzeAutoStopInput(await scenario({skipBefore:false}));
 assert.equal(result.totalVerificationSkips,1);assert.equal(result.checks[0].newerVerificationSkips,0);
});
test('missing source ID or trace loss is partial, not a claim of safety',async()=>{
 const unlinked=analyzeAutoStopInput(await scenario({sourceId:null}));
 assert.equal(unlinked.status,'partial');assert.equal(unlinked.checks[0].newerVerificationSkips,null);
 const trace=await scenario();trace.complete=false;trace.dropped=1;
 assert.equal(analyzeAutoStopInput(trace).status,'partial');
 const missing=await scenario();missing.events=missing.events.filter(event=>event.type!=='input-link');
 assert.equal(analyzeAutoStopInput(missing).status,'partial');
});
test('no header is unmeasured, and tampered order or decisions fail closed',async()=>{
 const trace=await scenario();
 assert.equal(analyzeAutoStopInput({...trace,events:trace.events.filter(event=>event.type!=='inventory-header-read')}).status,'unmeasured');
 const unordered=structuredClone(trace);unordered.events[1].seq=1;
 assert.throws(()=>analyzeAutoStopInput(unordered),/ordered/);
 const changed=structuredClone(trace);(changed.events[3].value as {expected:string}).expected='freeze';
 assert.throws(()=>analyzeAutoStopInput(changed),/differs/);
});

test('bounded skip history remains partial when it can no longer cover the header source',async()=>{
 const trace=await scenario();
 const header=trace.events.pop()!;
 for(let i=3;i<=50003;i++)trace.events.push({seq:trace.events.length+1,type:'input-admission',value:{kind:'consider',
  stamp:{inputId:i,captureTime:i/100,observedAtMs:i},gates:{capturing:true,checkingCompletion:true},expected:'verification'}});
 header.seq=trace.events.length+1;trace.events.push(header);
 const result=analyzeAutoStopInput(trace);
 assert.equal(result.status,'partial');assert.equal(result.truncatedSkips,2);
 assert.equal(result.checks[0].historyPartial,true);
 assert.equal(result.checks[0].newerVerificationSkips,50000);
});

const view=(id:number,overrides:Partial<{pixels:Uint8Array;geometry:string;located:boolean;fieldChanged:boolean;headerPixels:Uint8ClampedArray}>={})=>
 ({id,pixels:new Uint8Array([1,2,3,4]),geometry:'g',located:true,fieldChanged:false,...overrides});
test('synthetic delayed OCR permits acquisition concurrently but waits for the accepted input',async()=>{
 const s=createCompletionRaceScenario();s.arrive(view(2));await s.started();
 assert.deepEqual(s.result().started,[2]);assert.equal(s.result().headerRead,false);
 s.finishHeader(1);assert.equal(s.result().eligible,false);
 s.settle(2);await s.flush();assert.equal(s.result().eligible,true);
});
test('synthetic changed pixels or unlocated view invalidate the old header epoch',async()=>{
 for(const next of [view(2,{pixels:new Uint8Array([1,9,3,4])}),view(2,{geometry:'unlocated',located:false}),
  view(2,{located:false})]){
  const s=createCompletionRaceScenario();s.arrive(next);await s.started();s.settle(2);await s.flush();
  s.finishHeader(1);assert.equal(s.result().eligible,false);
 }
});
test('synthetic changed fields stay unresolved until confirmed, but still require a new header epoch',async()=>{
 const s=createCompletionRaceScenario();s.arrive(view(2,{pixels:new Uint8Array([1,2,3,8]),fieldChanged:true}));
 await s.started();s.settle(2);await s.flush();s.finishHeader(1);
 assert.equal(s.result().fieldsSettled,false);assert.equal(s.result().eligible,false);
 s.confirmField(2,1);assert.equal(s.result().fieldsSettled,true);assert.equal(s.result().eligible,false);
});
test('synthetic newer changed header rejects a prior OCR snapshot even when other samples match',async()=>{
 const s=createCompletionRaceScenario();s.arrive(view(2,{headerPixels:new Uint8ClampedArray([1,2,3,5])}));
 await s.started();s.settle(2);await s.flush();s.finishHeader(1);
 assert.equal(s.result().eligible,false);
});
test('synthetic identical repeating frames do not require still another arrival to finish',async()=>{
 const s=createCompletionRaceScenario();
 for(const id of [2,3,4]){s.arrive(view(id));await s.started();s.settle(id);await s.flush();}
 s.finishHeader(1);assert.equal(s.result().eligible,true);
});
test('synthetic OCR mismatch, failure, and a closed stream never permit auto completion',async()=>{
 for(const value of [null,2]){const s=createCompletionRaceScenario();s.finishHeader(value);assert.equal(s.result().eligible,false);}
 const failed=createCompletionRaceScenario();failed.arrive(view(2));await failed.started();failed.fail(2);await failed.flush();
 failed.finishHeader(1);assert.equal(failed.result().eligible,false);assert.equal(failed.result().failed,true);
 const ended=createCompletionRaceScenario();ended.stop();ended.finishHeader(1);
 assert.equal(ended.result().headerRead,false);assert.equal(ended.result().eligible,false);
});
