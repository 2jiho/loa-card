import test from 'node:test';
import assert from 'node:assert/strict';
import {createScannerFeedback} from '../src/features/card-scanner/scanner-feedback';
import type {FeedbackGridCell} from '../src/features/card-scanner/scanner-feedback';
import type {ObservationFact,ObservationSource} from '../src/features/card-scanner/observation-execution';
import type {ScanGridSnapshot} from '../src/features/card-scanner/scan-grid';

const source=(id=1,slot=0):ObservationSource=>({sessionId:'session-1',frameId:id,observationId:`observation-${id}`,
  captureOrder:id,captureTime:40_000+id,phase:'input',slot});
const start=(s:ObservationSource,attemptId=1):ObservationFact=>({version:1,source:s,attemptId,kind:'read-started'});
const end=(s:ObservationSource,attemptId=1,status:'waiting'|'read'|'review'='read'):ObservationFact=>({version:1,source:s,attemptId,kind:'read-finished',status});
const entry=(s:ObservationSource,displayFrame=101,attemptId=0,status:FeedbackGridCell['status']='waiting'):FeedbackGridCell=>
  ({source:s,slot:s.slot,displayFrame,attemptId,status});
function grid(entries:readonly FeedbackGridCell[],frame=101):ScanGridSnapshot {
  const cells=Array.from({length:40},()=>({status:'unknown' as const} as {status:'unknown'|FeedbackGridCell['status']}));
  for(const e of entries)cells[e.slot]={status:e.status};
  return {located:true,cells,recentFrame:{frame,cells}};
}
function fixture(signal?:AbortSignal){
  let now=10;
  const feedback=createScannerFeedback({now:()=>now,signal});
  const publish=(entries:readonly FeedbackGridCell[],value=grid(entries))=>{
    feedback.grid(value,entries);const snapshot={grid:value};feedback.publish(snapshot,value);return snapshot;
  };
  return {feedback,publish,at(value:number){now=value;}};
}

test('a queued crop receipt includes upstream delay and uses only the page clock',()=>{
  const {feedback,publish,at}=fixture(),s=source();at(100);feedback.queued(s,101);
  at(300);const snapshot=publish([entry(s)]),[binding]=feedback.bindings(snapshot);assert.ok(binding);
  assert.equal(binding.join.kind,'crop-queued');assert.equal(binding.join.atMs,100);
  assert.equal(binding.join.source?.captureTime,40_001);assert.equal(binding.join.processingFrame,101);
  assert.match(binding.target.key,/101.*0/);assert.equal(binding.surface,'recent-frame-grid');
  at(350);assert.equal(feedback.acknowledge(snapshot,binding),true);
  const stats=feedback.stats();assert.equal(stats.sampleCount,1);assert.equal(stats.factToReceipt.p95Ms,250);
  assert.equal(stats.publicationToReceipt.p95Ms,50);assert.match(stats.adapter.scope,/inventory-unmeasured/);
  feedback.commitDone(snapshot);assert.equal(feedback.stats().pendingFacts,0);
});

test('DOM rejection counters require the active owned binding and never acknowledge it',()=>{
  const {feedback,publish}=fixture(),s=source();feedback.queued(s,101);
  const snapshot=publish([entry(s)]),[binding]=feedback.bindings(snapshot);
  feedback.rejectDom({},binding,'target');
  feedback.rejectDom(snapshot,{...binding},'visibility');
  for(const reason of ['target','visibility','inspection'] as const)feedback.rejectDom(snapshot,binding,reason);
  const stats=feedback.stats();
  assert.equal(stats.sampleCount,0);assert.equal(stats.adapter.counters.unmatchedBindings,2);
  assert.equal(stats.adapter.counters.domTargetRejected,1);
  assert.equal(stats.adapter.counters.domVisibilityRejected,1);
  assert.equal(stats.adapter.counters.domInspectionFailed,1);
  feedback.commitDone(snapshot);feedback.rejectDom(snapshot,binding,'target');
  assert.equal(feedback.stats().adapter.counters.domTargetRejected,1);
});

