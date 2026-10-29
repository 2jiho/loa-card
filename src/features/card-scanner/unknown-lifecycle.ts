import {parseObservationFact, type ObservationSource} from './observation-execution';
import {UNKNOWN_LIFECYCLE_LIMITS, type UnknownCheckpoint, type UnknownEffect, type UnknownEntry,
  type UnknownFact, type UnknownKey, type UnknownLoss, type UnknownSeed, type UnknownSnapshot,
  type UnknownUpsert} from './unknown-lifecycle-types';

const ID_LIMIT=160, REASON_LIMIT=256;
const LOSS_ORDER:readonly UnknownLoss[]=['fact-limit','group-limit','event-sink-failed'];
type GroupKey=Extract<UnknownKey,{kind:'group'}>;
type Proof={readonly key:GroupKey;readonly state:{readonly cardId:string;readonly order:number}|null};
function fail(detail:string):never {throw new Error(`Invalid unknown lifecycle: ${detail}`);}
function object(value:unknown,keys:readonly string[],required=keys):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('plain object required');
  const result=value as Record<string,unknown>;
  if(Object.keys(result).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(result,key)))
    fail('unexpected or missing property');
  return result;
}
function integer(value:unknown,minimum=0):number {
  if(!Number.isSafeInteger(value)||(value as number)<minimum)fail('integer required');
  return value as number;
}
function finite(value:unknown):number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail('nonnegative finite number required');
  return value;
}
function text(value:unknown,limit=ID_LIMIT):string {
  if(typeof value!=='string'||!value.length||value.length>limit)fail('string length');
  return value;
}
function keyFrom(value:unknown):UnknownKey {
  const key=object(value,['kind','sessionId','group','entryId'],['kind','sessionId']);
  const sessionId=text(key.sessionId);
  if(key.kind==='group') {
    if(!Object.hasOwn(key,'group')||Object.hasOwn(key,'entryId'))fail('group key');
    return Object.freeze({kind:'group',sessionId,group:integer(key.group)});
  }
  if(key.kind!=='legacy'||!Object.hasOwn(key,'entryId')||Object.hasOwn(key,'group'))fail('legacy key');
  return Object.freeze({kind:'legacy',sessionId,entryId:text(key.entryId)});
}
function sourceFrom(value:unknown):ObservationSource {
  return parseObservationFact({version:1,kind:'queued',attemptId:0,source:value}).source;
}
function locationFrom(value:unknown):UnknownUpsert['location'] {
  if(value===null)return null;
  const location=object(value,['percent','column','row'],['percent','column']);
  const percent=finite(location.percent),column=integer(location.column,1);
  if(percent>100||column>10)fail('location outside captured grid');
  return Object.freeze({percent,column,...(Object.hasOwn(location,'row')?{row:integer(location.row,1)}:{})});
}

export function parseUnknownSeed(value:unknown):UnknownSeed {
  const seed=object(value,['version','sessionId','origin','limits']);
  if(seed.version!==1||(seed.origin!=='scan'&&seed.origin!=='legacy-import'))fail('seed version/origin');
  const limits=object(seed.limits,['active','facts','groups']);
  const active=integer(limits.active),facts=integer(limits.facts),groups=integer(limits.groups);
  if(active>UNKNOWN_LIFECYCLE_LIMITS.active||facts>UNKNOWN_LIFECYCLE_LIMITS.facts||
    groups>UNKNOWN_LIFECYCLE_LIMITS.groups)fail('limits exceed policy');
  return Object.freeze({version:1,sessionId:text(seed.sessionId),origin:seed.origin,
    limits:Object.freeze({active,facts,groups})});
}

