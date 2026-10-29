/** Bounded, pixel-free DOM target receipt accounting. This core owns opaque
 * fact/publication sidecars and timing samples; it does not read the DOM, write
 * scanner state, notify subscribers, authorize recognition/completion, or prove
 * browser paint.
 *
 * The integration supplies true parent-page performance-clock fact timestamps
 * (never media PTS), calls acceptPublication only AFTER the store accepts a
 * semantic publication, and validates the matching target's actual DOM
 * visibility/class before acknowledging it. WeakMap sidecars leave canonical
 * snapshots unchanged.
 *
 * Caps are upper bounds, not promised capacity. The 64 KiB budget counts the
 * preallocated numeric sample ring plus UTF-8 serialized active metadata and
 * conservative record/control allowances. It is not a JS-engine heap estimate.
 * Weak identity sets do not retain snapshots or carry source metadata.
 */
import type {ObservationSource} from './observation-execution';
export const FEEDBACK_RECEIPT_CAPS=Object.freeze({pending:128,metadataBytes:64*1024,samples:2048});
const CONTROL_BYTES=2048;
const encoder=new TextEncoder();
const surfaces=['live-scrollbar','inventory-grid','recent-frame-grid'] as const;
const statuses=['tracking','hidden','captured','waiting','reading','read','review'] as const;
const factKinds=['viewport','crop-queued','read-task-start','read-task-end'] as const;
export type FeedbackSurface=typeof surfaces[number];
export type FeedbackStatus=typeof statuses[number];
export type FeedbackTarget=Readonly<{kind:'scrollbar'|'slot';key:string;status:FeedbackStatus}>;
export type FeedbackFact=Readonly<{
  /** Per-generation strictly increasing fact sequence; not any frame ID. */
  id:number;
  kind:'viewport'|'crop-queued'|'read-task-start'|'read-task-end';
  /** EXACT ObservationSource/acquisition namespace. frameId is not a physical
   * canonical source ID. captureTime keeps its original media/capture clock.
   * Physical lineage is intentionally absent; no archive identity is inferred. */
  source:Readonly<ObservationSource>|null;
  processingFrame:number|null;
  previewSampleId:number|null;
  attemptId:number|null;
  /** The sole timing origin in this fact: parent-page performance clock. */
  atMs:number;
  target:FeedbackTarget;
}>;
declare const factBrand:unique symbol;
declare const publicationBrand:unique symbol;
export type FeedbackFactHandle=Readonly<{[factBrand]:true}>;
export type FeedbackPublication=Readonly<{[publicationBrand]:true}>;
export type FeedbackReceiptLimits=Readonly<{pending:number;metadataBytes:number;samples:number}>;
export type FeedbackPublicationInput<T extends object>=Readonly<{
  accepted:true;snapshot:T;publicationId:number;
  bindings:readonly Readonly<{fact:FeedbackFactHandle;surface:FeedbackSurface;target:FeedbackTarget}>[];
}>;
export type FeedbackTargetReceiptInput<T extends object>=Readonly<{
  snapshot:T;publication:FeedbackPublication;fact:FeedbackFactHandle;
  surface:FeedbackSurface;target:FeedbackTarget;join:FeedbackFact;
}>;

type Diagnostic='metadata'|'ownership'|'clock'|'capacity'|'cancelled';
type Binding={fact:FeedbackFactHandle;surface:FeedbackSurface;target:FeedbackTarget;acked:boolean};
type FactRecord={value:FeedbackFact;registeredAtMs:number;bytes:number;publications:Set<FeedbackPublication>;acked:Set<FeedbackSurface>};
type PublicationRecord<T extends object>={snapshot:WeakRef<T>;id:number;atMs:number;bindings:Binding[];bytes:number};
const counters=()=>({
  factsOffered:0,factsAccepted:0,publicationsOffered:0,publicationsAccepted:0,
  acknowledgementsOffered:0,acknowledgements:0,duplicateAcks:0,
  unchangedPublications:0,unchangedFacts:0,unmatchedFacts:0,
  coalescedPublications:0,coalescedTargets:0,absentTargetReceipts:0,unmatchedTargets:0,
  rejectedMetadata:0,rejectedOwnership:0,rejectedClock:0,rejectedCapacity:0,
  callsAfterCancel:0,cancelledFacts:0,sampleOverwrites:0,
});