test('waiting, actual task start and actual task end each bind their own accepted state',()=>{
  const {feedback,publish,at}=fixture(),s=source();feedback.queued(s,101);
  const phases=[{status:'waiting',attempt:0,kind:'crop-queued'},
    {status:'reading',attempt:1,kind:'read-task-start'},{status:'read',attempt:1,kind:'read-task-end'}] as const;
  for(const [index,phase] of phases.entries()){
    at(30+index*50);if(phase.status==='reading')feedback.observation(start(s));if(phase.status==='read')feedback.observation(end(s));
    at(40+index*50);const snapshot=publish([entry(s,101,phase.attempt,phase.status)]),[binding]=feedback.bindings(snapshot);assert.ok(binding);
    assert.equal(binding.join.kind,phase.kind);assert.equal(binding.join.attemptId,phase.attempt);assert.equal(binding.target.status,phase.status);
    at(50+index*50);assert.equal(feedback.acknowledge(snapshot,binding),true);feedback.commitDone(snapshot);
  }
  assert.equal(feedback.stats().sampleCount,3);assert.equal(feedback.stats().adapter.counters.nonTaskCorrections,0);
});

test('every source field is required; another source with the same slot gains no task association',()=>{
  const changes={sessionId:'other',frameId:2,observationId:'other-observation',captureOrder:2,captureTime:40_002,phase:'recovery',slot:1};
  for(const [key,value] of Object.entries(changes)){
    const {feedback,publish}=fixture(),s=source(),other={...s,[key]:value} as ObservationSource;
    feedback.queued(s,101);feedback.observation(start(other));feedback.observation(end(other));
    const snapshot=publish([entry(other,101,1,'read')]);assert.equal(feedback.bindings(snapshot).length,0,key);
    assert.equal(feedback.stats().sampleCount,0);assert.equal(feedback.stats().adapter.counters.missingAssociation,2);
  }
});

test('frame, attempt, slot and rendered status mismatches do not receive a recent-grid receipt',()=>{
  for(const mismatch of ['frame','attempt','slot','status','rendered-status'] as const){
    const {feedback,publish}=fixture(),s=source();feedback.queued(s,101);feedback.observation(start(s));feedback.observation(end(s));
    const e=entry(s,101,1,'read');if(mismatch==='frame')e.displayFrame=102;if(mismatch==='attempt')e.attemptId=2;
    if(mismatch==='slot')e.slot=40;if(mismatch==='status')e.status='review';
    const value=grid([e]);if(mismatch==='rendered-status')value.recentFrame!.cells[s.slot]={status:'review'};
    const snapshot=publish([e],value);assert.equal(feedback.bindings(snapshot).length,0,mismatch);
    assert.ok(feedback.stats().adapter.counters.gridMismatches>0);
  }
});

test('a rejected queue has no queued callback, so later task facts remain unassociated',()=>{
  const {feedback,publish}=fixture(),s=source();
  feedback.observation({version:1,source:s,attemptId:0,kind:'queued'});
  feedback.observation(start(s));feedback.observation(end(s));
  const snapshot=publish([entry(s,101,1,'read')]);assert.equal(feedback.bindings(snapshot).length,0);
  assert.equal(feedback.stats().adapter.counters.ignoredQueuedFacts,1);
  assert.equal(feedback.stats().adapter.counters.missingAssociation,2);assert.equal(feedback.stats().sampleCount,0);
});

test('attempt-zero and startless status corrections never manufacture task-end facts',()=>{
  for(const attempt of [0,1,7]){
    const {feedback,publish}=fixture(),s=source();feedback.queued(s,101);feedback.observation(end(s,attempt,'review'));
    const snapshot=publish([entry(s,101,attempt,'review')]);assert.equal(feedback.bindings(snapshot).length,0);
    assert.equal(feedback.stats().adapter.counters.nonTaskCorrections,1);assert.equal(feedback.stats().sampleCount,0);
  }
});

test('a post-task status correction revokes the end fact rather than stamping a new task',()=>{
  const {feedback,publish}=fixture(),s=source();feedback.queued(s,101);feedback.observation(start(s));feedback.observation(end(s));
  feedback.observation(end(s,1,'review'));
  const snapshot=publish([entry(s,101,1,'review')]);assert.equal(feedback.bindings(snapshot).length,0);
  assert.equal(feedback.stats().adapter.counters.nonTaskCorrections,1);
  assert.equal(feedback.stats().adapter.counters.conflictingObservations,1);assert.equal(feedback.stats().sampleCount,0);
});

