import type {ObservationSource} from './observation-execution';
import {FRESHNESS_EVIDENCE_LIMITS,type FreshnessAcceptedEntry,type FreshnessBinding,type FreshnessCheckpoint,
  type FreshnessFact,type FreshnessGuardKind,type FreshnessLineage,type FreshnessLoss,type FreshnessPendingEntry,
  type FreshnessSeed,type FreshnessSnapshot} from './freshness-evidence-types';

export * from './freshness-evidence-types';

const LOSS_ORDER:readonly FreshnessLoss[]=['fact-limit','event-sink-failed','association-conflict'];
const GUARD_ORDER:readonly FreshnessGuardKind[]=['capture','recovery','final'];
const MAX_SNAPSHOT_BYTES=16*1024*1024;
const DIGEST=/^[a-f0-9]{64}$/;
function fail(detail:string):never {throw Error(`Invalid freshness evidence: ${detail}`);}
/** Inspect data descriptors before reading a field. An accessor must never be
 * invoked and then mistaken for a detached, recorded fact. */
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('plain object required');
  const names=Reflect.ownKeys(value),result:Record<string,unknown>=Object.create(null);
  if(names.length!==keys.length||names.some(key=>typeof key!=='string'||!keys.includes(key)))fail('unexpected or missing property');
  for(const key of keys){
    const field=Object.getOwnPropertyDescriptor(value,key);
    if(!field||!('value' in field)||!field.enumerable)fail('own data property required');
    result[key]=field.value;
  }
  return result;
}
function integer(value:unknown,minimum=0):number {
  if(!Number.isSafeInteger(value)||(value as number)<minimum)fail('safe integer required');
  return value as number;
}
function finite(value:unknown):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail('nonnegative finite number required');
  return value;
}
function text(value:unknown,limit=160,empty=false):string {
  if(typeof value!=='string'||!empty&&!value.length||value.length>limit||value.includes('\0'))fail('string length');
  return value;
}
function bool(value:unknown):boolean {if(typeof value!=='boolean')fail('boolean required');return value;}
function sourceFrom(value:unknown):ObservationSource {
  const source=object(value,['sessionId','frameId','observationId','captureOrder','captureTime','phase','slot']);
  if(source.phase!=='input'&&source.phase!=='recovery')fail('source phase');
  const slot=integer(source.slot);if(slot>=40)fail('source slot');
  return Object.freeze({sessionId:text(source.sessionId),frameId:integer(source.frameId),
    observationId:text(source.observationId),captureOrder:integer(source.captureOrder),
    captureTime:finite(source.captureTime),phase:source.phase,slot});
}
function bindingFrom(value:unknown):FreshnessBinding {
  const binding=object(value,['key','order','frame','stable']);
  return Object.freeze({key:text(binding.key),order:integer(binding.order),frame:text(binding.frame,512),stable:bool(binding.stable)});
}
function reviewFrom(value:unknown):readonly string[] {
  if(!Array.isArray(value)||value.length>16)fail('review array');
  const result:string[]=[];
  for(let i=0;i<value.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
    if(!descriptor||!('value' in descriptor))fail('review data entry required');
    result.push(text(descriptor.value,256,true));
  }
  if(Reflect.ownKeys(value).length!==value.length+1)fail('unexpected review property');
  return Object.freeze(result);
}
function sameSource(a:ObservationSource,b:ObservationSource):boolean {
  return a.sessionId===b.sessionId&&a.frameId===b.frameId&&a.observationId===b.observationId&&
    a.captureOrder===b.captureOrder&&a.captureTime===b.captureTime&&a.phase===b.phase&&a.slot===b.slot;
}
function sameBinding(a:FreshnessBinding,b:FreshnessBinding):boolean {
  return a.key===b.key&&a.order===b.order&&a.frame===b.frame&&a.stable===b.stable;
}
export function parseFreshnessSeed(value:unknown):FreshnessSeed {
  const seed=object(value,['version','sessionId','limits']);if(seed.version!==1)fail('seed version');
  const limits=object(seed.limits,['groups','facts']),groups=integer(limits.groups,1),facts=integer(limits.facts,1);
  if(groups>FRESHNESS_EVIDENCE_LIMITS.groups||facts>FRESHNESS_EVIDENCE_LIMITS.facts)fail('limits exceed policy');
  return Object.freeze({version:1,sessionId:text(seed.sessionId),limits:Object.freeze({groups,facts})});
}
export function parseFreshnessFact(value:unknown):FreshnessFact {
  if(!value||typeof value!=='object')fail('fact object');
  const kindField=Object.getOwnPropertyDescriptor(value,'kind');
  if(!kindField||!('value' in kindField))fail('fact kind data property');
  const kind=kindField.value;
  if(kind==='settle'){
    const fact=object(value,['version','kind']);if(fact.version!==1)fail('fact version');
    return Object.freeze({version:1,kind});
  }
  if(kind==='guard-check'){
    const fact=object(value,['version','kind','guard','unresolved','settled']);
    if(fact.version!==1||!GUARD_ORDER.includes(fact.guard as FreshnessGuardKind))fail('guard version/kind');
    const unresolved=integer(fact.unresolved),settled=bool(fact.settled);
    if(unresolved>FRESHNESS_EVIDENCE_LIMITS.groups+1||settled!==(unresolved===0))fail('guard count/settled');
    return Object.freeze({version:1,kind,guard:fact.guard as FreshnessGuardKind,unresolved,settled});
  }
  if(kind==='identity-linked'){
    const fact=object(value,['version','kind','binding','source','pixelKey','id','review']);
    if(fact.version!==1)fail('fact version');
    return Object.freeze({version:1,kind,binding:bindingFrom(fact.binding),source:sourceFrom(fact.source),
      pixelKey:text(fact.pixelKey,1024),id:text(fact.id),review:reviewFrom(fact.review)});
  }
  if(kind!=='accepted'&&kind!=='rejected')fail('fact kind');
  const keys=['version','kind','group','time','source','binding','pixelKey'];
  const fact=object(value,kind==='accepted'?[...keys,'fieldRevision','requiresProof']:keys);
  if(fact.version!==1)fail('fact version');
  const source=sourceFrom(fact.source),time=finite(fact.time);
  if(source.captureTime!==time)fail('capture time/source mismatch');
  const base={version:1 as const,group:integer(fact.group),time,source,pixelKey:text(fact.pixelKey,1024)};
  if(kind==='rejected')return Object.freeze({...base,kind,binding:fact.binding===null?null:bindingFrom(fact.binding)});
  return Object.freeze({...base,kind,binding:bindingFrom(fact.binding),
    fieldRevision:fact.fieldRevision===null?null:text(fact.fieldRevision,1024),requiresProof:bool(fact.requiresProof)});
}
export function parseFreshnessCheckpoint(value:unknown):FreshnessCheckpoint {
  const checkpoint=object(value,['version','complete','events','hash']);
  if(checkpoint.version!==1)fail('checkpoint version');
  const complete=bool(checkpoint.complete),events=integer(checkpoint.events);
  if(complete?(typeof checkpoint.hash!=='string'||!DIGEST.test(checkpoint.hash)):checkpoint.hash!==null)
    fail('checkpoint completeness/hash');
  return Object.freeze({version:1,complete,events,hash:checkpoint.hash as string|null});
}

