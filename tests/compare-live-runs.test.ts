import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareLiveRuns} from '../scripts/compare-live-runs.mjs';
function run(){return {validation:{mode:'live',completed:true,sourceChanged:false,
  sourceStart:{sourceDigest:'a'.repeat(64)},sourceEnd:{sourceDigest:'a'.repeat(64)},
  input:[{index:0,bytes:10,sha256:'b'.repeat(64)}],startedWithCards:0,captureOnly:false,
  recordingEnabled:false,browser:'test',hardwareConcurrency:4,visibility:{everHidden:false}},
  runtimeConfiguration:{readers:2},performance:{elapsedMs:100,inputPipeline:{offered:5,processed:3,replaced:2}},
  diagnosticSummary:{unresolvedFieldChanges:0},
  result:{expected:1,read:1,unidentified:0,experience:0,cards:[{id:'1',name:'카드',awakening:0,extraCopies:0,review:[]}]}};}
test('same source can expose different collection coverage without calling it a speed win',()=>{
  const a=run(),b=run();b.result.cards=[];b.result.read=0;b.performance.elapsedMs=20;
  const r=compareLiveRuns(a,b);assert.equal(r.sameSource,true);assert.deepEqual(r.contextDifferences,[]);
  assert.equal(r.before.completeInventory,true);assert.equal(r.after.completeInventory,false);
  assert.equal(r.resultComparison.exactSame,false);assert.equal(r.before.workerMs,null);
});
test('records input, recording and visibility differences',()=>{
  const a=run(),b=run();b.validation.input[0].sha256='c'.repeat(64);b.validation.recordingEnabled=true;b.validation.visibility.everHidden=true;
  assert.deepEqual(compareLiveRuns(a,b).contextDifferences,['input','recording','visibility']);
});
test('separates fast-lane experiment requests from dispatch evidence and missing history',()=>{
  const a=run() as any,b=run() as any;
  a.validation.fastOcrAssistRequested=false;b.validation.fastOcrAssistRequested=true;
  b.performance.fastOcrAssist={requested:true,dispatches:1,settled:1,wallMs:12};
  const result=compareLiveRuns(a,b);
  assert.ok(result.contextDifferences.includes('fastOcrAssistRequested'));
  assert.equal(result.before.fastOcrAssist.requested,false);
  assert.equal(result.after.fastOcrAssist.evidence.dispatches,1);
  delete a.validation.fastOcrAssistRequested;
  assert.equal(compareLiveRuns(a,b).before.fastOcrAssist.requestStatus,'unknown');
  a.validation.fastOcrAssistRequested=false;a.performance.fastOcrAssist={requested:true,dispatches:1};
  assert.equal(compareLiveRuns(a,b).before.fastOcrAssist.consistency,'conflict');
});
test('rejects changing source and prefilled baselines',()=>{
  const a=run(),b=run();b.validation.sourceChanged=true;assert.throws(()=>compareLiveRuns(a,b),/source/);
  b.validation.sourceChanged=false;b.validation.startedWithCards=1;assert.throws(()=>compareLiveRuns(a,b),/empty-list/);
});
test('playback transport controls cannot be ranked as scanner speed gains',()=>{
  const control=run();control.validation.mode='playback-only';control.performance.elapsedMs=1;
  assert.throws(()=>compareLiveRuns(run(),control),/completed live run/);
  assert.throws(()=>compareLiveRuns(control,run()),/completed live run/);
});
test('count match alone cannot certify complete inventory',()=>{
  const a=run();a.diagnosticSummary.unresolvedFieldChanges=1;
  assert.equal(compareLiveRuns(a,run()).before.completeInventory,false);
});
test('separates media input end from recovery work without inventing missing measurements',()=>{
  const a=run(),b=run();
  Object.assign(a.performance,{liveTiming:{inputFinishedMs:60},recovery:{frames:2,acquisitionMs:30,readMs:50}});
  const result=compareLiveRuns(a,b);
  assert.equal(result.before.afterInputFinishedMs,40);
  assert.equal(result.before.recoveryAcquisitionMs,30);
  assert.equal(result.before.recoveryReadMs,50);
  assert.equal(result.after.afterInputFinishedMs,null);
  assert.equal(result.after.recoveryFrames,null);
});
test('invalid or reversed input clocks remain unmeasured',()=>{
  for(const inputFinishedMs of [101,-1,NaN,Infinity,null,'60']) {
    const a=run();Object.assign(a.performance,{liveTiming:{inputFinishedMs}});
    assert.equal(compareLiveRuns(a,run()).before.afterInputFinishedMs,null);
  }
  const a=run();Object.assign(a.performance,{liveTiming:{inputFinishedMs:100},recovery:{frames:0,acquisitionMs:0,readMs:0}});
  assert.equal(compareLiveRuns(a,run()).before.afterInputFinishedMs,0);
  assert.equal(compareLiveRuns(a,run()).before.recoveryFrames,0);
});