function fields(value:unknown,names:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('object');
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  if(keys.length!==names.length||keys.some(key=>typeof key!=='string'||!names.includes(key)))throw Error('keys');
  const result=Object.create(null) as Record<string,unknown>;
  for(const key of names){const descriptor=descriptors[key];
    if(!descriptor||!descriptor.enumerable||!('value' in descriptor))throw Error('data');
    result[key]=descriptor.value;
  }
  return result;
}
function array(value:unknown,limit:number):unknown[]{
  if(!Array.isArray(value))throw Error('array');
  const length=Object.getOwnPropertyDescriptor(value,'length')?.value;
  if(!Number.isInteger(length)||length<0||length>limit)throw Error('length');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==length+1)throw Error('array keys');
  return Array.from({length},(_,index)=>{
    const descriptor=descriptors[String(index)];
    if(!descriptor||!descriptor.enumerable||!('value' in descriptor))throw Error('array data');
    return descriptor.value;
  });
}
function identifier(value:unknown):string{
  // Small opaque IDs only. No URLs, page titles, free text, or pixels.
  if(typeof value!=='string'||! /^[A-Za-z0-9_.:@-]{1,160}$/.test(value))throw Error('identifier');
  return value;
}
function integer(value:unknown):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('integer');return value;
}
function time(value:unknown):number{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error('time');return value;
}
function target(value:unknown):FeedbackTarget{
  const data=fields(value,['kind','key','status']);
  if(!['scrollbar','slot'].includes(data.kind as string)||!statuses.includes(data.status as FeedbackStatus))throw Error('target');
  return Object.freeze({kind:data.kind as FeedbackTarget['kind'],key:identifier(data.key),status:data.status as FeedbackStatus});
}
function fact(value:unknown):FeedbackFact{
  const data=fields(value,['id','kind','source','processingFrame','previewSampleId','attemptId','atMs','target']);
  if(!['viewport','crop-queued','read-task-start','read-task-end'].includes(data.kind as string))throw Error('kind');
  let source:Readonly<ObservationSource>|null=null;
  if(data.source!==null){
    const raw=fields(data.source,['sessionId','frameId','observationId','captureOrder','captureTime','phase','slot']);
    if(raw.phase!=='input'&&raw.phase!=='recovery')throw Error('source phase');
    const slot=integer(raw.slot);if(slot>=40)throw Error('source slot');
    source=Object.freeze({sessionId:identifier(raw.sessionId),frameId:integer(raw.frameId),observationId:identifier(raw.observationId),
      captureOrder:integer(raw.captureOrder),captureTime:time(raw.captureTime),phase:raw.phase,slot});
  }
  const processingFrame=data.processingFrame===null?null:integer(data.processingFrame);
  const previewSampleId=data.previewSampleId===null?null:integer(data.previewSampleId);
  const attemptId=data.attemptId===null?null:integer(data.attemptId);
  if(data.kind==='viewport'&&(source!==null||processingFrame!==null||previewSampleId===null||attemptId!==null)||
    data.kind!=='viewport'&&(source===null||processingFrame===null||previewSampleId!==null||attemptId===null)||
    data.kind==='crop-queued'&&attemptId!==0||data.kind==='read-task-start'&&attemptId===0)throw Error('separate identities');
  const atMs=time(data.atMs);
  const expected=target(data.target);
  if(data.kind==='viewport'&&(expected.kind!=='scrollbar'||!['tracking','hidden'].includes(expected.status))||
    data.kind!=='viewport'&&expected.kind!=='slot'||
    data.kind==='crop-queued'&&!['captured','waiting'].includes(expected.status)||
    data.kind==='read-task-start'&&expected.status!=='reading'||
    data.kind==='read-task-end'&&!['waiting','read','review'].includes(expected.status))throw Error('fact target phase');
  return Object.freeze({id:integer(data.id),kind:data.kind as FeedbackFact['kind'],
    source,
    processingFrame,previewSampleId,attemptId,atMs,target:expected});
}
function byteSize(value:unknown){return encoder.encode(JSON.stringify(value)).byteLength;}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
function surface(value:unknown):FeedbackSurface{
  if(!surfaces.includes(value as FeedbackSurface))throw Error('surface');return value as FeedbackSurface;
}
function compatible(value:FeedbackSurface,expected:FeedbackTarget){
  return value==='live-scrollbar'?expected.kind==='scrollbar':expected.kind==='slot';
}
function limits(value:Partial<FeedbackReceiptLimits>|undefined):FeedbackReceiptLimits{
  if(value===undefined)return FEEDBACK_RECEIPT_CAPS;
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!Object.hasOwn(FEEDBACK_RECEIPT_CAPS,key)))throw new RangeError('Unknown receipt limit');
  const result:{pending:number;metadataBytes:number;samples:number}={...FEEDBACK_RECEIPT_CAPS};
  for(const key of Object.keys(result) as (keyof FeedbackReceiptLimits)[]){
    const descriptor=descriptors[key];if(!descriptor)continue;
    const proposed='value' in descriptor?descriptor.value:undefined;
    if(!descriptor.enumerable||typeof proposed!=='number'||!Number.isInteger(proposed)||proposed<1||proposed>FEEDBACK_RECEIPT_CAPS[key]){
      throw new RangeError(`Only a lower positive ${key} limit is allowed`);
    }
    result[key]=proposed;
  }
  if(CONTROL_BYTES+result.samples*(2*Float64Array.BYTES_PER_ELEMENT+Uint8Array.BYTES_PER_ELEMENT)>result.metadataBytes)throw new RangeError('Sample ring does not fit metadata budget');
  return Object.freeze(result);
}

