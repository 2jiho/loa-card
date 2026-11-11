/** Experimental, standalone admission ledger. It neither starts OCR nor adds
 * recognition evidence. The caller must verify and persist physical source
 * receipts; an input callback, timer tick, or synthetic frame ID alone is not
 * proof of a new physical frame. Replaying recorded events preserves their
 * original `origin`; creating an event from a replay has origin `replay`.
 * This reducer is deliberately not connected to the scanner yet. */
export interface RetryReceipt {
  session:string;
  pixel:string;
  input:string;
  sourceFrame:string;
  capturedAt:number;
  origin:'live'|'replay'|'synthetic';
  stable:boolean;
}
type Entry = {original:RetryReceipt;originalState:'active'|'timeout'|'other';generation:number;
  retry?:{receipt:RetryReceipt;id:string;generation:number;state:'queued'|'active'|'spent'}};
export interface RetryLedger {session:string;capacity:number;concurrency:number;entries:Record<string,Entry>}
export type RetryEvent =
  | {type:'original-started';receipt:RetryReceipt}
  | {type:'original-finished';pixel:string;input:string;sourceFrame:string;outcome:'timeout'|'other'}
  | {type:'queue-accepted';id:string;receipt:RetryReceipt}
  | {type:'queue-rejected';id:string;receipt:RetryReceipt}
  | {type:'retry-started'|'retry-finished'|'retry-cancelled';pixel:string;id:string;generation:number};
export interface RetryTransition {state:RetryLedger;accepted:boolean;reason:string}

const MAX_ENTRIES=2048,MAX_CONCURRENCY=32,MAX_ID_LENGTH=256;
function identifier(value:unknown):value is string {
  if(typeof value!=='string'||!value.length||value.length>MAX_ID_LENGTH||
    value==='__proto__'||value==='constructor'||value==='prototype')return false;
  for(let i=0;i<value.length;i++)if(value.charCodeAt(i)<32||value.charCodeAt(i)===127)return false;
  return true;
}

/** Only event values are untrusted. Ledger state must originate from this reducer,
 * never directly from a deserialized checkpoint. Rebuild it by replaying events.
 * Snapshot descriptors instead of invoking getters or reading an object twice. */
function dataObject(value:unknown):Record<string,unknown>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const proto=Object.getPrototypeOf(value);
  if(proto!==Object.prototype&&proto!==null)return;
  const descriptors=Object.getOwnPropertyDescriptors(value),out:Record<string,unknown>=Object.create(null);
  for(const key of Reflect.ownKeys(descriptors)) {
    if(typeof key!=='string')return;
    const descriptor=descriptors[key];
    if(!('value' in descriptor))return;
    out[key]=descriptor.value;
  }
  return out;
}
function keys(object:Record<string,unknown>,expected:string[]) {
  return Object.keys(object).length===expected.length&&expected.every(key=>Object.hasOwn(object,key));
}
function receipt(value:unknown):RetryReceipt|undefined {
  const v=dataObject(value);
  if(!v||!keys(v,['session','pixel','input','sourceFrame','capturedAt','origin','stable'])||
    !identifier(v.session)||!identifier(v.pixel)||!identifier(v.input)||!identifier(v.sourceFrame)||
    typeof v.capturedAt!=='number'||!Number.isFinite(v.capturedAt)||v.capturedAt<0||v.capturedAt>Number.MAX_SAFE_INTEGER||
    (v.origin!=='live'&&v.origin!=='replay'&&v.origin!=='synthetic')||typeof v.stable!=='boolean')return;
  return {session:v.session,pixel:v.pixel,input:v.input,sourceFrame:v.sourceFrame,capturedAt:v.capturedAt,
    origin:v.origin,stable:v.stable};
}
export function parseRetryEvent(value:unknown):RetryEvent|undefined {
  const v=dataObject(value);
  if(!v)return;
  if(v.type==='original-started'||v.type==='queue-accepted'||v.type==='queue-rejected') {
    const original=v.type==='original-started',r=receipt(v.receipt);
    if(!r||!keys(v,original?['type','receipt']:['type','receipt','id']))return;
    if(original)return {type:'original-started',receipt:r};
    if(!identifier(v.id))return;
    return {type:v.type as 'queue-accepted'|'queue-rejected',receipt:r,id:v.id};
  }
  if(v.type==='original-finished') {
    if(!keys(v,['type','pixel','input','sourceFrame','outcome'])||!identifier(v.pixel)||
      !identifier(v.input)||!identifier(v.sourceFrame)||(v.outcome!=='timeout'&&v.outcome!=='other'))return;
    return {type:'original-finished',pixel:v.pixel,input:v.input,sourceFrame:v.sourceFrame,outcome:v.outcome};
  }
  if(v.type==='retry-started'||v.type==='retry-finished'||v.type==='retry-cancelled') {
    if(!keys(v,['type','pixel','id','generation'])||!identifier(v.pixel)||!identifier(v.id)||
      !Number.isSafeInteger(v.generation)||(v.generation as number)<1)return;
    return {type:v.type,pixel:v.pixel,id:v.id,generation:v.generation as number};
  }
}
export function createRetryLedger(session:string,capacity=2048,concurrency=1):RetryLedger {
  if(!identifier(session)||!Number.isSafeInteger(capacity)||capacity<1||capacity>MAX_ENTRIES||
    !Number.isSafeInteger(concurrency)||concurrency<1||concurrency>MAX_CONCURRENCY)
    throw Error('Invalid retry ledger limits');
  return {session,capacity,concurrency,entries:{}};
}
function valid(receipt:RetryReceipt,session:string) {
  return receipt.session===session&&!!receipt.pixel&&!!receipt.input&&!!receipt.sourceFrame&&
    Number.isFinite(receipt.capturedAt)&&receipt.origin==='live';
}
function occupied(state:RetryLedger) {
  return Object.values(state.entries).filter(e=>e.retry?.state==='queued'||e.retry?.state==='active').length;
}
/** Admission must be rechecked atomically when queue acceptance is committed.
 * Tombstones remain until session reset: eviction cannot refund retry tokens.
 * At capacity we reject new originals rather than silently forget spent ones.
 * Successful updates copy at most 2048 entries, O(n) time and O(n) transient
 * references per event; this prototype is not suitable for a hot path without
 * measuring and addressing that cost. */
