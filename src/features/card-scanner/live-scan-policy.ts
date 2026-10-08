/** Track acquisition latency independently of recognition. The next delivered
 * video callback and the scanner's single-flight guard provide backpressure. */
export class LiveScanCadence {
  private next = -Infinity;
  private cost = 0;
  take(now: number) { return now >= this.next; }
  complete(start: number, end: number) {
    this.cost = this.cost ? this.cost * .7 + (end - start) * .3 : end - start;
    // Worker wall time is not main-thread work. Adding a fraction of it here
    // skipped fresh video frames after the Worker was already idle.
    this.next = end;
  }
  get acquisitionMs() { return this.cost; }
}

/** Recovery must never make an older count newer just because it was read later. */
export function timedCaptureOrder(seed: number, seconds: number, slot: number) {
  return seed + 1 + Math.max(0, Math.round(seconds * 1_000_000)) * 40 + slot;
}

/** High-core devices isolate short OCR from long fallback reads. */
export function liveLanePlan(cores: number) {
 return cores >= 8 ? { fast: 2, readers: 4 } : cores >= 4 ? { fast: 1, readers: 2 } : { fast: 1, readers: 1 };
}

/** Reserve the first OCR lane for short work while input is live. It must not
 * start a slow fallback just because the short queue is momentarily empty.
 * The other lane prefers full work and helps with short work when idle. */
export function liveOcrLane(shortJobs:number,fullJobs:number,lane:number,ocrLanes:number,
 live:boolean,schedule:LiveOcrSchedule):'short'|'full'|undefined {
 if(live&&ocrLanes>=2) {
  if(lane===0)return shortJobs>0?'short':undefined;
  return fullJobs>0?'full':shortJobs>0?'short':undefined;
 }
 return schedule.next(shortJobs,fullJobs);
}

/** Give new short retries priority without starving retained full OCR jobs. */
export class LiveOcrSchedule {
 private shortStreak=0;
 next(shortJobs:number,fullJobs:number):'short'|'full'|undefined {
  if(fullJobs>0&&(shortJobs===0||this.shortStreak>=8)){
   this.shortStreak=0;return 'full';
  }
  if(shortJobs>0){this.shortStreak=Math.min(8,this.shortStreak+1);return 'short';}
  return undefined;
 }
}

/** Preserve every retry; unknown identities precede known-card field checks. */
export function shiftOcrRetry<T extends { needsIdentity?: boolean }>(queue:T[],priority?:(item:T)=>number,preferFields=false):T|undefined {
 const unknown=!preferFields&&queue.some(item=>item.needsIdentity);
 let index=-1,score=Infinity;
 for(let i=0;i<queue.length;i++) {
  if(unknown&&!queue[i].needsIdentity)continue;
  if(preferFields&&queue[i].needsIdentity)continue;
  const candidate=priority?.(queue[i])??0;
  if(index<0||candidate<score){index=i;score=candidate;}
  if(score===0)break;
 }
 return index<0?undefined:queue.splice(index,1)[0];
}

/** Preserve name throughput while giving unresolved counters a bounded turn.
 * Rechecks already covered by a reliable newer observation cannot consume it.
 */
export class LiveRetrySchedule {
 private names=0;
 shift<T extends {needsIdentity?:boolean;fieldTarget?:{id:string;order:number}}>(queue:T[],priority:(item:T)=>number) {
  const fields=this.names>=8&&queue.some(item=>!item.needsIdentity&&item.fieldTarget&&priority(item)<1_000_000);
  const item=shiftOcrRetry(queue,priority,fields);
  if(item)this.names=item.needsIdentity?Math.min(8,this.names+1):0;
  return item;
 }
}

/** A known name is not a completed counter. Only a reliable observation at
 * the same or a newer capture time can make a pending field check redundant.
 * This function only orders jobs. Proven obsolete field retries are pruned
 * separately; unknown identities and newer observations remain eligible.
 */
export function retryWorkPriority(item:{needsIdentity?:boolean;fieldTarget?:{id:string;order:number}},
  groupReads:number,confirmedFields:ReadonlyMap<string,number>) {
  if(item.needsIdentity||!item.fieldTarget)return groupReads;
  const confirmed=confirmedFields.get(item.fieldTarget.id);
  if(confirmed===undefined)return 0;
  return confirmed>=item.fieldTarget.order ? 1_000_000+groupReads : 1+groupReads;
}