test('an actual start survives a rejected start timestamp, allowing only its exact later end',()=>{
  const {feedback,publish,at}=fixture(),s=source();feedback.queued(s,101);at(Number.NaN);feedback.observation(start(s,2));
  at(30);feedback.observation(end(s,1));feedback.observation(end(s,2));
  at(40);const snapshot=publish([entry(s,101,2,'read')]),[binding]=feedback.bindings(snapshot);assert.ok(binding);
  assert.equal(binding.join.kind,'read-task-end');assert.equal(binding.join.attemptId,2);assert.equal(binding.join.atMs,30);
  assert.equal(feedback.stats().adapter.counters.staleObservations,1);assert.equal(feedback.stats().adapter.counters.rejectedClock,1);
  assert.equal(feedback.stats().adapter.counters.nonTaskCorrections,0);
  at(50);assert.equal(feedback.acknowledge(snapshot,binding),true);
});

test('a synchronous accepted task context restores only a fresh start origin after queue metadata retires',()=>{
  const {feedback,publish,at}=fixture(),s=source();feedback.queued(s,101);
  for(let id=2;id<=300;id++)feedback.queued(source(id),id);
  const queuedFacts=feedback.stats().byKind['crop-queued'].offeredValidFacts;
  at(800);feedback.observation(start(s,4),{source:{...s},processingFrame:101});
  const e={...entry(s,401,4,'reading'),slot:20};at(810);const snapshot=publish([e],grid([e],401)),[binding]=feedback.bindings(snapshot);assert.ok(binding);
  assert.equal(binding.join.atMs,800);assert.equal(binding.join.kind,'read-task-start');assert.equal(binding.join.processingFrame,101);
  assert.equal(binding.join.source?.slot,0);assert.equal(binding.displayFrame,401);assert.equal(binding.slot,20);
  assert.match(binding.target.key,/101.*0/);assert.equal(feedback.stats().byKind['crop-queued'].offeredValidFacts,queuedFacts);
  assert.equal(feedback.stats().adapter.counters.restoredTaskSources,1);
  at(820);assert.equal(feedback.acknowledge(snapshot,binding),true);assert.equal(feedback.stats().factToReceipt.p95Ms,20);
});

test('read contexts must match every source field and the originally admitted processing frame',()=>{
  const changes={sessionId:'other',frameId:2,observationId:'other-observation',captureOrder:2,captureTime:40_002,phase:'recovery',slot:1};
  for(const [key,value] of Object.entries(changes)){
    const {feedback,publish}=fixture(),s=source();feedback.queued(s,101);
    feedback.observation(start(s),{source:{...s,[key]:value} as ObservationSource,processingFrame:101});
    const snapshot=publish([entry(s,101,1,'reading')]);assert.equal(feedback.bindings(snapshot).length,0,key);
    assert.equal(feedback.stats().adapter.counters.readContextMismatch,1);assert.equal(feedback.stats().byKind['read-task-start'].offeredValidFacts,0);
  }
  const {feedback}=fixture(),s=source();feedback.queued(s,101);feedback.observation(start(s),{source:s,processingFrame:102});
  assert.equal(feedback.stats().adapter.counters.readContextMismatch,1);assert.equal(feedback.stats().byKind['read-task-start'].offeredValidFacts,0);
  const unknown=fixture();unknown.feedback.observation(end(s),{source:s,processingFrame:101});
  assert.equal(unknown.feedback.stats().pendingFacts,0);assert.equal(unknown.feedback.stats().adapter.counters.restoredTaskSources,0);
});

