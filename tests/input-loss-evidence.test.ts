import test from 'node:test';
import assert from 'node:assert/strict';
import {RunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';
import {InputLossEvidence,candidateQueueInputLoss,pipelineInputLoss} from '../src/features/card-scanner/session/input-loss-evidence';
import {CandidateQueue} from '../src/features/card-scanner/acquisition/candidate-queue';
import {createLiveCapturePipeline} from '../src/features/card-scanner/capture/live-capture-pipeline';
import {entryParts,executionSummary} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import {scanMonitorOutcome} from '../src/features/card-scanner/session/scan-monitor-outcome';
import {canStopSharing,type CaptureCompletion} from '../src/features/card-scanner/session/auto-completion';

const fact=(inputId:number,reason:'freeze-failed'|'queue-full'='freeze-failed')=>({version:1 as const,inputId,captureTime:inputId/10,reason});
const fresh=()=>{const x=new InputLossEvidence();x.seed({version:1});return x;};
const completion=(dropped:number):CaptureCompletion=>({expected:1,finalExpected:1,unresolved:0,dropped,
 cards:[{id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
 latest:new Map([['a',1]]),confirmedNames:new Map([['a',1]]),confirmed:new Map([['a',1]]),inputSettled:true,headerAvailable:true,fieldChangesSettled:true});

test('same physical source only counts once and a new session resets the loss',()=>{
 const x=fresh();assert.equal(x.accept(fact(1)),true);assert.equal(x.accept(fact(1,'queue-full')),false);
 assert.equal(x.summary().observedCount,1);assert.equal(canStopSharing(completion(x.summary().observedCount!)),false);
 assert.equal(canStopSharing(completion(fresh().summary().observedCount!)),true);
});

test('a queue filling during one acquired frame records the source loss and blocks completion',()=>{
 const queue=new CandidateQueue<{group:number}>(2,()=>{}),evidence=fresh(),stamp={inputId:3,captureTime:.3};
 for(let slot=0;slot<4;slot++){
  const admission=queue.pushDetailed({group:slot});
  const loss=candidateQueueInputLoss(admission,stamp,true);
  if(loss)evidence.accept(loss);
 }
 assert.equal(queue.length,2);
 assert.equal(evidence.summary().observedCount,1,'multiple rejected slots belong to one input');
 assert.equal(canStopSharing(completion(evidence.summary().observedCount!)),false);
 assert.equal(candidateQueueInputLoss('present',stamp,true),null,'a policy rejection is not a capacity loss');
 assert.equal(candidateQueueInputLoss('full',stamp,false),null,'inactive or recovery work is not live input loss');
 assert.equal(candidateQueueInputLoss('full',undefined,true),null,'cannot invent a missing source stamp');
});

test('actual pipeline capacity, replacement and intentional disposal have distinct loss outcomes',async()=>{
 const evidence=fresh(),released:number[]=[];let continueYield!:()=>void,active=true;
 const wait=new Promise<void>(resolve=>{continueYield=resolve;});
 const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:1,maxRetainedBytes:2,frameBytes:x=>x===3?3:1,
  yieldTask:()=>wait,consume:()=>{},release:x=>{released.push(x);},onError:assert.fail,
  onDecision:d=>{const lost=pipelineInputLoss(d,active);if(lost)evidence.accept(lost);}});
 const stamp=(inputId:number)=>({inputId,captureTime:inputId/10,observedAtMs:inputId});
 pipeline.offer(1,.1,stamp(1));pipeline.offer(2,.2,stamp(2)); // intentional replace
 pipeline.offer(3,.3,stamp(3)); // cannot fit even alone
 assert.equal(evidence.summary().observedCount,1);assert.equal(canStopSharing(completion(evidence.summary().observedCount!)),false);
 active=false;pipeline.dispose();pipeline.offer(4,.4,stamp(4));continueYield();await pipeline.flush();
 assert.equal(evidence.summary().observedCount,1);assert.deepEqual([...released].sort(),[1,2,3,4]);
});

test('capacity loss still blocks automatic stop after diagnostic recording fails',()=>{
 const evidence=fresh(), errors:unknown[]=[];
 const pipeline=createLiveCapturePipeline<number>({maxRetainedBytes:1,frameBytes:()=>2,
  yieldTask:async()=>{},consume:()=>{},release:()=>{},onError:assert.fail,
  onDecision:()=>{throw new Error('diagnostic sink failed');},onRecordError:error=>{errors.push(error);},
  onRelease:decision=>{const loss=pipelineInputLoss(decision,true);if(loss)evidence.accept(loss);}});
 pipeline.offer(1,1,{inputId:1,captureTime:1,observedAtMs:1});
 assert.equal(errors.length,1);
 assert.equal(evidence.summary().observedCount,1);
 assert.equal(canStopSharing(completion(evidence.summary().observedCount!)),false);
});

test('recovery lifecycle stays operational after diagnostic recording fails',async()=>{
 const events:string[]=[],errors:unknown[]=[];
 // Provoke diagnostic failure on a capacity-rejected ordinary frame first.
 const recovery=createLiveCapturePipeline<number>({maxRetainedBytes:1,frameBytes:x=>x===1?2:1,
  yieldTask:async()=>{},consume:()=>{throw new Error('recovery failed');},release:()=>{},onError:()=>{},
  onDecision:()=>{throw new Error('diagnostic sink failed');},onRecordError:error=>{errors.push(error);},
  onRecoveryLifecycle:event=>{events.push(event.kind==='finished'?`${event.kind}:${event.outcome}`:event.kind);}});
 recovery.offer(1,1,{inputId:1,captureTime:1,observedAtMs:1});
 assert.equal(recovery.offerRecovery([{frame:2,stamp:{inputId:2,captureTime:2,observedAtMs:2}}]),true);
 await recovery.flush();
 assert.ok(errors.length>=1);
 assert.deepEqual(events,['started','finished:error','released']);
});

test('operational callback failures report an independent safety failure',()=>{
 let failed=false;
 const pipeline=createLiveCapturePipeline<number>({maxRetainedBytes:1,frameBytes:()=>2,
  yieldTask:async()=>{},consume:()=>{},release:()=>{},onError:assert.fail,
  onRelease:()=>{throw new Error('state update failed');},onOperationalError:()=>{failed=true;}});
 pipeline.offer(1,1,{inputId:1,captureTime:1,observedAtMs:1});
 assert.equal(failed,true);
});

test('execution recording replays the same loss evidence and legacy or interrupted records stay unknown',async()=>{
 const events=[['input-loss-contract',{version:1}],['input-loss',fact(1)],['input-loss',fact(1,'queue-full')]] as const;
 const archive=(items:readonly (readonly [string,unknown])[])=>new Blob(items.flatMap(([type,value],i)=>entryParts({kind:'event',seq:i+1,time:i/10,type,value})));
 const summary=await executionSummary(archive(events),new AbortController().signal);
 assert.deepEqual(summary.inputLoss,{supported:true,observedCount:1,absenceProven:false,overflow:false});
 const legacy=await executionSummary(archive([]),new AbortController().signal);
 assert.equal(legacy.inputLoss.observedCount,null);
 const interrupted=await executionSummary(archive([...events,['input-recording-error',{}]]),new AbortController().signal);
 assert.equal(interrupted.inputLoss.observedCount,null);
});

test('compressed state replay preserves the live loss facts without claiming absence',async()=>{
 const trace=new RunStateTrace();
 assert.equal(trace.record('input-loss-contract',{version:1},0),true);
 assert.equal(trace.record('input-loss',fact(1),1),true);
 assert.equal(trace.record('input-loss',fact(1,'queue-full'),2),true);
 const replay=await replayRunStateTrace(await trace.snapshotBlob(),new AbortController().signal);
 assert.deepEqual(replay.inputLoss,{supported:true,observedCount:1,absenceProven:false,overflow:false});
 trace.dispose();
});

test('64 MiB budget admits a UHD active and pending frame but can lose larger active views',async()=>{
 const limit=64*1024*1024;
 const run=async(width:number,height:number)=>{
  const evidence=fresh();let resume!:()=>void,started!:()=>void;
  const held=new Promise<void>(resolve=>{resume=resolve;}),begun=new Promise<void>(resolve=>{started=resolve;});
  const bytes=width*height*4;
  const pipeline=createLiveCapturePipeline<number>({maxPendingFrames:2,maxRetainedBytes:limit,frameBytes:()=>bytes,
   yieldTask:async()=>{},consume:async id=>{if(id===1){started();await held;}},release:()=>{},onError:assert.fail,
   onDecision:d=>{const loss=pipelineInputLoss(d,true);if(loss)evidence.accept(loss);}});
  const stamp=(inputId:number)=>({inputId,captureTime:inputId,observedAtMs:inputId});
  pipeline.offer(1,1,stamp(1));await begun;
  pipeline.offer(2,2,stamp(2));pipeline.offer(3,3,stamp(3));
  const result=evidence.summary().observedCount;resume();await pipeline.flush();return result;
 };
 assert.ok(3840*2160*4*2<=limit);
 assert.equal(await run(3840,2160),0);
 assert.ok(4096*2160*4*2>limit);
 assert.equal(await run(4096,2160),2);
});

test('bounded tracking remains fail-closed and displays the retained number as a lower bound',()=>{
 const evidence=fresh();
 for(let id=1;id<=4097;id++)evidence.accept(fact(id));
 const summary=evidence.summary();
 assert.equal(summary.observedCount,4096);assert.equal(summary.overflow,true);
 assert.equal(canStopSharing(completion(summary.observedCount!)),false);
 const outcome=scanMonitorOutcome({expected:1,currentRunRead:1,unresolvedCount:0,droppedFrames:summary.observedCount!,hasInput:true},{busy:false,sharing:false});
 assert.match(outcome.detail,/놓친 화면 4096개 이상/);
});
