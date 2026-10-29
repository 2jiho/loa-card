import {createFeedbackFactReceipts,FEEDBACK_RECEIPT_CAPS} from './scanner-feedback-receipts';
import type {FeedbackFact,FeedbackFactHandle,FeedbackPublication,FeedbackSurface,FeedbackTarget} from './scanner-feedback-receipts';
import type {ObservationFact,ObservationSource} from './observation-execution';
import type {ScanGridSnapshot} from './scan-grid';

export interface FeedbackGridCell {
  /** Exact ScanGrid work projection, not the original capture position. */
  displayFrame:number;slot:number;source:ObservationSource;attemptId:number;
  status:'waiting'|'reading'|'read'|'review';
}
/** Supplied only during the synchronous start of an accepted Candidate. */
export interface FeedbackReadContext {source:ObservationSource;processingFrame:number}
export interface FeedbackDomBinding {
  readonly publication:FeedbackPublication;readonly fact:FeedbackFactHandle;readonly join:FeedbackFact;
  readonly surface:FeedbackSurface;readonly target:FeedbackTarget;readonly displayFrame?:number;readonly slot?:number;readonly top?:number;
}
const ADAPTER_CAPS=Object.freeze({sources:FEEDBACK_RECEIPT_CAPS.pending,gridSnapshots:2,metadataBytes:16*1024});
const EMPTY:readonly FeedbackDomBinding[]=Object.freeze([]);
const encoder=new TextEncoder();
type Association={processingFrame:number;attempt:number;phase:0|1|2;activeAttempt:number|null;
  displayed:boolean;projectionChecked:boolean;status:FeedbackGridCell['status'];handle:FeedbackFactHandle|undefined};
type Candidate={fact:FeedbackFactHandle;id:number;slot:number;processingFrame:number;attemptId:number;source:WeakRef<Readonly<ObservationSource>>};
type GridRecord={snapshot:WeakRef<ScanGridSnapshot>;frame:number|undefined;entries:Candidate[]};
type Active={snapshot:object;publication:FeedbackPublication;bindings:readonly FeedbackDomBinding[];acked:Set<FeedbackDomBinding>;atMs:number};
const own=(value:unknown,key:string):unknown=>{
  if(!value||typeof value!=='object')throw Error('object');
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor||!('value' in descriptor))throw Error('data field');return descriptor.value;
};
const natural=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
function sourceCopy(value:unknown):ObservationSource {
  const keys=['sessionId','frameId','observationId','captureOrder','captureTime','phase','slot'];
  if(!value||typeof value!=='object'||Reflect.ownKeys(value).length!==keys.length)throw Error('source');
  const v=Object.fromEntries(keys.map(key=>[key,own(value,key)]));
  for(const key of ['sessionId','observationId'])if(typeof v[key]!=='string'||! /^[A-Za-z0-9_.:@-]{1,160}$/.test(v[key] as string))throw Error('source id');
  if(!natural(v.frameId)||!natural(v.captureOrder)||!natural(v.slot)||v.slot>=40||
    typeof v.captureTime!=='number'||!Number.isFinite(v.captureTime)||v.captureTime<0||!['input','recovery'].includes(v.phase as string))throw Error('source values');
  return Object.freeze(v) as unknown as ObservationSource;
}
const sourceKey=(s:ObservationSource)=>JSON.stringify([s.sessionId,s.frameId,s.observationId,s.captureOrder,s.captureTime,s.phase,s.slot]);
const slotTarget=(frame:number,slot:number,status:FeedbackGridCell['status']):FeedbackTarget=>({kind:'slot',key:`frame:${frame}:slot:${slot}`,status});
function boundedCells(value:readonly FeedbackGridCell[]):readonly FeedbackGridCell[] {
  if(!Array.isArray(value)||value.length>40)throw Error('entries');
  for(let i=0;i<value.length;i++)own(value,String(i));return value;
}

/** Diagnostic-only adapter. Facts follow accepted scanner work and exact store
 * snapshots; receipts never authorize recognition, acquisition or completion.
 * The DOM hook validates actual targets separately. This is not paint timing. */
