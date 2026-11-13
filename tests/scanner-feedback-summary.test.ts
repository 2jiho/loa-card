import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createScannerFeedback} from '../src/features/card-scanner/ui/scanner-feedback';
import {feedbackReceiptDiagnostic} from '../src/features/card-scanner/session/scanner-feedback-summary';

function actualStats(){
  let now=1;const feedback=createScannerFeedback({now:()=>now});
  feedback.viewport(2);
  const grid={located:false,cells:Array.from({length:40},()=>({status:'unknown' as const})),liveTracking:true,liveTop:2};
  feedback.grid(grid,[]);const snapshot={grid};now=2;feedback.publish(snapshot,grid);
  const bindings=feedback.bindings(snapshot);assert.equal(bindings.length,1);
  now=5;assert.equal(feedback.acknowledge(snapshot,bindings[0]),true);feedback.commitDone(snapshot);
  return feedback.stats();
}
const invalid={feedbackReceiptsUnavailable:'invalid-or-over-limit'};

test('feedback summary keeps cumulative receipts and the shared partial sample window without source data',()=>{
  const stats=actualStats(),result=feedbackReceiptDiagnostic({feedbackReceipts:()=>stats});
  assert.ok(result.feedbackReceipts);assert.equal(result.feedbackReceipts.collection,'finish-entry-snapshot-late-layout-receipts-may-be-absent');
  assert.equal(result.feedbackReceipts.coverage,'partial-eligible-owned-bindings-only');
  assert.equal(result.feedbackReceipts.sampleCount,1);
  assert.deepEqual(result.feedbackReceipts.byKind.viewport,{offeredValidFacts:1,receipts:1,samples:1,
    factToReceipt:{p50Ms:4,p95Ms:4,maxMs:4},publicationToReceipt:{p50Ms:3,p95Ms:3,maxMs:3}});
  assert.deepEqual(result.feedbackReceipts.byKind['read-task-end'].factToReceipt,{p50Ms:null,p95Ms:null,maxMs:null});
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength<8192);
  assert.doesNotMatch(JSON.stringify(result),/captureTime|sessionId|observationId|atMs|data:image/);
});

test('nonfinite values, scope changes, oversized structures and inconsistent sample windows are unavailable',()=>{
  const badCases=[
    (stats:ReturnType<typeof actualStats>)=>({...stats,metadataBytes:Infinity}),
    (stats:ReturnType<typeof actualStats>)=>({...stats,boundary:'screen paint'}),
    (stats:ReturnType<typeof actualStats>)=>({...stats,sampleCount:2049}),
    (stats:ReturnType<typeof actualStats>)=>({...stats,sampleCount:2}),
    (stats:ReturnType<typeof actualStats>)=>({...stats,limits:{...stats.limits,samples:0}}),
    (stats:ReturnType<typeof actualStats>)=>({...stats,counters:{...stats.counters,acknowledgements:0}}),
    (stats:ReturnType<typeof actualStats>)=>({...stats,counters:Object.fromEntries(Array.from({length:129},(_,i)=>['extra'+i,i]))}),
    (stats:ReturnType<typeof actualStats>)=>({...stats,adapter:{...stats.adapter,metadataBytes:16385}}),
    (stats:ReturnType<typeof actualStats>)=>({...stats,byKind:{...stats.byKind,viewport:{...stats.byKind.viewport,factToReceipt:{p50Ms:null,p95Ms:null,maxMs:null}}}}),
  ];
  for(const mutate of badCases)assert.deepEqual(feedbackReceiptDiagnostic({feedbackReceipts:()=>mutate(actualStats())}),invalid);
  const extended={...actualStats(),privateSource:{sessionId:'must-not-export'},atMs:123};
  const result=feedbackReceiptDiagnostic({feedbackReceipts:()=>extended});
  assert.ok(result.feedbackReceipts);assert.doesNotMatch(JSON.stringify(result),/must-not-export|privateSource|atMs/);
});