test('last identified card timing uses only scanner clocks and never certifies completion',()=>{
  const a=run();Object.assign(a.performance,{finishTiming:{lastCardInputMs:20,finishedMs:90,afterLastCardMs:1,withinTarget:true}});
  a.diagnosticSummary.unresolvedFieldChanges=1;
  const result=compareLiveRuns(a,run());
  assert.equal(result.before.afterLastIdentifiedCardMs,70);
  assert.equal(result.before.completeInventory,false);
  assert.equal(result.after.afterLastIdentifiedCardMs,null);
  for(const lastCardInputMs of [91,-1,NaN,Infinity,null,'20']) {
    Object.assign(a.performance,{finishTiming:{lastCardInputMs,finishedMs:90}});
    assert.equal(compareLiveRuns(a,run()).before.afterLastIdentifiedCardMs,null);
  }
});

test('auto-stop delay and remaining processing use scanner clock without inferring an unrecorded stop',()=>{
  const a=run();Object.assign(a.performance,{finishTiming:{lastCardInputMs:20,autoStoppedMs:70,finishedMs:90}});
  const result=compareLiveRuns(a,run());
  assert.equal(result.before.afterLastIdentifiedToAutoStopMs,50);
  assert.equal(result.before.afterAutoStopMs,20);
  assert.equal(result.after.afterLastIdentifiedToAutoStopMs,null);
  assert.equal(result.after.afterAutoStopMs,null);
  Object.assign(a.performance,{finishTiming:{lastCardInputMs:20,autoStoppedMs:100,finishedMs:90}});
  assert.equal(compareLiveRuns(a,run()).before.afterAutoStopMs,null);
});

test('feedback with no receipts cannot report zero latency or borrow React commit timing',()=>{
  const a=run();Object.assign(a.performance,{monitorPresentation:{p95Ms:2},feedbackReceipts:{byKind:{
    'crop-queued':{samples:0,offeredValidFacts:100,receipts:0,factToReceipt:{p95Ms:0}},
  }}});
  const feedback=compareLiveRuns(a,run()).before.feedback;
  assert.deepEqual(feedback['crop-queued'],{status:'unmeasured',samples:0,offered:100,receipts:0,
    factToReceiptP95Ms:null,publicationToReceiptP95Ms:null});
  assert.equal(feedback['read-task-end'].status,'missing');
});

test('feedback stages retain separate bounded samples and partial coverage',()=>{
  const a=run();Object.assign(a.performance,{feedbackReceipts:{byKind:{
    viewport:{samples:2,offeredValidFacts:20,receipts:4,factToReceipt:{p95Ms:150},publicationToReceipt:{p95Ms:5}},
    'read-task-end':{samples:1,offeredValidFacts:30,receipts:1,factToReceipt:{p95Ms:40}},
  }}});
  const feedback=compareLiveRuns(a,run()).before.feedback;
  assert.equal(feedback.viewport.status,'partial');assert.equal(feedback.viewport.factToReceiptP95Ms,150);
  assert.equal(feedback['read-task-end'].factToReceiptP95Ms,40);
  assert.equal(feedback['read-task-start'].factToReceiptP95Ms,null);
  for(const samples of [-1,0.5,NaN,'2']){
    Object.assign(a.performance,{feedbackReceipts:{byKind:{viewport:{samples,factToReceipt:{p95Ms:1}}}}});
    assert.equal(compareLiveRuns(a,run()).before.feedback.viewport.factToReceiptP95Ms,null);
  }
});

