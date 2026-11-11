import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CompletionInputDiagnostic} from '../src/features/card-scanner/session/completion-input-diagnostic';
import {createLiveInputAdmission} from '../src/features/card-scanner/capture/live-input-admission';
import {createLiveCapturePipeline,type LiveCaptureDecision} from '../src/features/card-scanner/capture/live-capture-pipeline';

test('a cadence or capacity skip after a complete acquisition remains visible as unproven newer input',()=>{
 for(const reason of ['cadence','source-capacity'] as const){
  const diagnostic=new CompletionInputDiagnostic(),admission=createLiveInputAdmission();
  const gates={capturing:true,checkingCompletion:false,minIntervalMs:100};
  const first=admission.stamp(1,1),chosen=admission.consider(first,gates);
  assert.equal(chosen.kind,'freeze');diagnostic.consider(chosen,0);
  admission.frozen(first,{succeeded:true,freezeMs:1});diagnostic.finish(first,true);
  const second=admission.stamp(2,2),skipped=admission.consider(second,{...gates,...(reason==='source-capacity'?{sourceCapacity:false}:{})});
  assert.equal(skipped.kind,'skip');diagnostic.consider(skipped,0);
  const report=diagnostic.snapshot();
  assert.equal(report.skipped[reason],1);assert.equal(report.newerDeliveredInput,true);
  assert.equal(report.lastSkippedInputId[reason],2);assert.equal(report.skippedAfterLastCompletion[reason],true);
  assert.equal(report.lastCompleted?.inputId,1);assert.equal(report.lastArrival?.inputId,2);
  assert.equal(report.freshness,'unproven');assert.equal(report.individualHistory,'not-recorded');
 }
});

test('successful later acquisition clears only the metadata lag, not unknown source frames or proof',()=>{
 const diagnostic=new CompletionInputDiagnostic();
 const first={inputId:1,captureTime:1,observedAtMs:1000},second={inputId:2,captureTime:2,observedAtMs:2000};
 diagnostic.consider({kind:'freeze',stamp:first},2);diagnostic.finish(first,true);
 diagnostic.consider({kind:'freeze',stamp:second},undefined);diagnostic.finish(second,true);
 const report=diagnostic.snapshot();
 assert.equal(report.newerDeliveredInput,false);assert.equal(report.sourceCallbackMissed,2);
 assert.deepEqual(report.skippedAfterLastCompletion,{ended:false,verification:false,'source-capacity':false,cadence:false});
 assert.equal(report.sourceClockUnknown,1);assert.equal(report.freshness,'unproven');
});

test('gaps, reversed time and stale or unlinked completions are reported without replacing latest evidence',()=>{
 const diagnostic=new CompletionInputDiagnostic();
 const first={inputId:1,captureTime:1,observedAtMs:1000},third={inputId:3,captureTime:0,observedAtMs:900};
 diagnostic.consider({kind:'freeze',stamp:first},0);diagnostic.finish(first,true);
 diagnostic.consider({kind:'freeze',stamp:third},0);diagnostic.finish(third,true);
 diagnostic.finish(first,true);diagnostic.finish({inputId:4,captureTime:4,observedAtMs:4000},true);
 diagnostic.finish({...third,captureTime:10},true);
 diagnostic.finish(third,false);
 const report=diagnostic.snapshot();
 assert.equal(report.missingArrivalIds,1);assert.equal(report.clockErrors,1);assert.equal(report.orderErrors,3);
 assert.equal(report.newerDeliveredInput,null);
 assert.deepEqual(report.skippedAfterLastCompletion,{ended:null,verification:null,'source-capacity':null,cadence:null});
 assert.equal(report.failedAcquisitions,1);assert.equal(report.lastCompleted?.inputId,3);
});

test('skip comparisons use input ID even if an earlier acquisition finishes later',()=>{
 const diagnostic=new CompletionInputDiagnostic();
 const first={inputId:1,captureTime:1,observedAtMs:1000},second={inputId:2,captureTime:2,observedAtMs:2000},third={inputId:3,captureTime:3,observedAtMs:3000};
 diagnostic.consider({kind:'freeze',stamp:first},0);
 diagnostic.consider({kind:'skip',reason:'cadence',stamp:second},0);
 diagnostic.consider({kind:'freeze',stamp:third},0);
 diagnostic.finish(first,true);
 assert.equal(diagnostic.snapshot().skippedAfterLastCompletion.cadence,true);
 diagnostic.finish(third,true);
 const report=diagnostic.snapshot();
 assert.equal(report.lastSkippedInputId.cadence,2);
 assert.equal(report.skippedAfterLastCompletion.cadence,false);
});

