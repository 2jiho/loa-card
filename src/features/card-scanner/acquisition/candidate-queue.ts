import type {InventorySource} from '../session/inventory-evidence';

/** A fuzzy group may hold different inputs. This scheduling key preserves the
 * full source; it is never a proof that two sources represent the same card. */
export function sourceCandidateKey(item:{group:number;source:InventorySource}):string {
  const s=item.source;
  return JSON.stringify([item.group,s.sessionId,s.frameId,s.observationId,s.captureOrder,s.captureTime,s.phase,s.slot,s.frame]);
}

/** v2 has no proof that a fuzzy duplicate is the same card. Keep it as a
 * bounded candidate; saturation is reported separately as unknown input. */
export function candidateOffer(decision:'new'|'better'|'duplicate',hasRetainedObservation:boolean,sourceScoped:boolean) {
  return hasRetainedObservation || (sourceScoped&&decision==='duplicate') ? 'better' : decision;
}

/** A fuzzy group is a scheduling hint, not proof that its pending crop was
 * already read. Both policies must finish or explicitly retire queued work. */
export function sourceQueueSettled(_sourceScoped:boolean,pending:number):boolean {
  return pending===0;
}

export type CandidateAdmission = 'queued' | 'replaced' | 'present' | 'full' | 'ownership-conflict';
export type CandidateReplacement<T> =
  | { status:'replaced'; previous:T }
  | { status:'missing'|'present'|'ownership-conflict'|'untracked'|'cancelled' };

/** Group-keyed by default; callers may isolate pending crops by exact source.
 * An optional ownership extractor tracks raster/work objects in O(1) per
 * object. A rejected candidate remains owned by the caller; an ownership
 * conflict must be handled without closing resources already in the queue. */
export class CandidateQueue<T extends { group: number }> {
  private values = new Map<number|string, T>();
  private ownedByKey = new Map<number|string, readonly object[]>();
  private resourceOwner = new WeakMap<object, number|string>();
  private capacity: number;
  private release: (item: T) => void;
  private replace:(previous:T,next:T)=>boolean;
  private key:(item:T)=>number|string;
  private readonly ownership?: (item:T)=>readonly object[];
  private transferring = false;
  private mutationDepth = 0;
  constructor(capacity: number, release: (item: T) => void,
    replace:(previous:T,next:T)=>boolean=()=>true,key:(item:T)=>number|string=item=>item.group,
    ownership?:(item:T)=>readonly object[]) {
    if(!Number.isSafeInteger(capacity)||capacity<0)throw new TypeError('Invalid candidate capacity');
    this.capacity = capacity; this.release = release;this.replace=replace;this.key=key;this.ownership=ownership;
  }
  get length() { return this.values.size; }
  push(item: T): boolean {
    const result=this.pushDetailed(item);
    return result==='queued'||result==='replaced';
  }
  /** In particular, `replaced` means the previously queued item was released;
   * a caller using fuzzy keys must record that its source was not read. `full`
   * rejects the new source without evicting an existing candidate. */
  pushDetailed(item: T): CandidateAdmission {
    this.assertNotTransferring();
    this.assertNotMutating();
    this.mutationDepth++;
    try {
    const key=this.key(item),previous = this.values.get(key);
    const owned=this.ownership?.(item);
    if(owned?.length){
      const unique=new Set<object>();
      for(const resource of owned){
        if(typeof resource!=='object'||resource===null)throw new TypeError('Invalid candidate resource');
        if(unique.has(resource)||this.resourceOwner.has(resource))return 'ownership-conflict';
        unique.add(resource);
      }
    }
    if(previous&&!this.replace(previous,item))return 'present';
    if (!previous && this.values.size >= this.capacity) return 'full';
    // Keep both the pending entry and its ownership guard until release has
    // succeeded. A failed release must abort scanning: it may have partially
    // disposed the item, but its resources cannot be admitted a second time.
    if (previous) { this.release(previous);this.forgetOwnership(key); }
    this.values.set(key, item);
    if(owned?.length){this.ownedByKey.set(key,owned.slice());for(const resource of owned)this.resourceOwner.set(resource,key);}
    return previous?'replaced':'queued';
    } finally { this.mutationDepth--; }
  }
  /** Replace without disposing the old item. On success the queue owns the new
   * item and the caller owns `previous`; all other outcomes leave both owners
   * unchanged. The caller must reserve space for `previous` beforehand and
   * retain or explicitly retire it if a later operation fails. The queue can
   * guard aliases only for resources reported by its ownership extractor; the
   * caller is responsible for ownership outside this queue.
   *
   * All user callbacks run before mutation. There is no commit or cleanup
   * callback whose failure could leave the ownership transfer ambiguous. */
  replaceAndTake(item:T, options?:{signal?:AbortSignal}):CandidateReplacement<T> {
    this.assertNotTransferring();
    if(this.mutationDepth)throw new Error('Candidate queue mutation is already in progress');
    if(!this.ownership)return {status:'untracked'};
    this.transferring=true;
    try {
      if(options?.signal?.aborted)return {status:'cancelled'};
      const key=this.key(item),previous=this.values.get(key);
      if(!previous)return {status:'missing'};
      // Materialize before committing: even a lazy iterable or getter must
      // fail while the previous candidate is still owned by the queue.
      const owned=Array.from(this.ownership(item));
      const unique=new Set<object>();
      for(const resource of owned){
        if(typeof resource!=='object'||resource===null)throw new TypeError('Invalid candidate resource');
        if(unique.has(resource)||this.resourceOwner.has(resource))return {status:'ownership-conflict'};
        unique.add(resource);
      }
      if(previous===item)return {status:'ownership-conflict'};
      if(!this.replace(previous,item))return {status:'present'};
      if(options?.signal?.aborted)return {status:'cancelled'};
      // Only native map operations remain after this point; no caller code runs
      // between removing the old guard and installing the new one.
      this.forgetOwnership(key);
      this.values.set(key,item);
      if(owned.length){this.ownedByKey.set(key,owned);for(const resource of owned)this.resourceOwner.set(resource,key);}
      return {status:'replaced',previous};
    } finally { this.transferring=false; }
  }
  shift(priority?: (item:T)=>number): T | undefined {
    this.assertNotTransferring();
    this.assertNotMutating();
    this.mutationDepth++;
    try {
    let selected: T | undefined,selectedKey:number|string|undefined, score=Infinity;
    for(const [key,item] of this.values) {
      const next=priority?.(item)??0;
      if(!selected||next<score){selected=item;selectedKey=key;score=next;}
      if(!priority||score===0)break;
    }
    if(selectedKey!==undefined){this.values.delete(selectedKey);this.forgetOwnership(selectedKey);}
    return selected;
    } finally { this.mutationDepth--; }
  }
  private forgetOwnership(key:number|string) {
    for(const resource of this.ownedByKey.get(key)??[])this.resourceOwner.delete(resource);
    this.ownedByKey.delete(key);
  }
  private assertNotTransferring() {
    if(this.transferring)throw new Error('Candidate queue transfer is already in progress');
  }
  private assertNotMutating() {
    if(this.mutationDepth)throw new Error('Candidate queue mutation is already in progress');
  }
  clear() {
    this.assertNotTransferring();
    this.assertNotMutating();
    this.mutationDepth++;
    try {
    // Delete each successfully released entry immediately. If a later release
    // throws, its entry and the remaining entries keep their ownership guards,
    // and a later cleanup cannot release already completed entries twice.
    for (const [key,value] of this.values) {this.release(value);this.values.delete(key);this.forgetOwnership(key);}
    } finally { this.mutationDepth--; }
  }
}