test('구 보고서의 게이트 요청과 입력 종류는 미설정이 아니라 알 수 없음이다',()=>{
  const result=compareLiveRuns(run(),run());
  assert.equal(result.before.latestPixelGate.requested,null);assert.equal(result.before.latestPixelGate.requestStatus,'unknown');
  assert.equal(result.before.latestPixelGate.evidence.status,'unknown');
  assert.ok(result.missingContext.includes('latestPixelGateRequested'));
  assert.ok(result.missingContext.includes('inputKind'));assert.ok(result.missingContext.includes('cropRecordingRequested'));
  assert.ok(result.missingContext.includes('obstructionFenceRequested'));assert.equal(result.before.obstructionFence.requestStatus,'unknown');
});
test('관측 근거 정책 차이와 구 보고서의 미기록을 구분한다',()=>{
  const a=run() as any,b=run() as any;
  a.validation.freshnessVersion=1;b.validation.freshnessVersion=2;
  const changed=compareLiveRuns(a,b);
  assert.ok(changed.contextDifferences.includes('freshnessVersion'));
  assert.equal(changed.before.freshnessVersion,1);assert.equal(changed.after.freshnessVersion,2);
  for(const missing of [undefined,null,0,3,'1']){
    a.validation.freshnessVersion=missing;b.validation.freshnessVersion=missing;
    const unknown=compareLiveRuns(a,b);
    assert.equal(unknown.before.freshnessVersion,null);
    assert.ok(unknown.missingContext.includes('freshnessVersion'));
  }
});
test('가림 실험 요청과 재생 지원 여부는 구 보고서 불명과 구별한다',()=>{
  const a=run() as any,b=run() as any;a.validation.obstructionFenceRequested=false;b.validation.obstructionFenceRequested=true;
  b.validation.obstructionStateReplay='unsupported';b.performance.obstructionExperiment={notices:2,pending:1,replaySupported:false};
  const result=compareLiveRuns(a,b);assert.ok(result.contextDifferences.includes('obstructionFenceRequested'));
  assert.equal(result.before.obstructionFence.requested,false);assert.equal(result.after.obstructionFence.requested,true);
  assert.equal(result.after.obstructionFence.stateReplay,'unsupported');assert.equal(result.after.obstructionFence.evidence.pending,1);
});
test('거절 이미지 전송 실험의 명시적 요청과 구 보고서의 미기록을 구분한다',()=>{
 const a=run() as any,b=run() as any;
 a.validation.rejectedTransportRequested=false;b.validation.rejectedTransportRequested=true;
 b.runtimeConfiguration.rejectedTransportRequested=true;
 const changed=compareLiveRuns(a,b);
 assert.ok(changed.contextDifferences.includes('rejectedTransportRequested'));
 assert.deepEqual(changed.after.rejectedTransport,{requestStatus:'recorded',requested:true});
 delete a.validation.rejectedTransportRequested;
 const unknown=compareLiveRuns(a,b);
 assert.ok(unknown.missingContext.includes('rejectedTransportRequested'));
 assert.equal(unknown.before.rejectedTransport.requestStatus,'unknown');
 b.runtimeConfiguration.rejectedTransportRequested=false;
 assert.equal(compareLiveRuns(a,b).after.rejectedTransport.requestStatus,'conflict');
});
test('요청·계측·영상 입력을 구분하고 없는 계측을 비활성으로 단정하지 않는다',()=>{
  const a=run() as any,b=run() as any;
  for(const item of [a,b]){item.validation.scheduling='paced-native-video-screen-loop';item.validation.input[0].type='video/mp4';item.cropEvidence=null;}
  a.validation.latestPixelGateRequested=false;b.validation.latestPixelGateRequested=true;
  b.runtimeConfiguration.latestPixelGateRequested=true;
  b.performance.completionPixelGate={referenceSamples:10,currentSamples:1,matches:0,mismatches:1,unavailable:0};
  const result=compareLiveRuns(a,b);
  assert.ok(result.contextDifferences.includes('latestPixelGateRequested'));
  assert.ok(!result.missingContext.includes('inputKind'));assert.equal(result.before.inputKind,'video-capture-stream');
  assert.equal(result.before.cropRecordingRequested,false);assert.equal(result.before.latestPixelGate.requested,false);
  assert.equal(result.before.latestPixelGate.evidence.status,'unknown');
  assert.equal(result.after.latestPixelGate.requested,true);
  assert.equal(result.after.latestPixelGate.evidence.status,'instrumentation-observed');
  assert.equal(result.after.latestPixelGate.evidence.mismatches,1);
  assert.equal(result.after.latestPixelGate.consistency,'unproven');
});
test('설정 충돌·잘못된 값·계측 모순은 성공으로 표현하지 않는다',()=>{
  const a=run() as any,b=run() as any;
  a.validation.latestPixelGateRequested=true;a.runtimeConfiguration.latestPixelGateRequested=false;
  assert.equal(compareLiveRuns(a,b).before.latestPixelGate.requestStatus,'conflict');
  a.validation.latestPixelGateRequested='false';delete a.runtimeConfiguration.latestPixelGateRequested;
  assert.equal(compareLiveRuns(a,b).before.latestPixelGate.requestStatus,'invalid');
  a.validation.latestPixelGateRequested=false;a.performance.completionPixelGate={referenceSamples:0,currentSamples:0,matches:0,mismatches:0,unavailable:0};
  assert.equal(compareLiveRuns(a,b).before.latestPixelGate.consistency,'conflict');
  a.performance.completionPixelGate.currentSamples=-1;
  assert.equal(compareLiveRuns(a,b).before.latestPixelGate.evidence.status,'invalid');
});
test('이미지나 불명 입력은 video captureStream으로 분류하지 않는다',()=>{
  const a=run() as any,b=run() as any;a.validation.scheduling='paced-native-video-screen-loop';a.validation.input[0].type='image/png';
  b.validation.scheduling='unrecorded-screen-share';b.validation.input[0].type='video/mp4';
  const result=compareLiveRuns(a,b);assert.ok(result.missingContext.includes('inputKind'));assert.equal(result.before.inputKind,null);assert.equal(result.after.inputKind,null);
});