test('active sources survive queue pressure and current exact witnesses precede unseen waiting sources',()=>{
  const {feedback,publish,at}=fixture(),active=source(1),displayed=source(2,1);
  feedback.queued(active,101);feedback.observation(start(active));feedback.queued(displayed,101);
  const e=entry(displayed);feedback.grid(grid([e]),[e]);
  for(let id=3;id<=600;id++)feedback.queued(source(id),id);
  assert.equal(feedback.stats().adapter.activeSources,1);assert.equal(feedback.stats().adapter.displayedSources,1);
  at(30);feedback.observation(start(displayed));feedback.observation(end(active));
  at(40);const snapshot=publish([entry(active,101,1,'read')]),[binding]=feedback.bindings(snapshot);assert.ok(binding);
  assert.equal(binding.join.kind,'read-task-end');assert.equal(feedback.stats().adapter.counters.missingAssociation,0);
  assert.ok(feedback.stats().adapter.metadataBytes<=16*1024);at(50);assert.equal(feedback.acknowledge(snapshot,binding),true);
});

test('all-active metadata pressure rejects new task admission instead of evicting an existing active attempt',()=>{
  const {feedback}=fixture();const first={...source(),sessionId:'s'.repeat(160),observationId:'o'.repeat(159)+'1'};
  feedback.observation(start(first),{source:first,processingFrame:1});
  for(let id=2;id<=200;id++){
    const s={...source(id),sessionId:'s'.repeat(160),observationId:'o'.repeat(156)+String(id).padStart(4,'0')};
    feedback.observation(start(s),{source:s,processingFrame:id});
    assert.ok(feedback.stats().adapter.metadataBytes<=16*1024);assert.ok(feedback.stats().adapter.activeSources<=128);
  }
  const stats=feedback.stats();assert.ok(stats.adapter.counters.activeAdmissionRejected>0);
  assert.equal(stats.adapter.counters.associationEvictions,0);feedback.observation(end(first));
  assert.equal(feedback.stats().adapter.counters.missingAssociation,0);
});

test('receipt-capacity rejection does not erase the independently observed actual task start',()=>{
  const {feedback,publish,at}=fixture();let s:ObservationSource|undefined;
  const sources=Array.from({length:40},(_,slot)=>source(slot+1,slot));
  for(const candidate of sources)feedback.queued(candidate,101);
  at(20);const occupied=publish(sources.map(candidate=>entry(candidate)));
  assert.equal(feedback.bindings(occupied).length,40);
  // All old queued facts are bound to a not-yet-committed publication. Once
  // the other retained facts are active starts, priority retirement cannot
  // manufacture additional room by discarding any of those owned bindings.
  const rejected=feedback.stats().counters.rejectedCapacity;
  for(const candidate of sources){
    feedback.observation(start(candidate,3),{source:candidate,processingFrame:101});
    if(feedback.stats().counters.rejectedCapacity>rejected){s=candidate;break;}
  }
  assert.ok(s,'the occupied publication must eventually reject an actual start receipt');
  feedback.commitDone(occupied);at(30);feedback.observation(end(s,3));
  at(40);const snapshot=publish([entry(s,101,3,'read')]),[binding]=feedback.bindings(snapshot);assert.ok(binding);
  assert.equal(binding.join.kind,'read-task-end');assert.equal(binding.join.attemptId,3);
  assert.equal(feedback.stats().adapter.counters.nonTaskCorrections,0);at(50);assert.equal(feedback.acknowledge(snapshot,binding),true);
});

test('a newer actual attempt fences stale finishes and duplicate notifications',()=>{
  const {feedback,publish}=fixture(),s=source();feedback.queued(s,101);feedback.observation(start(s,1));feedback.observation(start(s,2));
  feedback.observation(end(s,1));feedback.observation(end(s,2));feedback.observation(end(s,2));
  const snapshot=publish([entry(s,101,2,'read')]),[binding]=feedback.bindings(snapshot);assert.ok(binding);
  assert.equal(binding.join.attemptId,2);assert.equal(binding.join.kind,'read-task-end');
  assert.equal(feedback.stats().adapter.counters.staleObservations,1);assert.equal(feedback.stats().adapter.counters.duplicateObservations,1);
});