/** Reject rather than normalize malformed evidence into a complete event. */
export function parseUnknownFact(value:unknown):UnknownFact {
  const kind=object(value,['version','kind','key','source','captureOrder','captureTime','pending','reason','location','cause','proof'],
    ['version','kind','key']);
  if(kind.version!==1)fail('fact version');
  const key=keyFrom(kind.key);
  if(kind.kind==='upsert') {
    const fact=object(value,['version','kind','key','source','captureOrder','captureTime','pending','reason','location']);
    if(typeof fact.pending!=='boolean')fail('pending boolean');
    const source=fact.source===null?null:sourceFrom(fact.source);
    const captureOrder=fact.captureOrder===null?null:integer(fact.captureOrder);
    const captureTime=fact.captureTime===null?null:finite(fact.captureTime);
    if(key.kind==='group'&&(!source||captureOrder===null||captureTime===null))fail('group source required');
    if(source&&(source.sessionId!==key.sessionId||source.captureOrder!==captureOrder||source.captureTime!==captureTime))
      fail('source binding');
    if(key.kind==='legacy'&&(source!==null||captureOrder!==null||captureTime!==null))fail('legacy source must be absent');
    return Object.freeze({version:1,kind:'upsert',key,source,captureOrder,captureTime,pending:fact.pending,
      reason:text(fact.reason,REASON_LIMIT),location:locationFrom(fact.location)});
  }
  if(kind.kind!=='retire')fail('fact kind');
  const fact=object(value,['version','kind','key','cause','proof']);
  if(key.kind!=='group'||fact.cause!=='confirmed-name')fail('retire proof kind');
  const proof=object(fact.proof,['cardId','source']),source=sourceFrom(proof.source);
  if(source.sessionId!==key.sessionId)fail('proof session binding');
  return Object.freeze({version:1,kind:'retire',cause:'confirmed-name',key,
    proof:Object.freeze({cardId:text(proof.cardId),source})});
}

export function parseUnknownCheckpoint(value:unknown):UnknownCheckpoint {
  const checkpoint=object(value,['version','complete','events','hash']);
  if(checkpoint.version!==1||typeof checkpoint.complete!=='boolean')fail('checkpoint version/complete');
  if(checkpoint.hash!==null&&(typeof checkpoint.hash!=='string'||!/^[a-f0-9]{64}$/.test(checkpoint.hash)))fail('checkpoint hash');
  if(checkpoint.complete&&checkpoint.hash===null||!checkpoint.complete&&checkpoint.hash!==null)fail('checkpoint completeness/hash');
  return Object.freeze({version:1,complete:checkpoint.complete,events:integer(checkpoint.events),hash:checkpoint.hash});
}

export function unknownKeyId(value:UnknownKey):string {
  const key=keyFrom(value);
  return JSON.stringify(key.kind==='group'?['group',key.sessionId,key.group]:['legacy',key.sessionId,key.entryId]);
}
export function unknownVersionId(entry:UnknownEntry):string {
  // Exact warning version, independent of optional images and diagnostic text.
  const fact=parseUnknownFact({version:1,kind:'upsert',key:entry.key,source:entry.source,captureOrder:entry.captureOrder,
    captureTime:entry.captureTime,pending:entry.pending,reason:entry.reason,location:entry.location});
  if(fact.kind!=='upsert')fail('warning version');
  return JSON.stringify([unknownKeyId(fact.key),fact.source,fact.captureOrder,fact.captureTime,fact.pending]);
}
function compareKey(a:UnknownKey,b:UnknownKey):number {
  if(a.sessionId!==b.sessionId)return a.sessionId<b.sessionId?-1:1;
  if(a.kind!==b.kind)return a.kind==='group'?-1:1;
  if(a.kind==='group'&&b.kind==='group')return a.group-b.group;
  const as=(a as Extract<UnknownKey,{kind:'legacy'}>).entryId,bs=(b as Extract<UnknownKey,{kind:'legacy'}>).entryId;
  return as<bs?-1:as>bs?1:0;
}
function entryFrom(fact:UnknownUpsert,ordinal:number):UnknownEntry {
  return Object.freeze({key:fact.key,source:fact.source,captureOrder:fact.captureOrder,captureTime:fact.captureTime,
    pending:fact.pending,reason:fact.reason,location:fact.location,ordinal});
}
function effect(changed=false,accepted=true,suppressedReason:UnknownEffect['suppressedReason']=null,
  upserted:UnknownEntry|null=null,retiredVersions:readonly UnknownEntry[]=[]):UnknownEffect {
  return Object.freeze({changed,accepted,suppressedReason,upserted,retiredVersions:Object.freeze([...retiredVersions])});
}