type RetainedLineage=Omit<FreshnessLineage,'identity'>&{identity:FreshnessLineage['identity'];references:number};
interface SourceAlias {readonly source:ObservationSource;readonly bindingKey:string|null;references:number}
export interface FreshnessEvidenceOptions {
  /** This is the actual shared inventory reducer's current field-proof map.
   * No count, review projection, or caller-supplied resolved flag substitutes it. */
  readonly confirmedFields:()=>ReadonlyMap<string,number>;
  readonly onEvent?:(fact:FreshnessFact)=>void|boolean;
  readonly onIncomplete?:(loss:FreshnessLoss)=>void;
}

/** Image-free completion-debt authority. The retry cache/WeakSet remain a
 * separate scheduler. State-changing settle commands preserve the original lazy
 * retirement/eviction order; neither snapshot nor hash silently settles debt. */
export class FreshnessEvidence {
  private readonly seedValue:FreshnessSeed;
  private readonly options:FreshnessEvidenceOptions;
  private readonly accepted=new Map<number,FreshnessAcceptedEntry>();
  private readonly pending=new Map<number,FreshnessPendingEntry>();
  private readonly lineages=new Map<string,RetainedLineage>();
  // Index only aliases referenced by current accepted/debt/lineage records.
  // Refcounts make each admission/read O(1); this is not whole-run history.
  private readonly aliases=new Map<string,SourceAlias>();
  private readonly losses=new Set<FreshnessLoss>();
  private readonly guards=new Map<FreshnessGuardKind,{readonly guard:FreshnessGuardKind;readonly unresolved:number;readonly settled:boolean;readonly fact:number}>();
  private facts=0;
  private lostChange=false;

