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

/** A scheduling vector is not identity proof. Separate observed groups must
 * keep their own retry even when downsampled artwork/fields look similar. */
export function retryCandidateIndex<T extends {group:number}>(queue:readonly T[],candidate:T){
  return queue.findIndex(old=>old.group===candidate.group);
}