/** Image-free authority shared by live scanning and ordered event replay.
 * Capture order decides recency; arrival order breaks equal final failures. */
export class UnknownLifecycle {
  private readonly seed:UnknownSeed;
  private entries=new Map<string,UnknownEntry>();
  private proofs=new Map<string,Proof>();
  private facts=0;
  private ordinal=0;
  private losses=new Set<UnknownLoss>();
  private eventSinkFailed=false;
  private readonly options:{onEvent?:(fact:UnknownFact)=>void;onIncomplete?:(loss:UnknownLoss)=>void};
  constructor(seed:UnknownSeed,options:{onEvent?:(fact:UnknownFact)=>void;
    onIncomplete?:(loss:UnknownLoss)=>void}={}) {this.seed=parseUnknownSeed(seed);this.options=options;}

  markIncomplete(loss:UnknownLoss):void {
    if(!LOSS_ORDER.includes(loss))fail('loss kind');
    if(this.losses.has(loss))return;
    this.losses.add(loss);
    try{this.options.onIncomplete?.(loss);}catch{/* diagnostics cannot roll back live state */}
  }
  private covers(entry:Pick<UnknownEntry,'key'|'captureOrder'>):boolean {
    if(entry.key.kind!=='group'||entry.captureOrder===null)return false;
    const proof=this.proofs.get(unknownKeyId(entry.key));
    return !!proof?.state&&proof.state.order>=entry.captureOrder;
  }
  apply(value:UnknownFact):UnknownEffect {
    const fact=parseUnknownFact(value);
    if(fact.key.sessionId!==this.seed.sessionId)fail('seed session binding');
    if(fact.key.kind==='legacy'&&this.seed.origin!=='legacy-import')fail('legacy fact requires import seed');
    if(this.facts===Number.MAX_SAFE_INTEGER)fail('fact counter exhausted');
    this.facts++;
    if(this.facts>this.seed.limits.facts)this.markIncomplete('fact-limit');
    let result:UnknownEffect;
    const id=unknownKeyId(fact.key);
    if(fact.kind==='upsert') {
      const previous=this.entries.get(id);
      if(this.covers(fact))result=effect(false,false,'covered');
      else if(previous&&fact.captureOrder!==null&&previous.captureOrder!==null&&fact.captureOrder<previous.captureOrder)
        result=effect(false,false,'older');
      else if(previous&&fact.captureOrder===previous.captureOrder&&(!previous.pending||fact.pending))
        result=effect(false,false,'tied');
      else if(!previous&&this.entries.size>=this.seed.limits.active)result=effect(false,false,'active-limit');
      else {
        const entry=entryFrom(fact,previous?.ordinal??this.ordinal++);
        this.entries.set(id,entry);result=effect(true,true,null,entry);
      }
    } else {
      const previous=this.proofs.get(id);
      let proofChanged=false;
      if(previous!==undefined) {
        if(previous.state!==null) {
          const state=previous.state.cardId!==fact.proof.cardId?null:
            Object.freeze({cardId:fact.proof.cardId,order:Math.max(previous.state.order,fact.proof.source.captureOrder)});
          proofChanged=state===null||state.order!==previous.state.order;
          if(proofChanged)this.proofs.set(id,Object.freeze({key:fact.key,state}));
        }
      } else if(this.proofs.size>=this.seed.limits.groups)this.markIncomplete('group-limit');
      else {
        this.proofs.set(id,Object.freeze({key:fact.key,state:Object.freeze({cardId:fact.proof.cardId,
          order:fact.proof.source.captureOrder})}));proofChanged=true;
      }
      const retired:UnknownEntry[]=[];
      // Match the former linkIdentity all-active sweep, not just this group.
      for(const [entryId,entry] of this.entries)if(this.covers(entry)) {
        retired.push(entry);this.entries.delete(entryId);
      }
      result=effect(proofChanged||retired.length>0,true,null,null,retired);
    }
    if(this.facts<=this.seed.limits.facts&&!this.eventSinkFailed)try{this.options.onEvent?.(fact);}
    catch{this.eventSinkFailed=true;this.markIncomplete('event-sink-failed');}
    return result;
  }
  confirmName(key:GroupKey,cardId:string,source:ObservationSource,review:readonly string[]):UnknownEffect|undefined {
    if(review.includes('이름 확인')||!Number.isFinite(source.captureOrder))return;
    return this.apply({version:1,kind:'retire',cause:'confirmed-name',key,proof:{cardId,source}});
  }
  active():readonly UnknownEntry[] {return Object.freeze([...this.entries.values()]);}
  snapshot():UnknownSnapshot {
    return Object.freeze({version:1,scope:'unknown-lifecycle',seed:this.seed,facts:this.facts,
      complete:this.losses.size===0,losses:Object.freeze(LOSS_ORDER.filter(loss=>this.losses.has(loss))),
      active:Object.freeze([...this.entries.values()].sort((a,b)=>compareKey(a.key,b.key))),
      proofs:Object.freeze([...this.proofs.values()].sort((a,b)=>compareKey(a.key,b.key)))});
  }
}