test('no callbacks and no linked acquisition remain explicitly unknown',()=>{
 const diagnostic=new CompletionInputDiagnostic();
 assert.equal(diagnostic.snapshot().newerDeliveredInput,null);
 diagnostic.consider({kind:'freeze',stamp:{inputId:1,captureTime:0,observedAtMs:0}},undefined);
 assert.equal(diagnostic.snapshot().lastCompleted,null);
 assert.equal(diagnostic.snapshot().newerDeliveredInput,null);
 assert.deepEqual(diagnostic.snapshot().skippedAfterLastCompletion,{ended:null,verification:null,'source-capacity':null,cadence:null});
});

test('the bounded snapshot survives JSON serialization without pixels or individual input history',()=>{
 const diagnostic=new CompletionInputDiagnostic();
 const stamp={inputId:1,captureTime:1,observedAtMs:1};
 diagnostic.consider({kind:'skip',reason:'cadence',stamp},undefined);
 const snapshot=diagnostic.snapshot();
 assert.deepEqual(JSON.parse(JSON.stringify(snapshot)),snapshot);
 assert.equal(snapshot.scope,'delivered-input-only');
 assert.equal(snapshot.individualHistory,'not-recorded');
 assert.equal('pixels' in snapshot,false);
});

test('actual pipeline distinguishes replacement and capacity loss using capture order, not release time',async()=>{
 const diagnostic=new CompletionInputDiagnostic();let resume!:()=>void;let now=0;
 const wait=new Promise<void>(resolve=>{resume=resolve;});
 const pipeline=createLiveCapturePipeline<{id:number;bytes:number}>({maxPendingFrames:1,maxRetainedBytes:2,
  frameBytes:frame=>frame.bytes,now:()=>++now,yieldTask:()=>wait,
  consume:frame=>diagnostic.finish({inputId:frame.id,captureTime:frame.id,observedAtMs:frame.id},true),
  release(){},onError(error){throw error;},onRecordError(){diagnostic.pipelineRecordError();},
  onDecision:event=>diagnostic.pipelineDecision(event)});
 const offer=(id:number,bytes=1)=>{const stamp={inputId:id,captureTime:id,observedAtMs:id};
  diagnostic.consider({kind:'freeze',stamp},0);pipeline.offer({id,bytes},id,stamp);};
 offer(1);offer(2);offer(3,3);
 resume();await pipeline.flush();
 const {pipeline:report}=diagnostic.snapshot();
 assert.equal(report.errors,0);assert.equal(report.open,0);
 assert.equal(report.losses.replaced,1);assert.equal(report.losses.capacity,1);
 assert.equal(report.lossesAfterLastCompletion.replaced,false);
 assert.equal(report.lossesAfterLastCompletion.capacity,true);
 assert.equal(report.releaseFailures,0);
});

test('release failure is separate from normal release and makes no freshness claim',async()=>{
 const diagnostic=new CompletionInputDiagnostic();let now=0;let failed=0;
 const stamp={inputId:1,captureTime:1,observedAtMs:1};diagnostic.consider({kind:'freeze',stamp},0);
 let pendingResult:boolean|null|undefined;
 const pipeline=createLiveCapturePipeline({now:()=>++now,yieldTask:async()=>{},
  consume:()=>{diagnostic.finish(stamp,true);pendingResult=diagnostic.snapshot().pipeline.releaseFailureAtOrAfterLastAcquisition;},release(){throw Error('release failed');},onError(){failed++;},
  onRecordError(){diagnostic.pipelineRecordError();},onDecision:event=>diagnostic.pipelineDecision(event)});
 pipeline.offer({},1,stamp);await pipeline.flush();
 const report=diagnostic.snapshot();
 assert.equal(failed,1);assert.equal(report.pipeline.releaseFailures,1);
 assert.equal(report.pipeline.lastReleaseFailureInputId,1);
 assert.equal(pendingResult,null);assert.equal(report.pipeline.releaseFailureAtOrAfterLastAcquisition,true);
 assert.equal(report.pipeline.losses.error,0);assert.equal(report.freshness,'unproven');
});