test('viewport facts bind only to live tracking with the same top and keep independent identities',()=>{
  for(const state of [{liveTracking:false,liveTop:12},{liveTracking:true,liveTop:11}]){
    const {feedback}=fixture();feedback.viewport(12,5);const value={...grid([]),...state},snapshot={};feedback.publish(snapshot,value);
    assert.equal(feedback.bindings(snapshot).length,0);
  }
  const {feedback,at}=fixture();feedback.viewport(12,5);const value={...grid([]),liveTracking:true,liveTop:12},snapshot={};
  at(20);feedback.publish(snapshot,value);const [binding]=feedback.bindings(snapshot);assert.ok(binding);
  assert.equal(binding.surface,'live-scrollbar');assert.equal(binding.top,12);assert.equal(binding.join.source,null);
  assert.equal(binding.join.processingFrame,null);assert.equal(binding.join.attemptId,null);assert.equal(binding.join.previewSampleId,1);
  at(30);assert.equal(feedback.acknowledge(snapshot,binding),true);assert.equal(feedback.stats().factToReceipt.p95Ms,25);
});

test('an exact viewport clone can replace an unacknowledged publication without losing its crop fact',()=>{
  const {feedback,publish,at}=fixture(),s=source();feedback.queued(s,101);at(20);const first=publish([entry(s)]),[oldBinding]=feedback.bindings(first);
  const clone={...first.grid,liveTracking:true,liveTop:2};feedback.grid(clone,[],first.grid);
  at(30);const second={grid:clone};feedback.publish(second,clone);const [binding]=feedback.bindings(second);assert.ok(binding);
  assert.equal(binding.fact,oldBinding.fact);assert.equal(feedback.bindings(first).length,0);
  at(40);assert.equal(feedback.acknowledge(first,oldBinding),false);assert.equal(feedback.acknowledge(second,binding),true);
  const stats=feedback.stats();assert.equal(stats.sampleCount,1);assert.equal(stats.adapter.counters.coalescedUnackedTargets,1);
  assert.equal(stats.counters.coalescedTargets,1);assert.equal(stats.factToReceipt.p95Ms,30);
});

test('partially acknowledged replacement reports unacknowledged targets without double credit',()=>{
  const {feedback,publish,at}=fixture(),a=source(1,0),b=source(2,1);feedback.queued(a,101);feedback.queued(b,101);
  at(20);const first=publish([entry(a),entry(b)]),bindings=feedback.bindings(first);assert.equal(bindings.length,2);
  at(30);assert.equal(feedback.acknowledge(first,bindings[0]),true);
  const clone={...first.grid,liveTop:2};feedback.grid(clone,[],first.grid);at(40);const second={};feedback.publish(second,clone);
  const next=feedback.bindings(second);assert.equal(next.length,1);assert.equal(next[0].slot,1);
  at(50);assert.equal(feedback.acknowledge(second,next[0]),true);assert.equal(feedback.acknowledge(first,bindings[1]),false);
  const stats=feedback.stats();assert.equal(stats.sampleCount,2);assert.equal(stats.adapter.counters.replacedUnackedTargets,1);
  assert.equal(stats.adapter.counters.coalescedUnackedTargets,0);assert.equal(stats.counters.absentTargetReceipts,1);
});

test('unchanged canonical state cannot borrow a newly observed source with equal cell values',()=>{
  const {feedback,publish,at}=fixture(),a=source(),b=source(2);feedback.queued(a,101);at(20);const first=publish([entry(a)]);
  const [oldBinding]=feedback.bindings(first);feedback.queued(b,101);const nextGrid=grid([entry(b)]);feedback.grid(nextGrid,[entry(b)]);
  feedback.publish(first,first.grid,true);assert.equal(feedback.bindings(first)[0].fact,oldBinding.fact);
  at(30);assert.equal(feedback.acknowledge(first,oldBinding),true);
  at(40);const next={};feedback.publish(next,nextGrid);assert.equal(feedback.bindings(next).length,0);
  assert.equal(feedback.stats().sampleCount,1);assert.equal(feedback.stats().adapter.counters.unchangedPublications,1);
  assert.ok(feedback.stats().counters.unchangedFacts>0);
});

test('a structurally equal grid without the exact bounded sidecar remains unmeasured',()=>{
  const {feedback,at}=fixture(),s=source();feedback.queued(s,101);const value=grid([entry(s)]);feedback.grid(value,[entry(s)]);
  const clone=structuredClone(value),snapshot={};at(20);feedback.publish(snapshot,clone);
  assert.equal(feedback.bindings(snapshot).length,0);assert.equal(feedback.stats().adapter.counters.missingGridRecords,1);
  assert.equal(feedback.stats().sampleCount,0);
});