/** Stable image-free state hash; incomplete state never claims equality. */
export async function hashUnknownLifecycle(value:UnknownSnapshot):Promise<string|null> {
  const snapshot=object(value,['version','scope','seed','facts','complete','losses','active','proofs']);
  if(snapshot.version!==1||snapshot.scope!=='unknown-lifecycle'||typeof snapshot.complete!=='boolean')fail('snapshot version/scope');
  const seed=parseUnknownSeed(snapshot.seed),facts=integer(snapshot.facts);
  if(!Array.isArray(snapshot.losses)||snapshot.losses.length>LOSS_ORDER.length||
    snapshot.losses.some(loss=>!LOSS_ORDER.includes(loss))||new Set(snapshot.losses).size!==snapshot.losses.length)fail('snapshot losses');
  const lossValues=snapshot.losses as UnknownLoss[];
  const losses=LOSS_ORDER.filter(loss=>lossValues.includes(loss));
  if(snapshot.complete!==(losses.length===0)||facts>seed.limits.facts&&!losses.includes('fact-limit'))fail('snapshot completeness');
  if(!Array.isArray(snapshot.active)||snapshot.active.length>seed.limits.active||
    !Array.isArray(snapshot.proofs)||snapshot.proofs.length>seed.limits.groups)fail('snapshot size');
  const seenKeys=new Set<string>(),seenOrdinals=new Set<number>();
  const active=snapshot.active.map(value=>{
    const input=object(value,['key','source','captureOrder','captureTime','pending','reason','location','ordinal']);
    const {ordinal,...rest}=input;
    const fact=parseUnknownFact({version:1,kind:'upsert',...rest});
    if(fact.kind!=='upsert'||fact.key.sessionId!==seed.sessionId||fact.key.kind==='legacy'&&seed.origin!=='legacy-import')fail('snapshot entry binding');
    const parsed=entryFrom(fact,integer(ordinal)),id=unknownKeyId(parsed.key);
    if(parsed.ordinal>=facts||seenKeys.has(id)||seenOrdinals.has(parsed.ordinal))fail('invalid/duplicate snapshot entry');
    seenKeys.add(id);seenOrdinals.add(parsed.ordinal);return parsed;
  }).sort((a,b)=>compareKey(a.key,b.key));
  seenKeys.clear();
  const proofs=snapshot.proofs.map(value=>{
    const input=object(value,['key','state']),key=keyFrom(input.key);
    if(key.kind!=='group'||key.sessionId!==seed.sessionId)fail('snapshot proof binding');
    const id=unknownKeyId(key);if(seenKeys.has(id))fail('duplicate snapshot proof');seenKeys.add(id);
    const state=input.state===null?null:object(input.state,['cardId','order']);
    return Object.freeze({key,state:state===null?null:Object.freeze({cardId:text(state.cardId),order:integer(state.order)})});
  }).sort((a,b)=>compareKey(a.key,b.key));
  if(!snapshot.complete)return null;
  const canonical={version:1,scope:'unknown-lifecycle',seed,facts,complete:true,losses,active,proofs};
  const bytes=new TextEncoder().encode(JSON.stringify(canonical));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('');
}
