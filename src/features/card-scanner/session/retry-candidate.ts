import type {InventorySource} from './inventory-evidence';

/** A late worker result cannot replace a newer capture. At the same capture
 * time retain the better field geometry/stability, never completion order. */
export function replaceRetry(previous: {order:number;stable:boolean;borderAlignment:number}, next: {order:number;stable:boolean;borderAlignment:number}) {
  if (next.order < previous.order) return false;
  if (previous.stable && !next.stable) return false;
  if (next.order === previous.order && next.stable === previous.stable)
    return next.borderAlignment > previous.borderAlignment;
  return true;
}

/** A new usable raw-field selection must survive even when its first view has
 * not settled. Other pending replacements retain the existing stability guard. */
export function replacePendingCandidate(previous:{order:number;stable:boolean},next:{order:number;stable:boolean;changedFields?:boolean}) {
  return next.order>=previous.order&&(!previous.stable||next.stable||next.changedFields===true&&next.order>previous.order);
}

export function replaceRetryCandidate<T extends {order:number;stable:boolean;borderAlignment:number}>(queue:T[],index:number,next:T,release:(old:T)=>void) {
  const old=queue[index];
  if(!old||!replaceRetry(old,next))return false;
  queue[index]=next;release(old);return true;
}

export interface RetrySourceCandidate {
  group:number;source:InventorySource;needsIdentity?:boolean;fieldTarget?:{id:string;order:number};
  image?:object;previewCanvas?:object;execution?:object;savedObservation?:object;
}

/** A fuzzy group is only scheduling information. Even for the same card,
 * different source observations and identity/field work retain their pixels. */
function sameRetrySource(a:RetrySourceCandidate,b:RetrySourceCandidate):boolean {
  const x=a.source,y=b.source;
  return a.group===b.group&&x.sessionId===y.sessionId&&x.frameId===y.frameId&&
    x.observationId===y.observationId&&x.captureOrder===y.captureOrder&&x.captureTime===y.captureTime&&
    x.phase===y.phase&&x.slot===y.slot&&x.frame===y.frame;
}
export function retryCandidateIndex<T extends RetrySourceCandidate>(queue:readonly T[],candidate:T){
  return queue.findIndex(old=>sameRetryCandidate(old,candidate));
}
function sameRetryCandidate(a:RetrySourceCandidate,b:RetrySourceCandidate):boolean {
  return sameRetrySource(a,b)&&a.needsIdentity===b.needsIdentity&&
    a.fieldTarget?.id===b.fieldTarget?.id&&a.fieldTarget?.order===b.fieldTarget?.order;
}
/** No unrelated raster is evicted when the bounded queue is full. The caller
 * owns an unqueued candidate and must preserve any unresolved evidence. */
export function admitRetryCandidate<T extends RetrySourceCandidate & {order:number;stable:boolean;borderAlignment:number}>(
  queue:T[],candidate:T,capacity:number,release:(old:T)=>void,
):'queued'|'replaced'|'present'|'full'|'ownership-conflict' {
  if(!Number.isSafeInteger(capacity)||capacity<0)throw TypeError('Invalid retry capacity');
  // The scanner normally moves one source serially between lanes. If a
  // producer ever duplicates ownership, neither a replacement release nor an
  // unretained caller's cleanup may silently close another queued candidate.
  let previous=-1;
  for(let index=0;index<queue.length;index++){
    const old=queue[index];
    if(candidate.image&&candidate.image===old.image||candidate.previewCanvas&&candidate.previewCanvas===old.previewCanvas||
       candidate.execution&&candidate.execution===old.execution)return 'ownership-conflict';
    // An exact saved observation may legitimately be reused across separately
    // captured sources. Same-source duplicate ownership can mark the shared
    // freshness receipt finished while its other retry is still waiting.
    if(candidate.savedObservation&&candidate.savedObservation===old.savedObservation&&sameRetrySource(old,candidate))
      return 'ownership-conflict';
    if(previous<0&&sameRetryCandidate(old,candidate))previous=index;
  }
  if(previous>=0)return replaceRetryCandidate(queue,previous,candidate,release)?'replaced':'present';
  if(queue.length>=capacity)return 'full';
  queue.push(candidate);return 'queued';
}
