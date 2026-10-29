/** Pixel/source-free snapshot of optional DEV feedback diagnostics. It is read
 * once when finalization begins; late layout commits can therefore be absent.
 * This serializer never delays scanning/finalization to obtain more receipts. */
const MAX_BYTES=8*1024;
const KINDS=['viewport','crop-queued','read-task-start','read-task-end'] as const;
const CORE_COUNTS=['factsOffered','factsAccepted','publicationsOffered','publicationsAccepted',
  'acknowledgementsOffered','acknowledgements','duplicateAcks','unchangedPublications','unchangedFacts','unmatchedFacts',
  'coalescedPublications','coalescedTargets','absentTargetReceipts','unmatchedTargets','rejectedMetadata','rejectedOwnership',
  'rejectedClock','rejectedCapacity','callsAfterCancel','cancelledFacts','sampleOverwrites'] as const;
const ADAPTER_COUNTS=['errors','rejectedMetadata','rejectedClock','rejectedCapacity','missingAssociation','associationMismatch',
  'associationEvictions','duplicateQueued','ignoredQueuedFacts','duplicateObservations','staleObservations','conflictingObservations',
  'nonTaskCorrections','replacedFacts','unchangedPublications','missingGridRecords','gridMismatches','unmatchedFacts',
  'unmatchedBindings','alreadyAcknowledged','replacedPublications','replacedUnackedTargets','coalescedUnackedTargets',
  'nonPositiveReceiptTimes','callsAfterCancel'] as const;
const ADAPTER_EXTRA_COUNTS=['restoredTaskSources','readContextMismatch','activeAdmissionRejected','queuedAdmissionRejected',
  'metadataPublicationRejected','projectionSourceAbsent','projectionStateUnmatched','gridSourceMissing','gridFactMissing',
  'gridDisplayMismatch','gridAttemptMismatch','gridStatusMismatch','gridDuplicateFact','priorityFactRetirements'] as const;
type Distribution={p50Ms:number|null;p95Ms:number|null;maxMs:number|null};
type Counts=Record<string,number>;
export interface FeedbackReceiptSummary {
  collection:'finish-entry-snapshot-late-layout-receipts-may-be-absent';
  boundary:'page-clock-fact-to-injected-matching-target-receipt';
  verification:'injected-receipt-only-dom-validation-external-no-paint-proof';
  coverage:'partial-eligible-owned-bindings-only';
  sampleWindow:'latest-successful-target-receipts-global-across-surfaces';
  epoch:number;cancelled:boolean;pendingFacts:number;pendingPublications:number;retainedTargets:number;pendingTargets:number;
  metadataBytes:number;limits:{pending:number;metadataBytes:number;samples:number};sampleCount:number;counters:Counts;
  lastDiagnostic:'metadata'|'ownership'|'clock'|'capacity'|'cancelled'|null;
  factToReceipt:Distribution;publicationToReceipt:Distribution;
  byKind:Record<typeof KINDS[number],{offeredValidFacts:number;receipts:number;samples:number;factToReceipt:Distribution;publicationToReceipt:Distribution}>;
  adapter:{limits:{sources:number;gridSnapshots:number;metadataBytes:number};metadataBytes:number;pendingSources:number;
    pendingFacts:number;gridSnapshots:number;activePublications:number;counters:Counts;
    activeSources?:number;displayedSources?:number;awaitingProjection?:number;
    scope:'exact-recent-frame-and-live-viewport-only; inventory-unmeasured; metadata-budget-not-js-heap'};
}
export type FeedbackReceiptDiagnostic={feedbackReceipts?:FeedbackReceiptSummary;feedbackReceiptsUnavailable?:'invalid-or-over-limit'};

/** Inspect all descriptors without evaluating accessors or serializing arbitrary
 * source objects. Unknown data fields are ignored, never exported. */