test('reentrant release failure preserves nested loss ordering and counts each frame once',async()=>{
 const diagnostic=new CompletionInputDiagnostic();let resume!:()=>void;let now=0,failed=0;
 const wait=new Promise<void>(resolve=>{resume=resolve;});
 const pipeline=createLiveCapturePipeline<{id:number}>({maxPendingFrames:2,now:()=>++now,yieldTask:()=>wait,
  consume(){},release(frame){if(frame.id===2)throw Error('release failed');},onError(){failed++;},
  onRecordError(){diagnostic.pipelineRecordError();},onDecision:event=>diagnostic.pipelineDecision(event)});
 for(let id=1;id<=3;id++){
  const stamp={inputId:id,captureTime:id,observedAtMs:id};
  diagnostic.consider({kind:'freeze',stamp},0);pipeline.offer({id},id,stamp);
 }
 resume();await pipeline.flush();
 const {pipeline:report}=diagnostic.snapshot();
 assert.equal(failed,1);assert.equal(report.errors,0);assert.equal(report.open,0);
 assert.equal(report.losses.replaced,1);assert.equal(report.losses.error,2);
 assert.equal(report.releaseFailures,1);assert.equal(report.lastReleaseFailureInputId,2);
 assert.equal(report.lossesAfterLastCompletion.error,null,'no acquisition was proved');
});

test('missing or malformed pipeline facts make loss comparisons unknown',()=>{
 const diagnostic=new CompletionInputDiagnostic();
 const stamp={inputId:1,captureTime:1,observedAtMs:1};diagnostic.consider({kind:'freeze',stamp},0);diagnostic.finish(stamp,true);
 assert.equal(diagnostic.snapshot().pipeline.lossesAfterLastCompletion.capacity,null);
 diagnostic.pipelineDecision({version:2,kind:'offered',seq:2,atMs:1,inputId:1,captureTime:1,observedAtMs:1,
  selection:null,estimatedBytes:1,maxPendingFrames:1,maxRetainedBytes:1} as LiveCaptureDecision);
 diagnostic.pipelineRecordError();
 const report=diagnostic.snapshot();
 assert.equal(report.pipeline.errors,2);assert.equal(report.pipeline.lossesAfterLastCompletion.capacity,null);
 assert.equal(report.pipeline.releaseFailureAtOrAfterLastAcquisition,null);
});

test('a replacement awaiting its release fact cannot be reported as no loss',()=>{
 const diagnostic=new CompletionInputDiagnostic();let seq=0;
 const send=(value:object)=>diagnostic.pipelineDecision({version:2,seq:++seq,atMs:seq,...value} as LiveCaptureDecision);
 const offer=(id:number)=>{const stamp={inputId:id,captureTime:id,observedAtMs:id};
  diagnostic.consider({kind:'freeze',stamp},0);send({kind:'offered',...stamp,selection:null,estimatedBytes:1,maxPendingFrames:2,maxRetainedBytes:4});return stamp;};
 const first=offer(1);send({kind:'started',inputId:1,captureTime:1});diagnostic.finish(first,true);
 send({kind:'finished',inputId:1,captureTime:1,outcome:'completed'});send({kind:'released',inputId:1,captureTime:1,reason:'normal',failed:false});
 offer(2);offer(3);send({kind:'replaced',oldInputId:2,newInputId:3});
 assert.equal(diagnostic.snapshot().pipeline.missingRelease,true);
 assert.equal(diagnostic.snapshot().pipeline.lossesAfterLastCompletion.replaced,null);
 send({kind:'released',inputId:2,captureTime:2,reason:'replaced',failed:false});
 assert.equal(diagnostic.snapshot().pipeline.missingRelease,false);
 assert.equal(diagnostic.snapshot().pipeline.lossesAfterLastCompletion.replaced,true);
});

test('event timestamp earlier than its input arrival is not reliable evidence',()=>{
 const diagnostic=new CompletionInputDiagnostic();const stamp={inputId:1,captureTime:1,observedAtMs:10};
 diagnostic.consider({kind:'freeze',stamp},0);diagnostic.finish(stamp,true);
 diagnostic.pipelineDecision({version:2,kind:'offered',seq:1,atMs:9,...stamp,
  selection:null,estimatedBytes:1,maxPendingFrames:1,maxRetainedBytes:1});
 assert.equal(diagnostic.snapshot().pipeline.errors,1);
 assert.equal(diagnostic.snapshot().pipeline.lossesAfterLastCompletion.capacity,null);
});