  constructor(seed:FreshnessSeed,options:FreshnessEvidenceOptions){
    this.seedValue=parseFreshnessSeed(seed);this.options=options;
    if(!options||typeof options.confirmedFields!=='function')fail('confirmed field view required');
  }
  hasBinding(key:string):boolean {return this.lineages.has(key);}
  markIncomplete(loss:FreshnessLoss):void {
    if(!LOSS_ORDER.includes(loss))fail('loss kind');
    if(this.losses.has(loss))return;
    this.losses.add(loss);
    try{this.options.onIncomplete?.(loss);}catch{/* Recording failure is not an OCR failure. */}
  }
  private conflict(detail:string):never {
    this.lostChange=true;this.markIncomplete('association-conflict');fail(detail);
  }
  private aliasKey(source:ObservationSource):string {return `${source.sessionId}\0${source.observationId}`;}
  private source(source:ObservationSource,binding:FreshnessBinding|null):void {
    if(source.sessionId!==this.seedValue.sessionId)this.conflict('session mismatch');
    if(binding&&binding.order!==source.captureOrder)this.conflict('binding/source capture order mismatch');
    const old=this.aliases.get(this.aliasKey(source));
    if(old&&(!sameSource(old.source,source)||old.bindingKey!==(binding?.key??null)))this.conflict('source alias changed');
  }
  private retainSource(source:ObservationSource,key:string|null):void {
    const id=this.aliasKey(source),old=this.aliases.get(id);
    if(old){
      if(!sameSource(old.source,source)||old.bindingKey!==key)this.conflict('source alias changed');
      old.references++;
    }else this.aliases.set(id,{source,bindingKey:key,references:1});
  }
  private releaseSource(source:ObservationSource):void {
    const id=this.aliasKey(source),old=this.aliases.get(id);
    if(!old||!sameSource(old.source,source))this.conflict('retained source alias missing');
    if(--old.references===0)this.aliases.delete(id);
    else if(old.references<0)this.conflict('negative source alias reference count');
  }
  private dropLineage(key:string,lineage:RetainedLineage):void {
    this.lineages.delete(key);this.releaseSource(lineage.originSource);
    if(lineage.identity)this.releaseSource(lineage.identity.source);
  }
  private lineage(binding:FreshnessBinding,source:ObservationSource,pixelKey:string):RetainedLineage {
    const old=this.lineages.get(binding.key);
    if(old){
      if(!sameBinding(old.binding,binding))this.conflict('observation binding changed');
      return old;
    }
    const lineage:RetainedLineage={binding,pixelKey,originSource:source,identity:null,references:0};
    this.retainSource(source,binding.key);this.lineages.set(binding.key,lineage);return lineage;
  }
  private retain(key:string|null):void {if(key!==null)this.lineages.get(key)!.references++;}
  private release(key:string|null):void {
    if(key===null)return;
    const lineage=this.lineages.get(key);if(!lineage)this.conflict('retained lineage missing');
    if(--lineage.references===0)this.dropLineage(key,lineage);
    else if(lineage.references<0)this.conflict('negative lineage reference count');
  }
  private resolved(key:string|null,proofs:ReadonlyMap<string,number>):boolean {
    if(key===null)return false;
    const lineage=this.lineages.get(key);
    if(!lineage)this.conflict('pending lineage missing');
    const identity=lineage.identity;if(!identity||identity.review.length)return false;
    const order=proofs.get(identity.id);
    return typeof order==='number'&&Number.isFinite(order)&&order>=lineage.binding.order;
  }
  private pendingChange(group:number,time:number,source:ObservationSource,key:string|null,pixelKey:string):void {
    const old=this.pending.get(group);if(old&&time<old.time)return;
    this.retain(key);
    this.retainSource(source,key);
    this.pending.delete(group);this.pending.set(group,Object.freeze({group,time,source,bindingKey:key,pixelKey}));
    if(old){this.release(old.bindingKey);this.releaseSource(old.source);}
    while(this.pending.size>this.seedValue.limits.groups){
      const oldest=this.pending.keys().next().value!,entry=this.pending.get(oldest)!;
      if(!this.resolved(entry.bindingKey,this.options.confirmedFields()))this.lostChange=true;
      this.pending.delete(oldest);this.release(entry.bindingKey);this.releaseSource(entry.source);
    }
  }
  private settlePending():number {
    if(!this.pending.size)return Number(this.lostChange);
    const proofs=this.options.confirmedFields();
    for(const [group,entry] of this.pending)if(this.resolved(entry.bindingKey,proofs)){
      this.pending.delete(group);this.release(entry.bindingKey);this.releaseSource(entry.source);
    }
    return this.pending.size+Number(this.lostChange);
  }
  private countAfterSettle():number {
    if(!this.pending.size)return Number(this.lostChange);
    const proofs=this.options.confirmedFields();let unresolved=Number(this.lostChange);
    for(const entry of this.pending.values())if(!this.resolved(entry.bindingKey,proofs))unresolved++;
    return unresolved;
  }
  apply(value:unknown):void {
    const fact=parseFreshnessFact(value);
    if(fact.kind==='accepted'||fact.kind==='rejected'){
      this.source(fact.source,fact.binding);
      const old=this.accepted.get(fact.group);
      if(!old||fact.time>=old.time){
        // Even a rejected input can be recovered by its exact retained logical
        // observation, but rejecting it never commits pixels to the retry cache.
        if(fact.binding)this.lineage(fact.binding,fact.source,fact.pixelKey);
        const key=fact.binding?.key??null;
        if(fact.kind==='accepted'){
          const changed=fact.fieldRevision!==null&&old?.fieldRevision!==undefined&&old.fieldRevision!==null&&fact.fieldRevision!==old.fieldRevision;
          // Retain before replacing debt, since the very same lineage may be
          // both the old accepted representative and its latest exact use.
          this.retain(key);
          this.retainSource(fact.source,key);
          if(fact.requiresProof||changed||this.pending.has(fact.group))this.pendingChange(fact.group,fact.time,fact.source,key,fact.pixelKey);
          this.accepted.delete(fact.group);
          this.accepted.set(fact.group,Object.freeze({group:fact.group,time:fact.time,source:fact.source,
            bindingKey:fact.binding.key,pixelKey:fact.pixelKey,fieldRevision:fact.fieldRevision}));
          if(old){this.release(old.bindingKey);this.releaseSource(old.source);}
          while(this.accepted.size>this.seedValue.limits.groups){
            const oldest=this.accepted.keys().next().value!,entry=this.accepted.get(oldest)!;
            this.accepted.delete(oldest);this.release(entry.bindingKey);this.releaseSource(entry.source);
          }
        }else{
          const previous=this.pending.get(fact.group);
          this.pendingChange(fact.group,fact.time,fact.source,key,fact.pixelKey);
          // An older rejection may be ignored by a newer pending debt. It must
          // not leave an otherwise unreferenced lineage behind.
          if(previous&&fact.time<previous.time&&key!==null){
            const unused=this.lineages.get(key);
            if(unused?.references===0)this.dropLineage(key,unused);
          }
        }
      }
    }else if(fact.kind==='identity-linked'){
      this.source(fact.source,fact.binding);
      const lineage=this.lineages.get(fact.binding.key);
      if(!lineage)this.conflict('identity has no retained binding');
      if(!sameBinding(lineage.binding,fact.binding))this.conflict('identity binding changed');
      // Preserve actual assignment order for a shared mutable observation. This
      // fact links an observed identity, not a proof that the model was correct.
      this.retainSource(fact.source,fact.binding.key);
      if(lineage.identity)this.releaseSource(lineage.identity.source);
      lineage.identity=Object.freeze({id:fact.id,review:fact.review,source:fact.source,pixelKey:fact.pixelKey});
    }else if(fact.kind==='settle')this.settlePending();
    else{
      const unresolved=this.settlePending();
      if(unresolved!==fact.unresolved||(unresolved===0)!==fact.settled)this.conflict('guard disagrees with current field proof');
      this.guards.set(fact.guard,Object.freeze({guard:fact.guard,unresolved,settled:fact.settled,fact:this.facts+1}));
    }
    this.facts++;
    if(this.facts>this.seedValue.limits.facts)this.markIncomplete('fact-limit');
    else if(this.options.onEvent)try{if(this.options.onEvent(fact)===false)this.markIncomplete('event-sink-failed');}
    catch{this.markIncomplete('event-sink-failed');}
  }
  settle():number {
    const count=this.countAfterSettle();
    // No-op UI queries neither change lazy eviction state nor need a recorded
    // command. Preserve the event budget for actual retirement and guard facts.
    if(count===this.pending.size+Number(this.lostChange))return count;
    this.apply({version:1,kind:'settle'});return this.pending.size+Number(this.lostChange);
  }
  guard(guard:FreshnessGuardKind):{unresolved:number;settled:boolean} {
    // Compute a claim without mutating. apply() performs the one recorded
    // settlement, so live execution and ordered replay have the same command.
    const unresolved=this.countAfterSettle(),settled=unresolved===0;
    this.apply({version:1,kind:'guard-check',guard,unresolved,settled});return {unresolved,settled};
  }
  snapshot():FreshnessSnapshot {
    const losses=Object.freeze(LOSS_ORDER.filter(loss=>this.losses.has(loss)));
    const lineages=[...this.lineages.values()].sort((a,b)=>a.binding.key<b.binding.key?-1:a.binding.key>b.binding.key?1:0)
      .map(({binding,pixelKey,originSource,identity})=>Object.freeze({binding,pixelKey,originSource,identity}));
    return Object.freeze({version:1,scope:'freshness-evidence',seed:this.seedValue,facts:this.facts,
      complete:losses.length===0,losses,lostChange:this.lostChange,
      accepted:Object.freeze([...this.accepted.values()]),pending:Object.freeze([...this.pending.values()]),
      lineages:Object.freeze(lineages),guards:Object.freeze(GUARD_ORDER.flatMap(guard=>{const value=this.guards.get(guard);return value?[value]:[];}))});
  }
}

/** Snapshots are produced by the common authority; canonical order retains
 * accepted/debt insertion order because it controls bounded eviction. */
export async function hashFreshnessEvidence(snapshot:FreshnessSnapshot):Promise<string> {
  const json=JSON.stringify(snapshot),bytes=new TextEncoder().encode(json);
  if(bytes.byteLength>MAX_SNAPSHOT_BYTES)fail('snapshot byte limit');
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