export function createFeedbackFactReceipts<T extends object>(options:{now:()=>number;signal?:AbortSignal;limits?:Partial<FeedbackReceiptLimits>}){
  const cap=limits(options.limits);
  const readNow=options.now,signal=options.signal;
  const factSamples=new Float64Array(cap.samples),publicationSamples=new Float64Array(cap.samples);
  const sampleKinds=new Uint8Array(cap.samples);
  const baseBytes=CONTROL_BYTES+factSamples.byteLength+publicationSamples.byteLength+sampleKinds.byteLength;
  let offeredByKind=[0,0,0,0],receiptsByKind=[0,0,0,0];
  let metadataBytes=baseBytes,epoch=1,stopped=false,lastClock:number|undefined,lastFact=-1,lastPublication=-1;
  let sampleCount=0,sampleNext=0,count=counters(),lastDiagnostic:Diagnostic|null=null;
  const facts=new Map<FeedbackFactHandle,FactRecord>();
  const publications=new Map<FeedbackPublication,PublicationRecord<T>>();
  let marks=new WeakMap<T,FeedbackPublication>(),seenSnapshots=new WeakSet<T>();
  const reject=(reason:Diagnostic)=>{
    lastDiagnostic=reason;
    if(reason==='metadata')count.rejectedMetadata++;
    else if(reason==='ownership')count.rejectedOwnership++;
    else if(reason==='clock')count.rejectedClock++;
    else if(reason==='capacity')count.rejectedCapacity++;
    else count.callsAfterCancel++;
    return null;
  };
  const clock=():number|null=>{
    const generation=epoch;
    let value:number;
    try{value=readNow();}catch{return reject('clock');}
    if(generation!==epoch||stopped)return reject(stopped?'cancelled':'ownership');
    if(!Number.isFinite(value)||value<0||lastClock!==undefined&&value<lastClock)return reject('clock');
    lastClock=value;return value;
  };
  const dropFact=(handle:FeedbackFactHandle)=>{
    const record=facts.get(handle);if(!record)return;
    facts.delete(handle);metadataBytes-=record.bytes;
  };
  const release=(handle:FeedbackPublication)=>{
    const record=publications.get(handle);if(!record)return;
    const snapshot=record.snapshot.deref();if(snapshot&&marks.get(snapshot)===handle)marks.delete(snapshot);
    publications.delete(handle);metadataBytes-=record.bytes;
    for(const binding of record.bindings){
      const known=facts.get(binding.fact);if(!known)continue;
      known.publications.delete(handle);
      if(known.publications.size===0)dropFact(binding.fact);
    }
  };
  const clearPending=()=>{
    facts.clear();publications.clear();marks=new WeakMap();metadataBytes=baseBytes;
  };
  let signalListening=false;
  const cancel=()=>{
    if(signalListening){signal?.removeEventListener('abort',onAbort);signalListening=false;}
    if(stopped)return;
    count.cancelledFacts+=facts.size;stopped=true;epoch++;clearPending();
  };
  const onAbort=()=>{signalListening=false;cancel();};
  const attachSignal=()=>{
    if(signal&&!signalListening&&!signal.aborted){signal.addEventListener('abort',onAbort,{once:true});signalListening=true;}
  };
  const stoppedCall=()=>stopped?reject('cancelled'):false;
  if(signal?.aborted)cancel();else attachSignal();
  return {
    recordFact(value:unknown):FeedbackFactHandle|null{
      count.factsOffered++;if(stoppedCall()===null)return null;
      const generation=epoch;
      let parsed:FeedbackFact;
      try{parsed=fact(value);}catch{return reject('metadata');}
      offeredByKind[factKinds.indexOf(parsed.kind)]++;
      if(generation!==epoch||stopped)return reject(stopped?'cancelled':'ownership');
      if(parsed.id<=lastFact)return reject('metadata');
      const now=clock();if(now===null)return null;
      if(parsed.id<=lastFact)return reject('ownership');
      if(parsed.atMs>now)return reject('clock');
      const bytes=byteSize({fact:parsed,registeredAtMs:now})+128;
      if(facts.size>=cap.pending||metadataBytes+bytes>cap.metadataBytes)return reject('capacity');
      const handle=Object.freeze({}) as FeedbackFactHandle;
      facts.set(handle,{value:parsed,registeredAtMs:now,bytes,publications:new Set(),acked:new Set()});
      metadataBytes+=bytes;lastFact=parsed.id;count.factsAccepted++;return handle;
    },
    /** Hot-path admission needs only retained metadata, never percentile sorting
     * or a clock read. These numbers do not reserve or authorize a fact. */
    pendingUsage:()=>Object.freeze({pendingFacts:facts.size,metadataBytes}),
    getFact(handle:FeedbackFactHandle):FeedbackFact|null{return facts.get(handle)?.value??null;},
    /** Caller supplies the store's actual canonical snapshot after acceptance.
     * Reusing an unchanged snapshot cannot bind a newer source/attempt. */
    acceptPublication(value:unknown):FeedbackPublication|null{
      count.publicationsOffered++;if(stoppedCall()===null)return null;
      const generation=epoch;
      let snapshot:T,id:number,bindings:Binding[];
      try{
        const data=fields(value,['accepted','snapshot','publicationId','bindings']);
        if(data.accepted!==true||!data.snapshot||typeof data.snapshot!=='object')throw Error('semantic acceptance');
        snapshot=data.snapshot as T;id=integer(data.publicationId);
        const keys=new Set<string>();
        bindings=array(data.bindings,cap.pending).map(raw=>{
          const item=fields(raw,['fact','surface','target']),known=facts.get(item.fact as FeedbackFactHandle);
          if(!known)throw Error('unowned fact');
          const name=surface(item.surface),expected=target(item.target),key=`${known.value.id}:${name}`;
          if(!compatible(name,expected)||!same(expected,known.value.target)||keys.has(key))throw Error('target binding');
          keys.add(key);return {fact:item.fact as FeedbackFactHandle,surface:name,target:expected,acked:false};
        });
        if(bindings.length===0)throw Error('empty publication');
      }catch{return reject('metadata');}
      if(generation!==epoch||stopped)return reject(stopped?'cancelled':'ownership');
      if(seenSnapshots.has(snapshot)){count.unchangedPublications++;return null;}
      if(id<=lastPublication)return reject('ownership');
      const now=clock();if(now===null)return null;
      // now() is injected; same-generation reentrant close/discard/publication
      // calls must not turn detached records into fresh authority.
      if(id<=lastPublication||seenSnapshots.has(snapshot)||bindings.some(binding=>!facts.has(binding.fact)))return reject('ownership');
      const bytes=byteSize({id,atMs:now,bindings:bindings.map(binding=>({factId:facts.get(binding.fact)!.value.id,surface:binding.surface,target:binding.target}))})+128;
      const retainedBindings=[...publications.values()].reduce((total,publication)=>total+publication.bindings.length,0);
      if(publications.size>=cap.pending||retainedBindings+bindings.length>cap.pending||metadataBytes+bytes>cap.metadataBytes)return reject('capacity');
      const handle=Object.freeze({}) as FeedbackPublication;
      publications.set(handle,{snapshot:new WeakRef(snapshot),id,atMs:now,bindings,bytes});
      marks.set(snapshot,handle);seenSnapshots.add(snapshot);metadataBytes+=bytes;
      for(const binding of bindings)facts.get(binding.fact)!.publications.add(handle);
      lastPublication=id;count.publicationsAccepted++;return handle;
    },
    /** A matching target receipt, not a DOM/paint assertion by this bridge. */
    acknowledge(value:unknown):boolean{
      count.acknowledgementsOffered++;if(stoppedCall()===null)return false;
      let data:Record<string,unknown>,join:FeedbackFact,expected:FeedbackTarget,name:FeedbackSurface;
      try{
        data=fields(value,['snapshot','publication','fact','surface','target','join']);
        join=fact(data.join);expected=target(data.target);name=surface(data.surface);
      }catch{reject('metadata');return false;}
      const publication=publications.get(data.publication as FeedbackPublication),known=facts.get(data.fact as FeedbackFactHandle);
      if(!publication||!known||!data.snapshot||typeof data.snapshot!=='object'||
        publication.snapshot.deref()!==data.snapshot||marks.get(data.snapshot as T)!==data.publication){reject('ownership');return false;}
      const binding=publication.bindings.find(item=>item.fact===data.fact&&item.surface===name&&same(item.target,expected));
      if(!binding||!same(known.value,join)||!same(known.value.target,expected)){
        count.unmatchedTargets++;return false;
      }
      if(binding.acked||known.acked.has(name)){count.duplicateAcks++;return false;}
      const now=clock();if(now===null)return false;
      if(publications.get(data.publication as FeedbackPublication)!==publication||facts.get(data.fact as FeedbackFactHandle)!==known||
        marks.get(data.snapshot as T)!==data.publication){reject('ownership');return false;}
      if(binding.acked||known.acked.has(name)){count.duplicateAcks++;return false;}
      // Negative or invalid durations are rejected, never clamped into fake 0ms.
      if(now<publication.atMs||now<known.registeredAtMs||now<join.atMs){reject('clock');return false;}
      binding.acked=true;known.acked.add(name);count.acknowledgements++;
      if(sampleCount===cap.samples)count.sampleOverwrites++;
      factSamples[sampleNext]=now-join.atMs;
      publicationSamples[sampleNext]=now-publication.atMs;
      const kind=factKinds.indexOf(join.kind);sampleKinds[sampleNext]=kind;receiptsByKind[kind]++;
      sampleNext=(sampleNext+1)%cap.samples;sampleCount=Math.min(sampleCount+1,cap.samples);
      return true;
    },
    closePublication(handle:FeedbackPublication,outcome:'committed'|'coalesced'):boolean{
      if(stoppedCall()===null)return false;
      if(outcome!=='committed'&&outcome!=='coalesced'){reject('metadata');return false;}
      const publication=publications.get(handle);if(!publication){reject('ownership');return false;}
      if(outcome==='coalesced'&&publication.bindings.some(binding=>binding.acked)){reject('metadata');return false;}
      const absent=publication.bindings.filter(binding=>!binding.acked).length;
      if(outcome==='coalesced'){count.coalescedPublications++;count.coalescedTargets+=absent;}
      // This counts absent exact receipts, never inferred DOM invisibility.
      else count.absentTargetReceipts+=absent;
      release(handle);return true;
    },
    /** Unchanged/unmatched inputs never acquire a publication or latency 0. */
    discardFacts(value:readonly FeedbackFactHandle[],reason:'unchanged'|'unmatched'):boolean{
      if(stoppedCall()===null)return false;
      let handles:FeedbackFactHandle[];
      try{
        if(reason!=='unchanged'&&reason!=='unmatched')throw Error('reason');
        handles=array(value,cap.pending) as FeedbackFactHandle[];
        if(new Set(handles).size!==handles.length||handles.some(handle=>!facts.has(handle)||facts.get(handle)!.publications.size))throw Error('owned unbound facts');
      }catch{reject('metadata');return false;}
      if(reason==='unchanged')count.unchangedFacts+=handles.length;else count.unmatchedFacts+=handles.length;
      for(const handle of handles)dropFact(handle);return true;
    },
    cancel,
    reset():void{
      epoch++;clearPending();seenSnapshots=new WeakSet();
      factSamples.fill(0);publicationSamples.fill(0);sampleCount=sampleNext=0;
      sampleKinds.fill(0);offeredByKind=[0,0,0,0];receiptsByKind=[0,0,0,0];
      lastClock=undefined;lastFact=lastPublication=-1;count=counters();lastDiagnostic=null;
      stopped=signal?.aborted??false;if(!stopped)attachSignal();
    },
    stats(){
      const distribution=(values:Float64Array,kind?:number)=>{
        const sorted=Array.from(values.subarray(0,sampleCount)).filter((_value,index)=>kind===undefined||sampleKinds[index]===kind).sort((a,b)=>a-b);
        const at=(fraction:number)=>sorted.length?sorted[Math.ceil(sorted.length*fraction)-1]:null;
        return Object.freeze({p50Ms:at(.5),p95Ms:at(.95),maxMs:sorted.length?sorted[sorted.length-1]:null});
      };
      return Object.freeze({
        boundary:'page-clock-fact-to-injected-matching-target-receipt' as const,
        verification:'injected-receipt-only-dom-validation-external-no-paint-proof' as const,
        coverage:'partial-eligible-owned-bindings-only' as const,
        sampleWindow:'latest-successful-target-receipts-global-across-surfaces' as const,
        epoch,cancelled:stopped,pendingFacts:facts.size,pendingPublications:publications.size,
        retainedTargets:[...publications.values()].reduce((total,value)=>total+value.bindings.length,0),
        pendingTargets:[...publications.values()].reduce((total,value)=>total+value.bindings.filter(binding=>!binding.acked).length,0),
        metadataBytes,limits:cap,sampleCount,counters:Object.freeze({...count}),lastDiagnostic,
        factToReceipt:distribution(factSamples),publicationToReceipt:distribution(publicationSamples),
        byKind:Object.freeze(Object.fromEntries(factKinds.map((kind,index)=>[kind,Object.freeze({
          offeredValidFacts:offeredByKind[index],receipts:receiptsByKind[index],
          samples:Array.from(sampleKinds.subarray(0,sampleCount)).filter(value=>value===index).length,
          factToReceipt:distribution(factSamples,index),publicationToReceipt:distribution(publicationSamples,index),
        })]))),
      });
    },
  };
}