export function createScannerFeedback(options:{now:()=>number;signal?:AbortSignal}) {
  let lastCoreClock=NaN,receiptFloor:number|undefined;
  const count={errors:0,rejectedMetadata:0,rejectedClock:0,rejectedCapacity:0,missingAssociation:0,
    associationMismatch:0,associationEvictions:0,duplicateQueued:0,ignoredQueuedFacts:0,duplicateObservations:0,
    staleObservations:0,conflictingObservations:0,nonTaskCorrections:0,replacedFacts:0,unchangedPublications:0,
    missingGridRecords:0,gridMismatches:0,unmatchedFacts:0,unmatchedBindings:0,alreadyAcknowledged:0,
    replacedPublications:0,replacedUnackedTargets:0,coalescedUnackedTargets:0,nonPositiveReceiptTimes:0,callsAfterCancel:0,
    restoredTaskSources:0,readContextMismatch:0,activeAdmissionRejected:0,queuedAdmissionRejected:0,
    metadataPublicationRejected:0,projectionSourceAbsent:0,projectionStateUnmatched:0,
    gridSourceMissing:0,gridFactMissing:0,gridDisplayMismatch:0,gridAttemptMismatch:0,gridStatusMismatch:0,gridDuplicateFact:0,
    priorityFactRetirements:0,domTargetRejected:0,domVisibilityRejected:0,domInspectionFailed:0};
  const core=createFeedbackFactReceipts<object>({signal:options.signal,now:()=>{
    const value=options.now();
    if(receiptFloor!==undefined&&Number.isFinite(value)&&value<=receiptFloor){count.nonPositiveReceiptTimes++;throw Error('Nonpositive receipt interval');}
    lastCoreClock=value;return value;
  }});
  let stopped=false,nextFact=0,nextPublication=0,nextPreview=0,active:Active|undefined;
  const associations=new Map<string,Association>(),grids=new Map<object,GridRecord>();
  let gridMarks=new WeakMap<ScanGridSnapshot,object>(),seenSnapshots=new WeakSet<object>();
  let viewportFact:{handle:FeedbackFactHandle;top:number|undefined}|undefined;
  const guard=<T>(operation:()=>T,fallback:T):T=>{try{return operation();}catch{count.errors++;return fallback;}};
  const available=()=>{if(stopped){count.callsAfterCancel++;return false;}return true;};
  const isBound=(handle:FeedbackFactHandle)=>!!active?.bindings.some(binding=>binding.fact===handle);
  const discard=(handle:FeedbackFactHandle|undefined,reason:'unchanged'|'unmatched')=>{
    if(handle&&core.getFact(handle)&&!isBound(handle))core.discardFacts([handle],reason);
  };
  const metadataBytes=()=>{
    // Core-owned immutable fact/target objects are counted by the core's 64KiB
    // budget. Here count retained adapter keys/indices and conservative handle,
    // WeakRef, Map-entry/control allowances; not physical JS/GPU/process heap.
    const value={associations:[...associations].map(([key,a])=>[key,a.processingFrame,a.attempt,a.phase,a.activeAttempt,a.displayed,a.projectionChecked,a.status]),
      grids:[...grids.values()].map(g=>[g.frame,g.entries.map(e=>[e.id,e.slot,e.processingFrame,e.attemptId])]),
      active:active?.bindings.map(b=>[b.join.id,b.surface,b.displayFrame,b.slot,b.top]),
      viewport:viewportFact?{id:core.getFact(viewportFact.handle)?.id,top:viewportFact.top}:null};
    return 512+encoder.encode(JSON.stringify(value)).byteLength+associations.size*48+grids.size*48+
      [...grids.values()].reduce((bytes,g)=>bytes+g.entries.length*32,0)+(active?.bindings.length??0)*48;
  };
  const evictSource=()=>{
    let victim:[string,Association]|undefined,priority=Infinity;
    for(const entry of associations){const a=entry[1];if(a.activeAttempt!==null)continue;
      const next=a.displayed?2:a.phase!==0&&!a.projectionChecked?1:0;
      if(next<priority){victim=entry;priority=next;if(next===0)break;}
    }
    if(!victim)return false;
    discard(victim[1].handle,'unmatched');associations.delete(victim[0]);count.associationEvictions++;return true;
  };
  const trim=(newStart?:Association)=>{
    while(associations.size>ADAPTER_CAPS.sources||metadataBytes()>ADAPTER_CAPS.metadataBytes){
      count.rejectedCapacity++;
      if(evictSource())continue;
      if(grids.size){grids.delete(grids.keys().next().value!);continue;}
      if(viewportFact){discard(viewportFact.handle,'unmatched');viewportFact=undefined;continue;}
      if(active){close(active,true);active=undefined;count.metadataPublicationRejected++;continue;}
      // Existing active attempts are pinned. A new admission must be refused
      // explicitly when even its compact metadata cannot fit the same budget.
      if(newStart){const entry=[...associations].find(([,a])=>a===newStart);
        if(entry){discard(newStart.handle,'unmatched');associations.delete(entry[0]);count.activeAdmissionRejected++;continue;}
      }
      break;
    }
  };
  const timestamp=(provided?:number)=>{
    let value:number;
    try{value=provided===undefined?options.now():provided;}catch{count.errors++;count.rejectedClock++;return null;}
    if(!Number.isFinite(value)||value<0){count.rejectedClock++;return null;}return value;
  };
  const reserveTaskFact=()=>{
    // Our fixed fact recipe contains two <=160-character source identifiers,
    // small enum strings and scalar fields. Reserve a conservative 2KiB within
    // the existing core cap; this is not an allocation/JS heap estimate.
    while(true){
      const usage=core.pendingUsage();
      if(usage.metadataBytes+2048<=FEEDBACK_RECEIPT_CAPS.metadataBytes&&usage.pendingFacts<FEEDBACK_RECEIPT_CAPS.pending)break;
      let selected:Association|undefined,priority=Infinity;
      for(const a of associations.values()){
        const fact=a.handle&&core.getFact(a.handle);
        if(a.activeAttempt!==null||!fact||isBound(a.handle!)||fact.kind!=='crop-queued'&&!a.projectionChecked)continue;
        const rank=(a.displayed?2:0)+(fact.kind==='crop-queued'?0:1);
        if(rank<priority){selected=a;priority=rank;if(rank===0)break;}
      }
      if(!selected)break;
      discard(selected.handle,'unmatched');selected.handle=undefined;count.priorityFactRetirements++;
    }
  };
  const replaceHandle=(previous:FeedbackFactHandle|undefined)=>{if(previous){discard(previous,'unmatched');count.replacedFacts++;}};
  const close=(publication:Active,replaced:boolean)=>{
    const unacked=publication.bindings.length-publication.acked.size;
    if(replaced){count.replacedPublications++;count.replacedUnackedTargets+=unacked;}
    // Core deliberately refuses to relabel acknowledged publications as
    // coalesced. Preserve that contract and expose mixed replacement separately.
    const outcome=replaced&&publication.acked.size===0?'coalesced':'committed';
    if(replaced&&outcome==='coalesced')count.coalescedUnackedTargets+=unacked;
    core.closePublication(publication.publication,outcome);
  };
  const pending=()=>{
    const handles=new Set<FeedbackFactHandle>();
    for(const a of associations.values())if(a.handle&&core.getFact(a.handle)&&!isBound(a.handle))handles.add(a.handle);
    if(viewportFact&&core.getFact(viewportFact.handle)&&!isBound(viewportFact.handle))handles.add(viewportFact.handle);
    return [...handles];
  };
  const candidateFact=(candidate:Candidate,status:unknown)=>{
    const fact=core.getFact(candidate.fact);
    return fact&&fact.id===candidate.id&&fact.source===candidate.source.deref()&&fact.attemptId===candidate.attemptId&&
      fact.processingFrame===candidate.processingFrame&&fact.target.status===status?fact:null;
  };
  const sameRecentDisplay=(a:ScanGridSnapshot,b:ScanGridSnapshot)=>{
    const left=a.recentFrame,right=b.recentFrame;
    return !!left&&!!right&&left.frame===right.frame&&left.cells.length===40&&right.cells.length===40&&
      left.cells.every((cell,index)=>cell.status===right.cells[index]?.status);
  };
  const discardPending=(reason:'unchanged'|'unmatched',except=new Set<FeedbackFactHandle>())=>{
    // A viewport clone has not inspected the new task state. Only a real full
    // ScanGrid projection can establish that its target is absent/unmatched.
    for(const a of associations.values())if(a.handle&&(a.activeAttempt!==null||!a.projectionChecked))except.add(a.handle);
    const handles=pending().filter(handle=>!except.has(handle));
    if(handles.length){core.discardFacts(handles,reason);if(reason==='unmatched')count.unmatchedFacts+=handles.length;}
  };
  const cancel=()=>{
    if(stopped)return;stopped=true;options.signal?.removeEventListener('abort',cancel);
    core.cancel();associations.clear();grids.clear();gridMarks=new WeakMap();seenSnapshots=new WeakSet();viewportFact=undefined;active=undefined;
  };
  if(options.signal?.aborted)cancel();else options.signal?.addEventListener('abort',cancel,{once:true});
  const api={
    queued(source:ObservationSource,processingFrame:number):void{guard(()=>{
      if(!available())return;const copied=sourceCopy(source),key=sourceKey(copied);
      if(!natural(processingFrame)){count.rejectedMetadata++;return;}
      const previous=associations.get(key);
      if(previous){if(previous.processingFrame===processingFrame)count.duplicateQueued++;else count.associationMismatch++;return;}
      const atMs=timestamp();if(atMs===null)return;
      while(associations.size>=ADAPTER_CAPS.sources)if(!evictSource()){count.rejectedCapacity++;count.queuedAdmissionRejected++;return;}
      const handle=core.recordFact({id:++nextFact,kind:'crop-queued',source:copied,processingFrame,previewSampleId:null,attemptId:0,atMs,
        target:slotTarget(processingFrame,copied.slot,'waiting')});
      if(!stopped){associations.set(key,{processingFrame,attempt:0,phase:0,activeAttempt:null,displayed:false,projectionChecked:false,status:'waiting',handle:handle??undefined});trim();}
    },undefined);},
    observation(value:ObservationFact,context?:FeedbackReadContext):void{guard(()=>{
      if(!available())return;
      if(own(value,'kind')==='queued'){count.ignoredQueuedFacts++;return;}
      if(own(value,'version')!==1)throw Error('version');
      const source=sourceCopy(own(value,'source')),key=sourceKey(source);
      const attempt=own(value,'attemptId'),kind=own(value,'kind');
      if(!natural(attempt)||kind==='read-started'&&attempt===0||!['read-started','read-finished'].includes(kind as string)){count.rejectedMetadata++;return;}
      let a=associations.get(key),restored=false;
      if(kind==='read-started'&&context!==undefined){
        if(Reflect.ownKeys(context).length!==2)throw Error('read context');
        const original=sourceCopy(own(context,'source')),processingFrame=own(context,'processingFrame');
        if(sourceKey(original)!==key||!natural(processingFrame)||a&&a.processingFrame!==processingFrame){count.readContextMismatch++;return;}
        if(!a){
          while(associations.size>=ADAPTER_CAPS.sources)if(!evictSource()){count.rejectedCapacity++;count.activeAdmissionRejected++;return;}
          a={processingFrame,attempt:0,phase:0,activeAttempt:null,displayed:false,projectionChecked:false,status:'waiting',handle:undefined};restored=true;
        }
      }
      if(!a){count.missingAssociation++;return;}
      const phase=kind==='read-started'?1:2;
      const status=kind==='read-started'?'reading':own(value,'status') as FeedbackGridCell['status'];
      if(!['waiting','reading','read','review'].includes(status)||kind==='read-finished'&&status==='reading'){count.rejectedMetadata++;return;}
      if(attempt<a.attempt||attempt===a.attempt&&phase<a.phase){count.staleObservations++;return;}
      if(attempt===a.attempt&&phase===a.phase){
        if(status===a.status){count.duplicateObservations++;return;}
        count.conflictingObservations++;if(kind==='read-started')return;
      }
      // A finished notification can be a status correction, not a task end.
      // Track the actual start independently of receipt acceptance/capacity.
      const task=kind==='read-started'||a.activeAttempt===attempt;
      const next:Association={...a,attempt,phase,status,activeAttempt:kind==='read-started'?attempt:null,projectionChecked:false,handle:undefined};
      associations.set(key,next);replaceHandle(a.handle);
      if(!task){count.nonTaskCorrections++;trim();return;}
      const atMs=timestamp();if(atMs===null){trim(next);if(restored&&associations.get(key)===next)count.restoredTaskSources++;return;}
      reserveTaskFact();
      const handle=core.recordFact({id:++nextFact,kind:kind==='read-started'?'read-task-start':'read-task-end',source,
        processingFrame:a.processingFrame,previewSampleId:null,attemptId:attempt,atMs,target:slotTarget(a.processingFrame,source.slot,status)});
      if(!stopped&&associations.get(key)===next){next.handle=handle??undefined;trim(next);if(restored&&associations.get(key)===next)count.restoredTaskSources++;}
    },undefined);},
    viewport(top:number|undefined,atMs?:number):void{guard(()=>{
      if(!available())return;if(top!==undefined&&(!natural(top)||top<1||top>52)){count.rejectedMetadata++;return;}
      const time=timestamp(atMs);if(time===null)return;replaceHandle(viewportFact?.handle);
      const sample=++nextPreview,handle=core.recordFact({id:++nextFact,kind:'viewport',source:null,processingFrame:null,
        previewSampleId:sample,attemptId:null,atMs:time,target:{kind:'scrollbar',key:`viewport:${top??'hidden'}`,status:top===undefined?'hidden':'tracking'}});
      if(handle&&!stopped){viewportFact={handle,top};trim();}
    },undefined);},
    grid(snapshot:ScanGridSnapshot,entries:readonly FeedbackGridCell[],previous?:ScanGridSnapshot):void{guard(()=>{
      if(!available())return;const values=boundedCells(entries),record:GridRecord={snapshot:new WeakRef(snapshot),frame:snapshot.recentFrame?.frame,entries:[]};
      const used=new Set<number>(),seenSources=new Set<Association>(),projected=new Set<Association>();
      if(!previous)for(const a of associations.values())a.displayed=false;
      for(const entry of values){
        const source=sourceCopy(own(entry,'source')),slot=own(entry,'slot'),displayFrame=own(entry,'displayFrame'),attempt=own(entry,'attemptId'),status=own(entry,'status');
        const a=associations.get(sourceKey(source)),fact=a?.handle&&core.getFact(a.handle);
        if(!natural(slot)||slot>=40||used.has(slot)||!natural(displayFrame)||displayFrame!==record.frame){count.gridMismatches++;count.gridDisplayMismatch++;continue;}
        used.add(slot);
        if(!a){count.gridMismatches++;count.gridSourceMissing++;continue;}seenSources.add(a);
        if(a.attempt===attempt&&a.status===status)a.displayed=true;
        if(!fact){count.gridMismatches++;count.gridFactMissing++;continue;}
        if(fact.processingFrame!==a.processingFrame||sourceKey(fact.source!)!==sourceKey(source)){count.gridMismatches++;count.associationMismatch++;continue;}
        if(fact.attemptId!==attempt){count.gridMismatches++;count.gridAttemptMismatch++;continue;}
        if(fact.target.status!==status||snapshot.recentFrame?.cells[slot]?.status!==status){count.gridMismatches++;count.gridStatusMismatch++;continue;}
        if(record.entries.some(e=>e.fact===a.handle)){count.gridMismatches++;count.gridDuplicateFact++;continue;}
        projected.add(a);record.entries.push({fact:a.handle!,id:fact.id,slot,processingFrame:a.processingFrame,attemptId:fact.attemptId!,source:new WeakRef(fact.source!)});
      }
      if(!previous)for(const a of associations.values()){
        const fact=a.handle&&core.getFact(a.handle);
        if(!a.projectionChecked&&fact&&fact.kind!=='crop-queued'&&!projected.has(a)){
          if(seenSources.has(a))count.projectionStateUnmatched++;else count.projectionSourceAbsent++;
        }
        a.projectionChecked=true;
      }
      // `previous` is an explicit scanner/store source pointer. A fresh store
      // canonicalization can clone all 40 display cells; equal values alone,
      // without that exact owned pointer, never authorize a source join.
      if(values.length===0&&previous&&(previous.recentFrame===snapshot.recentFrame||sameRecentDisplay(previous,snapshot))){
        const token=gridMarks.get(previous),old=token&&grids.get(token);
        if(old&&old.snapshot.deref()===previous)for(const entry of old.entries){
          if(candidateFact(entry,snapshot.recentFrame?.cells[entry.slot]?.status))record.entries.push({...entry});
        }
      }
      if(stopped)return;const old=gridMarks.get(snapshot);if(old)grids.delete(old);
      const token=Object.freeze({});gridMarks.set(snapshot,token);grids.set(token,record);
      while(grids.size>ADAPTER_CAPS.gridSnapshots)grids.delete(grids.keys().next().value!);trim();
    },undefined);},
    publish(snapshot:object,grid:ScanGridSnapshot|undefined,unchanged=false):void{guard(()=>{
      if(!available())return;if(!snapshot||typeof snapshot!=='object')throw Error('snapshot');
      if(unchanged||seenSnapshots.has(snapshot)){count.unchangedPublications++;discardPending('unchanged');return;}
      seenSnapshots.add(snapshot);
      const previous=active,raw:{fact:FeedbackFactHandle;surface:FeedbackSurface;target:FeedbackTarget;displayFrame?:number;slot?:number;top?:number}[]=[];
      const already=(handle:FeedbackFactHandle,surface:FeedbackSurface)=>!!previous?.bindings.some(b=>b.fact===handle&&b.surface===surface&&previous.acked.has(b));
      const token=grid&&gridMarks.get(grid),record=token&&grids.get(token);
      if(!record||record.snapshot.deref()!==grid)count.missingGridRecords++;
      else for(const candidate of record.entries){
        const recent=grid?.recentFrame;
        const fact=recent&&recent.frame===record.frame&&candidateFact(candidate,recent.cells[candidate.slot]?.status);
        if(!fact){count.gridMismatches++;continue;}
        if(already(candidate.fact,'recent-frame-grid')){count.alreadyAcknowledged++;continue;}
        raw.push({fact:candidate.fact,surface:'recent-frame-grid',target:fact.target,displayFrame:recent!.frame,slot:candidate.slot});
      }
      if(viewportFact&&grid?.liveTracking===true&&grid.liveTop===viewportFact.top){
        const fact=core.getFact(viewportFact.handle);
        if(fact&&!already(viewportFact.handle,'live-scrollbar'))raw.push({fact:viewportFact.handle,surface:'live-scrollbar',target:fact.target,top:viewportFact.top});
      }
      const publication=raw.length?core.acceptPublication({accepted:true,snapshot,publicationId:++nextPublication,bindings:raw.map(({fact,surface,target})=>({fact,surface,target}))}):null;
      const atMs=lastCoreClock;
      if(previous)close(previous,true);active=undefined;
      if(publication&&!stopped){
        const bindings=Object.freeze(raw.map(row=>Object.freeze({...row,publication,join:core.getFact(row.fact)!})));
        active={snapshot,publication,bindings,acked:new Set(),atMs};
      }
      discardPending('unmatched',new Set(active?.bindings.map(binding=>binding.fact)??[]));trim();
    },undefined);},
    bindings(snapshot:object):readonly FeedbackDomBinding[]{return guard(()=>active?.snapshot===snapshot?active.bindings:EMPTY,EMPTY);},
    rejectDom(snapshot:object,binding:FeedbackDomBinding,reason:'target'|'visibility'|'inspection'):void{guard(()=>{
      if(!available())return;
      if(active?.snapshot!==snapshot||!active.bindings.includes(binding)){count.unmatchedBindings++;return;}
      if(reason==='target')count.domTargetRejected++;
      else if(reason==='visibility')count.domVisibilityRejected++;
      else if(reason==='inspection')count.domInspectionFailed++;
    },undefined);},
    acknowledge(snapshot:object,binding:FeedbackDomBinding):boolean{return guard(()=>{
      if(!available())return false;const current=active;
      if(!current||current.snapshot!==snapshot||!current.bindings.includes(binding)){count.unmatchedBindings++;return false;}
      receiptFloor=Math.max(current.atMs,binding.join.atMs);
      try{const accepted=core.acknowledge({snapshot,publication:binding.publication,fact:binding.fact,surface:binding.surface,target:binding.target,join:binding.join});
        if(accepted&&active===current)current.acked.add(binding);return accepted;
      }finally{receiptFloor=undefined;}
    },false);},
    commitDone(snapshot:object):void{guard(()=>{if(!available())return;if(active?.snapshot===snapshot){close(active,false);active=undefined;}},undefined);},
    cancel,
    stats(){return Object.freeze({...core.stats(),adapter:Object.freeze({limits:ADAPTER_CAPS,metadataBytes:metadataBytes(),
      pendingSources:associations.size,pendingFacts:pending().length,gridSnapshots:grids.size,activePublications:active?1:0,
      activeSources:[...associations.values()].filter(a=>a.activeAttempt!==null).length,
      displayedSources:[...associations.values()].filter(a=>a.displayed).length,
      awaitingProjection:[...associations.values()].filter(a=>a.handle&&!a.projectionChecked&&core.getFact(a.handle)).length,
      counters:Object.freeze({...count}),scope:'exact-recent-frame-and-live-viewport-only; inventory-unmeasured; metadata-budget-not-js-heap' as const})});},
  };
  return api;
}
export type ScannerFeedback=ReturnType<typeof createScannerFeedback>;