function data(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('object');
  const keys=Reflect.ownKeys(value);if(keys.length>128)throw Error('fields');
  const result:Record<string,unknown>=Object.create(null);
  for(const key of keys){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(typeof key!=='string'||!descriptor||!descriptor.enumerable||!('value' in descriptor))throw Error('data field');
    if(typeof descriptor.value==='number'&&!Number.isFinite(descriptor.value))throw Error('nonfinite data');
    result[key]=descriptor.value;
  }
  return result;
}
function natural(value:unknown,max=Number.MAX_SAFE_INTEGER):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)throw Error('count');return value;
}
function finite(value:unknown):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error('duration');return value;
}
function literal<T extends string>(value:unknown,expected:T):T {if(value!==expected)throw Error('scope');return expected;}
function distribution(value:unknown,samples:number):Distribution {
  const row=data(value),keys=['p50Ms','p95Ms','maxMs'] as const;
  const values=keys.map(key=>samples===0?(row[key]===null?null:(()=>{throw Error('empty distribution');})()):finite(row[key]));
  if(samples>0&&!(values[0]!<=values[1]!&&values[1]!<=values[2]!))throw Error('distribution order');
  return Object.fromEntries(keys.map((key,index)=>[key,values[index]])) as Distribution;
}
function counts(value:unknown,keys:readonly string[],optional:readonly string[]=[]):Counts {
  const row=data(value),result:Counts={};
  for(const key of Object.keys(row))natural(row[key]);
  for(const key of keys)result[key]=natural(row[key]);
  for(const key of optional)if(Object.hasOwn(row,key))result[key]=natural(row[key]);
  // New counter keys may be added by the adapter. They are not arbitrary output
  // keys: only this fixed allowlist is retained in the local diagnostic.
  return result;
}
function sanitize(value:unknown):FeedbackReceiptSummary {
  const row=data(value),limits=data(row.limits),adapter=data(row.adapter),adapterLimits=data(adapter.limits);
  const sampleCount=natural(row.sampleCount,2048),kindRows=data(row.byKind);
  const byKind=Object.fromEntries(KINDS.map(kind=>{
    const item=data(kindRows[kind]),samples=natural(item.samples,sampleCount),receipts=natural(item.receipts);
    if(receipts<samples)throw Error('receipt counts');
    return [kind,{offeredValidFacts:natural(item.offeredValidFacts),receipts,samples,
      factToReceipt:distribution(item.factToReceipt,samples),publicationToReceipt:distribution(item.publicationToReceipt,samples)}];
  })) as FeedbackReceiptSummary['byKind'];
  if(KINDS.reduce((sum,kind)=>sum+byKind[kind].samples,0)!==sampleCount)throw Error('shared sample window');
  if(typeof row.cancelled!=='boolean')throw Error('cancelled');
  if(row.lastDiagnostic!==null&&!['metadata','ownership','clock','capacity','cancelled'].includes(row.lastDiagnostic as string))throw Error('diagnostic');
  const result:FeedbackReceiptSummary={
    collection:'finish-entry-snapshot-late-layout-receipts-may-be-absent',
    boundary:literal(row.boundary,'page-clock-fact-to-injected-matching-target-receipt'),
    verification:literal(row.verification,'injected-receipt-only-dom-validation-external-no-paint-proof'),
    coverage:literal(row.coverage,'partial-eligible-owned-bindings-only'),
    sampleWindow:literal(row.sampleWindow,'latest-successful-target-receipts-global-across-surfaces'),
    epoch:natural(row.epoch),cancelled:row.cancelled,pendingFacts:natural(row.pendingFacts,128),pendingPublications:natural(row.pendingPublications,128),
    retainedTargets:natural(row.retainedTargets,128),pendingTargets:natural(row.pendingTargets,128),metadataBytes:natural(row.metadataBytes,64*1024),
    limits:{pending:natural(limits.pending,128),metadataBytes:natural(limits.metadataBytes,64*1024),samples:natural(limits.samples,2048)},
    sampleCount,counters:counts(row.counters,CORE_COUNTS),lastDiagnostic:row.lastDiagnostic as FeedbackReceiptSummary['lastDiagnostic'],
    factToReceipt:distribution(row.factToReceipt,sampleCount),publicationToReceipt:distribution(row.publicationToReceipt,sampleCount),byKind,
    adapter:{limits:{sources:natural(adapterLimits.sources,128),gridSnapshots:natural(adapterLimits.gridSnapshots,2),metadataBytes:natural(adapterLimits.metadataBytes,16*1024)},
      metadataBytes:natural(adapter.metadataBytes,16*1024),pendingSources:natural(adapter.pendingSources,128),pendingFacts:natural(adapter.pendingFacts,128),
      gridSnapshots:natural(adapter.gridSnapshots,2),activePublications:natural(adapter.activePublications,1),counters:counts(adapter.counters,ADAPTER_COUNTS,ADAPTER_EXTRA_COUNTS),
      ...Object.fromEntries(['activeSources','displayedSources','awaitingProjection'].filter(key=>Object.hasOwn(adapter,key)).map(key=>[key,natural(adapter[key],128)])),
      scope:literal(adapter.scope,'exact-recent-frame-and-live-viewport-only; inventory-unmeasured; metadata-budget-not-js-heap')},
  };
  if(result.pendingFacts>result.limits.pending||result.pendingPublications>result.limits.pending||
    result.sampleCount>result.limits.samples||result.metadataBytes>result.limits.metadataBytes||result.pendingTargets>result.retainedTargets||
    result.adapter.pendingSources>result.adapter.limits.sources||result.adapter.gridSnapshots>result.adapter.limits.gridSnapshots||
    result.adapter.metadataBytes>result.adapter.limits.metadataBytes||
    result.counters.acknowledgements!==KINDS.reduce((sum,kind)=>sum+byKind[kind].receipts,0))throw Error('inconsistent limits/counts');
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>MAX_BYTES)throw Error('bytes');
  return result;
}

/** Absence leaves ordinary production diagnostics unchanged. A supplied invalid
 * getter/result is nonfatal and becomes an explicit unavailable marker. */
export function feedbackReceiptDiagnostic(settings:object):FeedbackReceiptDiagnostic {
  try {
    const descriptor=Object.getOwnPropertyDescriptor(settings,'feedbackReceipts');
    if(!descriptor){if('feedbackReceipts' in settings)throw Error('inherited getter');return {};}
    if(!('value' in descriptor)||typeof descriptor.value!=='function')throw Error('getter');
    return {feedbackReceipts:sanitize(descriptor.value())};
  }catch{return {feedbackReceiptsUnavailable:'invalid-or-over-limit'};}
}
