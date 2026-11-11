import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLiveInputAdmission} from '../src/features/card-scanner/capture/live-input-admission';
import {LatestAcquisitionGate} from '../src/features/card-scanner/acquisition/latest-acquisition-gate';
import {canStopSharing,type CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';
import {snapshotHeader,headerSnapshotMatches} from '../src/features/card-scanner/session/completion-header-snapshot';
import {CompletionViewSnapshot,commitWithCurrentView,type CompletionView} from '../src/features/card-scanner/session/completion-current-view';
import {CompletionObstructionDebt,type ReobservedCard} from '../src/features/card-scanner/session/completion-obstruction-debt';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';

const view=(inputId:number,pixels:number[],captureTime=inputId):CompletionView=>({sessionId:'s',inputId,captureTime,
 geometry:'relevant-roi',width:2,height:1,pixels:Uint8Array.from(pixels)});
const baselinePixels=[1,2,3,255,4,5,6,255];
const completion=():CaptureCompletion=>({expected:1,finalExpected:1,headerAvailable:true,inputSettled:true,fieldChangesSettled:true,unresolved:0,dropped:0,
 cards:[{id:'a',name:'a',awakening:0,extraCopies:0,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
 latest:new Map([['a',1]]),confirmed:new Map([['a',1]]),confirmedNames:new Map([['a',1]])});
const header=()=>({width:1,height:1,pixels:Uint8ClampedArray.of(4,5,6,255),captureTime:1,sourceFrame:1});
const source=(frameId:number,observationId:string,slot=0):ObservationSource=>({sessionId:'s',frameId,observationId,
 captureOrder:frameId*40+slot,captureTime:frameId,phase:'input',slot});

// Characterizes the current risk and an unconnected candidate guard. Passing
// this file does not establish that the product uses commitWithCurrentView.
test('known risk: admission can skip a changed input while existing gates remain satisfied',()=>{
 for(const reason of ['cadence','source-capacity'] as const){
  const admission=createLiveInputAdmission(),first=admission.stamp(1,1),gates={capturing:true,checkingCompletion:false,minIntervalMs:100};
  assert.equal(admission.consider(first,gates).kind,'freeze');admission.frozen(first,{succeeded:true,freezeMs:1});
  const latestGate=new LatestAcquisitionGate();latestGate.begin(1);latestGate.finish(1,true);
  const savedHeader=snapshotHeader(header()),reference=new CompletionViewSnapshot(view(1,baselinePixels));
  const second=admission.stamp(2,2),decision=admission.consider(second,{...gates,...(reason==='source-capacity'?{sourceCapacity:false}:{})});
  assert.equal(decision.kind,'skip');if(decision.kind==='skip')assert.equal(decision.reason,reason);
  assert.equal(latestGate.settled,true);assert.equal(headerSnapshotMatches(savedHeader,header()),true);
  assert.equal(canStopSharing(completion()),true,'the existing independent gates cannot see the skipped pixels');
  let stopped=false;
  const changed=view(second.inputId,[1,2,3,255,4,5,9,255]);
  assert.equal(commitWithCurrentView(reference,admission.snapshot().lastConsideredId,()=>changed,
   ()=>latestGate.settled&&headerSnapshotMatches(savedHeader,header())&&canStopSharing(completion()),()=>{stopped=true;}),false);
  assert.equal(stopped,false);
 }
});

test('a fresh synchronous exact ROI sample can finish even when cadence skips repeat arrivals',()=>{
 const admission=createLiveInputAdmission(),first=admission.stamp(1,1),gates={capturing:true,checkingCompletion:false,minIntervalMs:100};
 assert.equal(admission.consider(first,gates).kind,'freeze');admission.frozen(first,{succeeded:true,freezeMs:1});
 const original=view(1,baselinePixels),snapshot=new CompletionViewSnapshot(original);original.pixels[0]=99;
 const second=admission.stamp(2,2);assert.equal(admission.consider(second,gates).kind,'skip');let stopped=0;
 assert.equal(commitWithCurrentView(snapshot,admission.snapshot().lastConsideredId,()=>view(2,baselinePixels),()=>true,()=>{stopped++;}),true);
 assert.equal(stopped,1,'sample and stop occur in the same synchronous call');
});

test('missing, stale, resized, different geometry and shared mutable pixel evidence fail closed',()=>{
 const snapshot=new CompletionViewSnapshot(view(1,baselinePixels));let stopped=0;
 const valid=view(2,baselinePixels);
 for(const candidate of [undefined,{...valid,inputId:1},{...valid,captureTime:0},{...valid,sessionId:'other'},
  {...valid,geometry:'changed'},{...valid,width:1}, {...valid,pixels:new Uint8Array(new SharedArrayBuffer(8))}]){
  assert.equal(commitWithCurrentView(snapshot,2,()=>candidate,()=>true,()=>{stopped++;}),false);
 }
 assert.equal(commitWithCurrentView(snapshot,2,()=>valid,()=>false,()=>{stopped++;}),false);
 assert.equal(stopped,0);
 assert.throws(()=>commitWithCurrentView(snapshot,2,()=>valid,()=>true,()=>{throw Error('stop failed');}),/stop failed/);
});

test('a covered unidentified crop remains debt until each identity has later source-bound name and field proofs',()=>{
 const debt=new CompletionObstructionDebt();debt.notice({sessionId:'s',frameId:4,captureTime:4});
 const a:ReobservedCard={id:'a',name:source(5,'a-name',0),fields:source(5,'a-fields',0)};
 const b:ReobservedCard={id:'b',name:source(6,'b-name',1),fields:source(6,'b-fields',1)};
 assert.equal(debt.settled(['a','b'],[a]),false,'a newer empty frame or matching count is not proof');
 assert.equal(debt.settled(['a','b'],[a,{...b,fields:source(4,'old',1)}]),false);
 assert.equal(debt.settled(['a','b'],[a,{...b,name:{...b.name,sessionId:'other'}}]),false);
 assert.equal(debt.settled(['a','b'],[a,{...b,name:{...b.name,phase:'recovery'}}]),false);
 assert.equal(debt.settled(['a','b'],[a,{...b,name:a.name}]),false,'one observation cannot be two identities');
 assert.equal(debt.settled(['a','b'],[a,{...b,name:{...a.name,observationId:'different-attempt'}}]),false,
  'different observation IDs for one physical frame/slot do not prove two identities');
 assert.equal(debt.settled(['a','b'],[a,b]),true);
 debt.notice({sessionId:'s',frameId:7,captureTime:7});assert.equal(debt.settled(['a','b'],[a,b]),false,'later obstruction renews debt');
});