export function reduceRetryLedger(state:RetryLedger,input:unknown):RetryTransition {
  const no=(reason:string):RetryTransition=>({state,accepted:false,reason});
  let event:RetryEvent|undefined;
  try {event=parseRetryEvent(input);} catch {return no('invalid-event');}
  if(!event)return no('invalid-event');
  const put=(pixel:string,entry:Entry,reason:string):RetryTransition=>({
    state:{...state,entries:{...state.entries,[pixel]:entry}},accepted:true,reason});
  if(event.type==='original-started') {
    const r=event.receipt;
    if(!valid(r,state.session))return no('invalid-source');
    if(Object.hasOwn(state.entries,r.pixel))return no('already-registered');
    if(Object.keys(state.entries).length>=state.capacity)return no('capacity');
    return put(r.pixel,{original:{...r},originalState:'active',generation:0},'registered');
  }
  if(event.type==='queue-accepted'||event.type==='queue-rejected') {
    const r=event.receipt,entry=Object.hasOwn(state.entries,r.pixel)?state.entries[r.pixel]:undefined;
    if(!valid(r,state.session)||!r.stable||!event.id)return no('invalid-source');
    if(!entry||entry.originalState!=='timeout')return no('original-not-timed-out');
    if(r.input===entry.original.input||r.sourceFrame===entry.original.sourceFrame||r.capturedAt<=entry.original.capturedAt)
      return no('not-a-new-source');
    if(entry.retry)return no('retry-unavailable');
    if(event.type==='queue-rejected')return no('queue-rejected');
    if(occupied(state)>=state.concurrency)return no('concurrency');
    if(entry.generation>=Number.MAX_SAFE_INTEGER)return no('generation-exhausted');
    const generation=entry.generation+1;
    return put(r.pixel,{...entry,generation,retry:{receipt:{...r},id:event.id,generation,state:'queued'}},'queued');
  }
  const entry=Object.hasOwn(state.entries,event.pixel)?state.entries[event.pixel]:undefined;
  if(!entry)return no('unknown-pixel');
  if(event.type==='original-finished') {
    if(entry.originalState!=='active'||event.input!==entry.original.input||event.sourceFrame!==entry.original.sourceFrame)
      return no('original-mismatch');
    return put(event.pixel,{...entry,originalState:event.outcome},'original-finished');
  }
  const retry=entry.retry;
  if(!retry||retry.id!==event.id||retry.generation!==event.generation)return no('retry-mismatch');
  if(event.type==='retry-cancelled'&&retry.state==='queued') {
    const {retry:_,...rest}=entry;
    return put(event.pixel,rest,'cancelled-before-start');
  }
  if(event.type==='retry-started'&&retry.state==='queued')
    return put(event.pixel,{...entry,retry:{...retry,state:'active'}},'started');
  if((event.type==='retry-finished'||event.type==='retry-cancelled')&&retry.state==='active')
    return put(event.pixel,{...entry,retry:{...retry,state:'spent'}},'spent');
  return no('invalid-transition');
}
