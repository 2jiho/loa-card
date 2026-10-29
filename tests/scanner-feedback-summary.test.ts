import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createScannerFeedback} from '../src/features/card-scanner/scanner-feedback';
import {feedbackReceiptDiagnostic} from '../src/features/card-scanner/scanner-feedback-summary';
import {beginReproduction,loadSessionDiagnosticSummary} from '../src/features/card-scanner/scan-reproduction';
import {createReproductionSessionStore,SessionStorageLimitError} from '../src/features/card-scanner/reproduction-session-store';
import type {ReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';

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

test('missing optional getter leaves ordinary diagnostics unchanged and finish snapshots exactly once',async()=>{
  assert.deepEqual(feedbackReceiptDiagnostic({}),{});
  const ordinary=beginReproduction([],{browser:'test',catalog:'test',build:'test'});
  await ordinary.finish(undefined,false);assert.equal((await loadSessionDiagnosticSummary(ordinary.id))?.performance,undefined);
  let calls=0;const stats=actualStats();
  const capture=beginReproduction([],{browser:'test',catalog:'test',build:'test'}, {feedbackReceipts:()=>{calls++;return stats;}});
  const first=capture.finish(undefined,false),again=capture.finish(undefined,false);
  assert.equal(first,again);await first;assert.equal(calls,1);
  const stored=await loadSessionDiagnosticSummary(capture.id);
  assert.equal(stored?.performance?.feedbackReceipts?.byKind.viewport.receipts,1);
  assert.equal(stored?.completed,false);assert.deepEqual(stored?.images,[]);
});

test('throwing or accessor getters and malformed metrics are nonfatal and do not evaluate accessors',async()=>{
  let called=0;
  const accessor=Object.defineProperty({},'feedbackReceipts',{enumerable:true,get(){called++;throw Error('must not evaluate');}});
  assert.deepEqual(feedbackReceiptDiagnostic(accessor),invalid);assert.equal(called,0);
  assert.deepEqual(feedbackReceiptDiagnostic(Object.create({feedbackReceipts:()=>actualStats()})),invalid);
  assert.deepEqual(feedbackReceiptDiagnostic({feedbackReceipts:()=>{throw Error('unavailable');}}),invalid);
  const bad=structuredClone(actualStats());Object.defineProperty(bad.byKind.viewport,'samples',{enumerable:true,get(){called++;return 1;}});
  assert.deepEqual(feedbackReceiptDiagnostic({feedbackReceipts:()=>bad}),invalid);assert.equal(called,0);
  const capture=beginReproduction([],{browser:'test',catalog:'test',build:'test'}, {feedbackReceipts:()=>{throw Error('probe broke');}});
  await capture.finish(undefined,true);
  const stored=await loadSessionDiagnosticSummary(capture.id);
  assert.equal(stored?.performance?.feedbackReceiptsUnavailable,'invalid-or-over-limit');assert.equal(stored?.completed,true);
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

test('summary storage pressure omits optional feedback before losing the existing result or field evidence',async()=>{
  const underlying=createReproductionSessionStore();let attempted=0;
  const store:ReproductionSessionStore={...underlying,async sealSession(id,value){
    attempted++;
    if((value.summary as {performance?:{feedbackReceipts?:unknown}})?.performance?.feedbackReceipts)
      throw new SessionStorageLimitError('capacity');
    return underlying.sealSession(id,value);
  }};
  const image='data:image/png;base64,AAAA';
  const state={status:'확인 필요',expected:1,currentRunRead:0,unidentified:[],
    cards:[{id:'1',name:'카드',awakening:0,extraCopies:null,review:['장수 확인'],image,time:1}],
    pendingFields:[{id:'1',name:'카드',time:1,captureOrder:1,reason:'장수 확인',image,recognitionImage:image}]} as never;
  const capture=beginReproduction([],{browser:'test',catalog:'test',build:'test'}, {store,feedbackReceipts:()=>actualStats()});
  await capture.finish(state,true);
  const session=await underlying.getSession(capture.id),summary=session?.summary as {completed:boolean;images:{image:string}[];
    result:{cards:{extraCopies:number|null}[]};fieldIssues:{reason:string}[];performance:Record<string,unknown>};
  assert.equal(attempted,2);assert.equal(summary.completed,true);assert.equal(summary.images[0].image,image);
  assert.equal(summary.result.cards[0].extraCopies,null);assert.equal(summary.fieldIssues[0].reason,'장수 확인');
  assert.equal(summary.performance.feedbackReceipts,undefined);assert.equal(summary.performance.feedbackReceiptsUnavailable,'invalid-or-over-limit');
});