test('a fresh canonical grid clone inherits only the explicitly supplied owned source record',()=>{
  const {feedback,at}=fixture(),s=source();feedback.queued(s,101);feedback.observation(start(s,2));
  const e=entry(s,101,2,'reading'),raw=grid([e]);feedback.grid(raw,[e]);
  const canonical=structuredClone(raw);feedback.grid(canonical,[],raw);const snapshot={};at(20);feedback.publish(snapshot,canonical);
  const [binding]=feedback.bindings(snapshot);assert.ok(binding);assert.equal(binding.join.kind,'read-task-start');
  assert.equal(binding.join.source?.observationId,s.observationId);assert.equal(binding.join.processingFrame,101);
  assert.equal(binding.join.attemptId,2);assert.equal(binding.target.status,'reading');
  at(30);assert.equal(feedback.acknowledge(snapshot,binding),true);
});

test('canonical clone inheritance rejects changed frame, any changed display cell, and unowned pointers',()=>{
  for(const mismatch of ['frame','non-target-cell','cell-count','unowned-source'] as const){
    const {feedback,at}=fixture(),s=source();feedback.queued(s,101);const e=entry(s),raw=grid([e]);feedback.grid(raw,[e]);
    const canonical=structuredClone(raw);let previous=raw;
    if(mismatch==='frame')canonical.recentFrame!.frame=102;
    if(mismatch==='non-target-cell')canonical.recentFrame!.cells[39]={status:'review'};
    if(mismatch==='cell-count')canonical.recentFrame!.cells.pop();
    if(mismatch==='unowned-source')previous=structuredClone(raw);
    feedback.grid(canonical,[],previous);at(20);const snapshot={};feedback.publish(snapshot,canonical);
    assert.equal(feedback.bindings(snapshot).length,0,mismatch);assert.equal(feedback.stats().sampleCount,0);
  }
});

test('an explicit source pointer cannot replace a retired fact with a newer equal-status attempt',()=>{
  const {feedback,at}=fixture(),s=source();feedback.queued(s,101);const raw=grid([entry(s)]);feedback.grid(raw,[entry(s)]);
  feedback.observation(start(s,1));feedback.observation(end(s,1,'waiting'));
  const canonical=structuredClone(raw);feedback.grid(canonical,[],raw);at(20);const snapshot={};feedback.publish(snapshot,canonical);
  assert.equal(feedback.bindings(snapshot).length,0);assert.equal(feedback.stats().sampleCount,0);
});

test('viewport and unchanged publications cannot retire a new task fact before its actual full projection',()=>{
  const {feedback,publish,at}=fixture(),s=source();feedback.queued(s,101);at(20);const initial=publish([entry(s)]);
  const [queued]=feedback.bindings(initial);at(30);assert.equal(feedback.acknowledge(initial,queued),true);feedback.commitDone(initial);
  at(40);feedback.observation(start(s));const viewport={...initial.grid,liveTop:2};feedback.grid(viewport,[],initial.grid);
  at(50);feedback.publish({},viewport);assert.equal(feedback.stats().adapter.activeSources,1);
  at(60);feedback.observation(end(s));assert.equal(feedback.stats().adapter.awaitingProjection,1);
  feedback.publish(initial,initial.grid,true);assert.equal(feedback.bindings(initial).length,0);
  assert.equal(feedback.stats().adapter.awaitingProjection,1);
  at(70);const e={...entry(s,201,1,'read'),slot:10},done=publish([e],grid([e],201)),[binding]=feedback.bindings(done);assert.ok(binding);
  assert.equal(binding.join.kind,'read-task-end');assert.equal(binding.join.atMs,60);
  assert.equal(binding.join.processingFrame,101);assert.equal(binding.displayFrame,201);assert.equal(binding.slot,10);
  at(80);assert.equal(feedback.acknowledge(done,binding),true);assert.equal(feedback.stats().byKind['read-task-end'].receipts,1);
});

