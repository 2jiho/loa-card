/** Model-free regression coverage for bounded fact/publication/DOM-target receipts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeedbackFactReceipts,FEEDBACK_RECEIPT_CAPS} from '../src/features/card-scanner/scanner-feedback-receipts';
import type {FeedbackFact,FeedbackFactHandle,FeedbackPublication,FeedbackSurface} from '../src/features/card-scanner/scanner-feedback-receipts';

const input=(id=1):FeedbackFact=>({id,kind:'read-task-end',source:{sessionId:'session-1',frameId:id,observationId:`observation-${id}`,
  captureOrder:id,captureTime:40_000+id,phase:'input',slot:2},
  processingFrame:id+100,previewSampleId:null,attemptId:1,atMs:0,target:{kind:'slot',key:'row-3-slot-2',status:'read'}});
function fixture(limits?:{pending?:number;metadataBytes?:number;samples?:number},signal?:AbortSignal){
  let now=200;
  const bridge=createFeedbackFactReceipts<object>({now:()=>now,limits,signal});
  const record=(value=input())=>{const handle=bridge.recordFact(value);assert.ok(handle);return handle;};
  const publish=(fact:FeedbackFactHandle,snapshot:object={},publicationId=1,surface:FeedbackSurface='inventory-grid')=>{
    const target=bridge.getFact(fact)!.target;
    const publication=bridge.acceptPublication({accepted:true,snapshot,publicationId,bindings:[{fact,surface,target}]});
    assert.ok(publication);return {snapshot,publication,fact,surface,target,join:bridge.getFact(fact)!};
  };
  return {bridge,record,publish,at(value:number){now=value;}};
}

test('fact-to-target receipt includes upstream 200ms, with separate publication timing',()=>{
  const {bridge,record,publish,at}=fixture();const fact=record();at(220);const receipt=publish(fact);
  at(250);assert.equal(bridge.acknowledge(receipt),true);
  const stats=bridge.stats();assert.equal(stats.factToReceipt.p95Ms,250);assert.equal(stats.publicationToReceipt.p95Ms,30);
  assert.equal(stats.coverage,'partial-eligible-owned-bindings-only');assert.match(stats.verification,/dom-validation-external-no-paint/);
  assert.equal(stats.sampleCount,1);bridge.closePublication(receipt.publication,'committed');
  assert.equal(bridge.stats().pendingFacts,0);assert.equal(bridge.stats().counters.absentTargetReceipts,0);
});

test('hot-path pending usage is a read-only capacity snapshot without clock or receipt effects',()=>{
  let clocks=0;
  const bridge=createFeedbackFactReceipts<object>({now:()=>{clocks++;return 200;}});
  const empty=bridge.pendingUsage();assert.equal(empty.pendingFacts,0);assert.ok(Object.isFrozen(empty));
  assert.equal(clocks,0);
  const handle=bridge.recordFact(input());assert.ok(handle);assert.equal(clocks,1);
  const retained=bridge.pendingUsage();assert.equal(retained.pendingFacts,1);assert.ok(retained.metadataBytes>empty.metadataBytes);
  for(let i=0;i<100;i++)assert.deepEqual(bridge.pendingUsage(),retained);
  assert.equal(clocks,1);assert.equal(bridge.stats().sampleCount,0);assert.equal(bridge.stats().counters.factsOffered,1);
  assert.equal(bridge.discardFacts([handle],'unmatched'),true);
  assert.deepEqual(bridge.pendingUsage(),empty);assert.equal(clocks,1);
});

test('stage distributions share the bounded global window and never mix viewport with card work',()=>{
  const {bridge,record,publish,at}=fixture({samples:2});
  const card=publish(record());at(250);assert.equal(bridge.acknowledge(card),true);bridge.closePublication(card.publication,'committed');
  const viewport=(id:number):FeedbackFact=>({id,kind:'viewport',source:null,processingFrame:null,previewSampleId:id,attemptId:null,
    atMs:250,target:{kind:'scrollbar',key:'preview-1',status:'tracking'}});
  at(260);const first=publish(record(viewport(2)),{},2,'live-scrollbar');at(270);assert.equal(bridge.acknowledge(first),true);bridge.closePublication(first.publication,'committed');
  let stats=bridge.stats();assert.equal(stats.byKind['read-task-end'].samples,1);assert.equal(stats.byKind.viewport.samples,1);
  assert.equal(stats.byKind['read-task-end'].factToReceipt.p95Ms,250);assert.equal(stats.byKind.viewport.factToReceipt.p95Ms,20);
  const second=publish(record(viewport(3)),{},3,'live-scrollbar');at(280);assert.equal(bridge.acknowledge(second),true);bridge.closePublication(second.publication,'committed');
  stats=bridge.stats();assert.equal(stats.sampleCount,2);assert.equal(stats.byKind['read-task-end'].receipts,1);
  assert.equal(stats.byKind['read-task-end'].samples,0);assert.equal(stats.byKind['read-task-end'].factToReceipt.p95Ms,null);
  assert.equal(stats.byKind.viewport.samples,2);assert.ok(stats.metadataBytes<=FEEDBACK_RECEIPT_CAPS.metadataBytes);
  bridge.reset();assert.equal(bridge.stats().byKind.viewport.receipts,0);assert.equal(bridge.stats().byKind.viewport.offeredValidFacts,0);
});

test('same slot and status cannot acknowledge another acquisition frame or old read attempt',()=>{
  const {bridge,record,publish,at}=fixture();const receipt=publish(record());at(230);
  const wrongSource={...receipt.join,source:{...receipt.join.source!,frameId:999}};
  assert.equal(bridge.acknowledge({...receipt,join:wrongSource}),false);
  assert.equal(bridge.acknowledge({...receipt,join:{...receipt.join,attemptId:0}}),false);
  assert.equal(bridge.acknowledge({...receipt,join:{...receipt.join,processingFrame:999}}),false);
  assert.equal(bridge.acknowledge(receipt),true);
  assert.equal(bridge.stats().counters.unmatchedTargets,3);assert.equal(bridge.stats().sampleCount,1);
});

test('every ObservationSource field is part of the exact join; captureTime is not a page clock',()=>{
  const {bridge,record,publish,at}=fixture();const receipt=publish(record());at(240);
  const changes={sessionId:'another-session',frameId:999,observationId:'another-observation',captureOrder:99,captureTime:999_999,phase:'recovery',slot:3};
  for(const [key,value] of Object.entries(changes)){
    assert.equal(bridge.acknowledge({...receipt,join:{...receipt.join,source:{...receipt.join.source!,[key]:value}}}),false);
  }
  // The genuine captureTime (40001) is far beyond page now (240), and remains
  // valid context. Only fact.atMs is used for this page-clock duration.
  assert.equal(bridge.acknowledge(receipt),true);assert.equal(bridge.stats().factToReceipt.p95Ms,240);
});

test('an exact receipt requires owned snapshot, publication, fact, surface and target',()=>{
  const {bridge,record,publish,at}=fixture(),other=fixture();const receipt=publish(record());
  at(240);
  assert.equal(bridge.acknowledge({...receipt,snapshot:{}}),false);
  assert.equal(bridge.acknowledge({...receipt,publication:Object.freeze({}) as FeedbackPublication}),false);
  assert.equal(bridge.acknowledge({...receipt,fact:other.record()}),false);
  assert.equal(bridge.acknowledge({...receipt,surface:'recent-frame-grid'}),false);
  assert.equal(bridge.acknowledge({...receipt,target:{...receipt.target,status:'review'}}),false);
  assert.equal(bridge.acknowledge(receipt),true);assert.equal(bridge.stats().sampleCount,1);
});

test('fact copies are detached and frozen; getter/unknown metadata grants no authority',()=>{
  const {bridge,record}=fixture();const original=structuredClone(input()),handle=record(original),copy=bridge.getFact(handle)!;
  (original.source as {frameId:number}).frameId=999;
  assert.equal(copy.source!.frameId,1);assert.equal(Object.isFrozen(copy),true);
  assert.equal(Object.isFrozen(copy.source),true);assert.equal(Object.isFrozen(copy.target),true);
  let getterCalls=0;const bad={...input(2)};
  Object.defineProperty(bad,'attemptId',{enumerable:true,get(){getterCalls++;return 2;}});
  assert.equal(bridge.recordFact(bad),null);assert.equal(getterCalls,0);
  assert.equal(bridge.recordFact({...input(2),pixels:[]}),null);
  assert.equal(bridge.recordFact({...input(2),source:{...input(2).source!,sessionId:'https://example.test/input'}}),null);
  assert.equal(bridge.stats().counters.rejectedMetadata,3);assert.equal(bridge.stats().sampleCount,0);
});

test('processing frame, preview sample and attempt identities remain separate',()=>{
  const {bridge,record,publish,at}=fixture();
  const preview:FeedbackFact={...input(),kind:'viewport',source:null,processingFrame:null,previewSampleId:77,attemptId:null,atMs:20,target:{kind:'scrollbar',key:'position',status:'tracking'}};
  const handle=record(preview),receipt=publish(handle,{},1,'live-scrollbar');at(230);
  assert.equal(bridge.acknowledge({...receipt,join:{...preview,processingFrame:77}}),false);
  assert.equal(bridge.acknowledge({...receipt,join:{...preview,previewSampleId:78}}),false);
  assert.equal(bridge.acknowledge(receipt),true);
  assert.equal(bridge.recordFact({...input(2),previewSampleId:2}),null);
});

test('queued, task-start and task-end facts retain actual numeric attempt semantics',()=>{
  const {bridge,record}=fixture();
  record({...input(),kind:'crop-queued',attemptId:0,target:{...input().target,status:'waiting'}});
  record({...input(2),kind:'read-task-start',attemptId:1,target:{...input().target,status:'reading'}});
  record({...input(3),kind:'read-task-end',attemptId:0});
  assert.equal(bridge.recordFact({...input(4),kind:'crop-queued',attemptId:1}),null);
  assert.equal(bridge.recordFact({...input(4),kind:'read-task-start',attemptId:0,target:{...input().target,status:'reading'}}),null);
  assert.equal(bridge.recordFact({...input(4),kind:'read-task-start',attemptId:1}),null);
  assert.equal(bridge.recordFact({...input(4),source:null}),null);
});

test('semantic acceptance is explicit and unchanged snapshot cannot acquire newer source facts',()=>{
  const {bridge,record,publish}=fixture();const first=publish(record());
  assert.equal(bridge.acceptPublication({accepted:false,snapshot:{},publicationId:2,bindings:[]}),null);
  const next=record(input(2));
  assert.equal(bridge.acceptPublication({accepted:true,snapshot:first.snapshot,publicationId:2,bindings:[{fact:next,surface:'inventory-grid',target:input(2).target}]}),null);
  bridge.closePublication(first.publication,'committed');
  assert.equal(bridge.acceptPublication({accepted:true,snapshot:first.snapshot,publicationId:2,bindings:[{fact:next,surface:'inventory-grid',target:input(2).target}]}),null);
  assert.equal(bridge.discardFacts([next],'unchanged'),true);
  const stats=bridge.stats();assert.equal(stats.counters.unchangedPublications,2);assert.equal(stats.counters.unchangedFacts,1);
  assert.equal(stats.sampleCount,0);assert.equal(stats.factToReceipt.p95Ms,null);
});

test('a malformed multi-fact publication is rejected atomically without binding its valid prefix',()=>{
  const {bridge,record,publish}=fixture();const first=record(),second=record(input(2)),before=bridge.stats();
  assert.equal(bridge.acceptPublication({accepted:true,snapshot:{},publicationId:1,bindings:[
    {fact:first,surface:'inventory-grid',target:input().target},
    {fact:second,surface:'inventory-grid',target:{...input(2).target,key:'wrong-slot'}},
  ]}),null);
  assert.equal(bridge.stats().metadataBytes,before.metadataBytes);assert.equal(bridge.stats().pendingPublications,0);
  assert.equal(bridge.discardFacts([second],'unmatched'),true);
  const valid=publish(first);assert.ok(valid);
});

test('coalesced, absent, unmatched and pending targets are explicit partial coverage',()=>{
  const {bridge,record,publish}=fixture();const coalesced=publish(record());
  assert.equal(bridge.closePublication(coalesced.publication,'coalesced'),true);
  const absent=publish(record(input(2)),{},2);
  assert.equal(bridge.acknowledge({...absent,target:{...absent.target,key:'not-mounted'}}),false);
  bridge.closePublication(absent.publication,'committed');
  const unbound=record(input(3));bridge.discardFacts([unbound],'unmatched');
  const pending=publish(record(input(4)),{},3);assert.ok(pending);
  const stats=bridge.stats();
  assert.equal(stats.counters.coalescedTargets,1);assert.equal(stats.counters.absentTargetReceipts,1);
  assert.equal(stats.counters.unmatchedTargets,1);assert.equal(stats.counters.unmatchedFacts,1);
  assert.equal(stats.pendingTargets,1);assert.equal(stats.sampleCount,0);assert.equal(stats.factToReceipt.maxMs,null);
});

test('StrictMode duplicate effects sample once per surface/fact across publications',()=>{
  const {bridge,record,publish,at}=fixture();const handle=record(),first=publish(handle);
  const second=publish(handle,{},2);const recent=publish(handle,{},3,'recent-frame-grid');at(250);
  assert.equal(bridge.acknowledge(first),true);assert.equal(bridge.acknowledge(first),false);
  assert.equal(bridge.acknowledge(second),false);assert.equal(bridge.acknowledge(recent),true);
  assert.equal(bridge.stats().sampleCount,2);assert.equal(bridge.stats().counters.duplicateAcks,2);
  bridge.closePublication(first.publication,'committed');bridge.closePublication(second.publication,'coalesced');
  bridge.closePublication(recent.publication,'committed');assert.equal(bridge.stats().pendingFacts,0);
  assert.equal(bridge.acknowledge(first),false);assert.equal(bridge.stats().sampleCount,2);
});

test('pending and global ring caps are fixed; overrides can only lower them',()=>{
  assert.deepEqual(FEEDBACK_RECEIPT_CAPS,{pending:128,metadataBytes:65536,samples:2048});
  for(const limits of [{pending:129},{metadataBytes:65537},{samples:2049},{pending:0},{samples:2,metadataBytes:1}]){
    assert.throws(()=>fixture(limits),RangeError);
  }
  assert.throws(()=>fixture({toString:1} as never),RangeError);
  assert.throws(()=>fixture({constructor:1} as never),RangeError);
  const {bridge,record,publish,at}=fixture({pending:2,samples:2,metadataBytes:8192});
  const first=record(),second=record(input(2));assert.equal(bridge.recordFact(input(3)),null);
  const a=publish(first),b=publish(second,{},2);at(250);bridge.acknowledge(a);bridge.acknowledge(b);
  bridge.closePublication(a.publication,'committed');bridge.closePublication(b.publication,'committed');
  const c=publish(record(input(3)),{},3);at(300);bridge.acknowledge(c);
  const stats=bridge.stats();assert.equal(stats.sampleCount,2);assert.equal(stats.counters.sampleOverwrites,1);
  assert.equal(stats.factToReceipt.p95Ms,300);assert.ok(stats.metadataBytes<=stats.limits.metadataBytes);
});

test('publication fan-out shares the same pending target cap atomically',()=>{
  const {bridge,record,publish}=fixture({pending:2,samples:2,metadataBytes:8192});
  const handle=record(),first=publish(handle),second=publish(handle,{},2,'recent-frame-grid');
  const before=bridge.stats();
  assert.equal(bridge.acceptPublication({accepted:true,snapshot:{},publicationId:3,bindings:[{fact:handle,surface:'inventory-grid',target:input().target}]}),null);
  assert.equal(bridge.stats().retainedTargets,2);assert.equal(bridge.stats().pendingPublications,2);
  assert.equal(bridge.stats().metadataBytes,before.metadataBytes);
  bridge.closePublication(first.publication,'coalesced');bridge.closePublication(second.publication,'coalesced');
});

test('metadata budget rejects before pending cap, rather than dropping evidence silently',()=>{
  const {bridge}=fixture({pending:128,samples:1,metadataBytes:4096});
  let accepted=0;
  for(let id=1;id<=128;id++)if(bridge.recordFact(input(id)))accepted++;
  assert.ok(accepted>0&&accepted<128);
  const stats=bridge.stats();assert.equal(stats.pendingFacts,accepted);assert.ok(stats.counters.rejectedCapacity>0);
  assert.ok(stats.metadataBytes<=4096);assert.equal(stats.sampleCount,0);
});

test('abort and reset fence late acknowledgements even when IDs are reused',()=>{
  const controller=new AbortController(),{bridge,record,publish,at}=fixture(undefined,controller.signal);
  const old=publish(record());controller.abort();at(240);
  assert.equal(bridge.acknowledge(old),false);assert.equal(bridge.stats().pendingFacts,0);
  bridge.reset();assert.equal(bridge.recordFact(input()),null);assert.equal(bridge.stats().cancelled,true);
  const fresh=fixture(),receipt=fresh.publish(fresh.record());fresh.bridge.reset();fresh.at(260);
  const next=fresh.publish(fresh.record());
  assert.equal(fresh.bridge.acknowledge(receipt),false);assert.equal(fresh.bridge.acknowledge(next),true);
  assert.equal(fresh.bridge.stats().sampleCount,1);
});

test('manual cancellation can reset while preserving future signal cancellation',()=>{
  const controller=new AbortController(),{bridge,record}=fixture(undefined,controller.signal);
  bridge.cancel();bridge.reset();record();assert.equal(bridge.stats().pendingFacts,1);
  controller.abort();assert.equal(bridge.stats().cancelled,true);assert.equal(bridge.stats().pendingFacts,0);
});

test('backward, invalid and future clocks never manufacture zero latency samples',()=>{
  const {bridge,record,publish,at}=fixture();const receipt=publish(record());at(199);
  assert.equal(bridge.acknowledge(receipt),false);assert.equal(bridge.stats().sampleCount,0);
  assert.equal(bridge.stats().factToReceipt.p95Ms,null);at(Number.NaN);
  assert.equal(bridge.acknowledge(receipt),false);at(250);assert.equal(bridge.acknowledge(receipt),true);
  assert.equal(bridge.stats().factToReceipt.p95Ms,250);assert.equal(bridge.stats().counters.rejectedClock,2);
  assert.equal(bridge.recordFact({...input(2),atMs:300}),null);
  assert.equal(bridge.stats().sampleCount,1);
});

test('canonical snapshots stay unmodified and no subscription or notification is required',()=>{
  const {bridge,record,publish,at}=fixture();const snapshot=Object.freeze({grid:Object.freeze({status:'read'})});
  const keys=Reflect.ownKeys(snapshot),receipt=publish(record(),snapshot);at(230);assert.equal(bridge.acknowledge(receipt),true);
  assert.deepEqual(Reflect.ownKeys(snapshot),keys);assert.deepEqual(snapshot,{grid:{status:'read'}});
  const stats=bridge.stats();assert.equal(Object.isFrozen(stats),true);assert.equal(Object.isFrozen(stats.counters),true);
});

test('bound fact disposal cannot orphan active publication metadata',()=>{
  const {bridge,record,publish}=fixture();const handle=record(),receipt=publish(handle);
  assert.equal(bridge.discardFacts([handle],'unchanged'),false);assert.ok(bridge.getFact(handle));
  assert.equal(bridge.closePublication(receipt.publication,'coalesced'),true);assert.equal(bridge.getFact(handle),null);
  assert.equal(bridge.stats().pendingFacts,0);assert.equal(bridge.stats().pendingPublications,0);
});

test('a publication already acknowledged cannot later be relabeled as coalesced',()=>{
  const {bridge,record,publish,at}=fixture();const receipt=publish(record());at(230);
  assert.equal(bridge.acknowledge(receipt),true);
  assert.equal(bridge.closePublication(receipt.publication,'coalesced'),false);
  assert.equal(bridge.stats().counters.coalescedTargets,0);assert.equal(bridge.stats().sampleCount,1);
  assert.equal(bridge.closePublication(receipt.publication,'committed'),true);
});

test('reset or cancel invoked by the injected clock cannot resurrect a pending receipt',()=>{
  for(const operation of ['reset','cancel'] as const){
    let now=200,action:(()=>void)|undefined;
    const bridge=createFeedbackFactReceipts<object>({now:()=>{action?.();return now;}});
    const handle=bridge.recordFact(input());assert.ok(handle);
    const snapshot={},publication=bridge.acceptPublication({accepted:true,snapshot,publicationId:1,bindings:[{fact:handle,surface:'inventory-grid',target:input().target}]});
    assert.ok(publication);now=230;action=()=>bridge[operation]();
    assert.equal(bridge.acknowledge({snapshot,publication,fact:handle,surface:'inventory-grid',target:input().target,join:input()}),false);
    assert.equal(bridge.stats().sampleCount,0);assert.equal(bridge.stats().pendingFacts,0);
  }
});

test('same-generation close or discard inside the injected clock cannot resurrect detached metadata',()=>{
  let now=200,action:(()=>void)|undefined;
  const bridge=createFeedbackFactReceipts<object>({now:()=>{action?.();return now;}});
  const handle=bridge.recordFact(input());assert.ok(handle);
  const snapshot={},publication=bridge.acceptPublication({accepted:true,snapshot,publicationId:1,bindings:[{fact:handle,surface:'inventory-grid',target:input().target}]});
  assert.ok(publication);now=230;
  action=()=>{assert.equal(bridge.closePublication(publication,'coalesced'),true);action=undefined;};
  assert.equal(bridge.acknowledge({snapshot,publication,fact:handle,surface:'inventory-grid',target:input().target,join:input()}),false);
  assert.equal(bridge.stats().sampleCount,0);assert.equal(bridge.stats().pendingFacts,0);
  const next=bridge.recordFact(input(2));assert.ok(next);
  action=()=>{assert.equal(bridge.discardFacts([next],'unmatched'),true);action=undefined;};
  assert.equal(bridge.acceptPublication({accepted:true,snapshot:{},publicationId:2,bindings:[{fact:next,surface:'inventory-grid',target:input(2).target}]}),null);
  assert.equal(bridge.stats().pendingPublications,0);assert.equal(bridge.stats().sampleCount,0);
});
