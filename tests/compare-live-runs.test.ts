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