test('a new full grid without the task source makes its end explicitly unprojected and unmeasured',()=>{
  const {feedback,publish,at}=fixture(),s=source();feedback.queued(s,101);feedback.observation(start(s));feedback.observation(end(s));
  assert.equal(feedback.stats().adapter.awaitingProjection,1);at(20);publish([],grid([],201));
  assert.equal(feedback.stats().adapter.counters.projectionSourceAbsent,1);assert.equal(feedback.stats().pendingFacts,0);
  at(30);const e=entry(s,301,1,'read'),snapshot=publish([e],grid([e],301));
  assert.equal(feedback.bindings(snapshot).length,0);assert.equal(feedback.stats().byKind['read-task-end'].receipts,0);
  assert.ok(feedback.stats().adapter.counters.gridFactMissing>0);
});

test('adapter source metadata and weak grid records stay bounded under long unmatched input',()=>{
  const {feedback}=fixture();
  for(let id=1;id<=600;id++){
    feedback.queued(source(id),id);const value=grid([],id);feedback.grid(value,[]);
  }
  const stats=feedback.stats();assert.ok(stats.adapter.pendingSources<=128);assert.equal(stats.adapter.gridSnapshots,2);
  assert.ok(stats.adapter.metadataBytes<=16*1024);assert.ok(stats.metadataBytes<=64*1024);assert.ok(stats.pendingFacts<=128);
  assert.ok(stats.adapter.counters.associationEvictions>0);assert.equal(stats.sampleCount,0);assert.equal(stats.factToReceipt.p95Ms,null);
});

test('abort releases active metadata and fences late target receipts and queued callbacks',()=>{
  const controller=new AbortController(),{feedback,publish,at}=fixture(controller.signal),s=source();feedback.queued(s,101);
  at(20);const snapshot=publish([entry(s)]),[binding]=feedback.bindings(snapshot);controller.abort();feedback.cancel();
  at(30);assert.equal(feedback.acknowledge(snapshot,binding),false);feedback.queued(source(2),102);
  const stats=feedback.stats();assert.equal(stats.cancelled,true);assert.equal(stats.pendingFacts,0);assert.equal(stats.pendingPublications,0);
  assert.equal(stats.adapter.pendingSources,0);assert.equal(stats.adapter.gridSnapshots,0);assert.equal(stats.adapter.activePublications,0);
  assert.equal(feedback.bindings(snapshot).length,0);assert.equal(stats.sampleCount,0);
  const pre=fixture(AbortSignal.abort());pre.feedback.queued(source(),1);assert.equal(pre.feedback.stats().adapter.pendingSources,0);
});

test('source getters and observer clock failures cannot escape into scanner work',()=>{
  const {feedback}=fixture();let calls=0;const bad={...source()};Object.defineProperty(bad,'frameId',{enumerable:true,get(){calls++;throw Error('getter');}});
  assert.doesNotThrow(()=>feedback.queued(bad,101));assert.equal(calls,0);assert.equal(feedback.stats().pendingFacts,0);
  const broken=createScannerFeedback({now:()=>{throw Error('clock');}});assert.doesNotThrow(()=>broken.queued(source(),101));
  assert.doesNotThrow(()=>broken.viewport(1));assert.equal(broken.stats().sampleCount,0);assert.ok(broken.stats().adapter.counters.errors>0);
});

test('zero-duration target receipts are unmeasured until a later positive receipt arrives',()=>{
  const {feedback,publish,at}=fixture(),s=source();feedback.queued(s,101);const snapshot=publish([entry(s)]),[binding]=feedback.bindings(snapshot);
  assert.equal(feedback.acknowledge(snapshot,binding),false);assert.equal(feedback.stats().sampleCount,0);
  assert.equal(feedback.stats().adapter.counters.nonPositiveReceiptTimes,1);assert.equal(feedback.stats().publicationToReceipt.p95Ms,null);
  at(20);assert.equal(feedback.acknowledge(snapshot,binding),true);assert.equal(feedback.stats().sampleCount,1);
  assert.equal(feedback.acknowledge(snapshot,{...binding}),false);assert.equal(feedback.stats().sampleCount,1);
});
