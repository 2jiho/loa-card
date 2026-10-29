export interface FreshRetryPlan<T> {
  reason:'fresh-pixels'|'latest-proof'|'changed-fields';
  /** Only exact pixel/geometry receipts may lend their already-confirmed identity. */
  exactConfirmed?:T;
}
/** Scheduling and completion debt have different authorities. A scanner may
 * inject the source-bound common reducer without serializing its WeakSet. */
export interface FreshCompletionDebt<T> {
  remember(group:number,pixel:string,time:number,observation:T,fieldRevision?:string,requiresProof?:boolean):void;
  rejectChanged(group:number,time:number,observation?:T):void;
  unresolvedChanges():number;
}
/** Reopen unresolved work for fresh stable input. A previously resolved group
 * also needs a new proof when a later capture of its card remains unconfirmed.
 * Field revisions only select work: they never lend identity or field proof.
 * Holds metadata, never rasters. CandidateQueue owns the one pending crop. */
export class FreshObservations<T extends object> {
  private entries = new Map<number, { pixel: string; time: number; observation: T; fieldRevision?:string; stable?:boolean }>();
  private changed = new Map<number,{time:number;observation?:T}>();
  private lostChange=false;
  private finished = new WeakSet<T>();
  private limit: number;
  private resolvedFields:(observation:T)=>boolean;
  private readonly debt?:FreshCompletionDebt<T>;
  constructor(limit = 2048,resolvedFields:(observation:T)=>boolean=()=>false,debt?:FreshCompletionDebt<T>) {
    if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid fresh observation limit');
    this.limit = limit;
    this.resolvedFields=resolvedFields;
    this.debt=debt;
  }
  /** Commit only after queue acceptance. A rejected crop must remain admissible. */
  remember(group: number, pixel: string, time: number, observation: T,fieldRevision?:string,requiresProof=false) {
    const old=this.entries.get(group);
    if(old&&time<old.time)return;
    const changed=!!fieldRevision&&!!old?.fieldRevision&&fieldRevision!==old.fieldRevision;
    if(this.debt)this.debt.remember(group,pixel,time,observation,fieldRevision,requiresProof);
    else if(requiresProof||changed||this.changed.has(group))this.trackChange(group,time,observation);
    this.entries.delete(group);
    const stable=(observation as {stable?:boolean}).stable;
    this.entries.set(group, { pixel, time, observation,...(fieldRevision?{fieldRevision,stable}:{}) });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
  private trackChange(group:number,time:number,observation?:T) {
    const old=this.changed.get(group);
    if(old&&time<old.time)return;
    this.changed.delete(group);this.changed.set(group,{time,observation});
    while(this.changed.size>this.limit){
      const key=this.changed.keys().next().value!,entry=this.changed.get(key)!;
      if(!entry.observation||!this.resolvedFields(entry.observation))this.lostChange=true;
      this.changed.delete(key);
    }
  }
  /** Queue rejection retains completion debt without remembering discarded pixels. */
  rejectChanged(group:number,time:number,observation?:T) {
    const accepted=this.entries.get(group);
    if(accepted&&time<accepted.time)return;
    if(this.debt)this.debt.rejectChanged(group,time,observation);
    else this.trackChange(group,time,observation);
  }
  unresolvedChanges() {
    if(this.debt)return this.debt.unresolvedChanges();
    for(const [group,entry] of this.changed)
      if(entry.observation&&this.resolvedFields(entry.observation))this.changed.delete(group);
    return this.changed.size+Number(this.lostChange);
  }
  finish(observation: T | undefined) { if (observation) this.finished.add(observation); }
  retry(group: number, pixel: string, time: number, stable: boolean, resolved: (observation: T) => boolean) {
    return !!this.retryPlan(group,pixel,time,stable,resolved);
  }
  retryPlan(group:number,pixel:string,time:number,stable:boolean,resolved:(observation:T)=>boolean,
    needsLatestProof:(observation:T)=>boolean=()=>false,fieldRevision?:string):FreshRetryPlan<T>|undefined {
    const old = this.entries.get(group);
    if(!Number.isFinite(time))return;
    // The visual grouping cache may outlive this smaller metadata cache.
    // Missing freshness metadata cannot certify a duplicate as already read.
    if(!old)return fieldRevision?{reason:'changed-fields'}:undefined;
    if(time<old.time)return;
    // Preserve a briefly visible usable field even while the old read is active.
    // A settled view can also improve its first unsettled reading. Neither path
    // refunds the exact pixel's read budget or lends the old identity.
    if(fieldRevision&&old.fieldRevision&&
      (pixel!==old.pixel&&fieldRevision!==old.fieldRevision||stable&&old.stable===false))
      return {reason:'changed-fields'};
    if(!stable)return;
    if(time-old.time<.75||!this.finished.has(old.observation))return;
    if(resolved(old.observation)) {
      if(!needsLatestProof(old.observation))return;
      return {reason:'latest-proof',...(pixel===old.pixel?{exactConfirmed:old.observation}:{})};
    }
    if(pixel!==old.pixel)return {reason:'fresh-pixels'};
  }
}
