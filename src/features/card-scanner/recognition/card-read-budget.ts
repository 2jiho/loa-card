export class CardReadTimeout extends Error {
  constructor(){super('카드 판독 시간 초과 · 다시 보여 주세요');this.name='CardReadTimeout';}
}
/** No reader was admitted for this exact crop/stage. This is not evidence
 * that an operation timed out, and it does not grant a fresh read budget. */
export class CardReadAdmissionDenied extends Error {
  constructor(){super('판독 시도 제한 · 카드 다시 확인 필요');this.name='CardReadAdmissionDenied';}
}
/** A different operation retired this worker generation. No result was read. */
export class CardReadInterrupted extends Error {
  constructor(){super('OCR 세대 교체 · 카드 다시 확인 필요');this.name='CardReadInterrupted';}
}
/** A non-budget OCR worker did not finish initialization before its deadline. */
export class OcrInitializationTimeout extends Error {
  constructor(){super('OCR 초기화 시간 초과 · 다시 시도해 주세요');this.name='OcrInitializationTimeout';}
}
/** An OCR input outside the isolated per-canvas allocation limit is unresolved. */
export class OcrImageLimit extends Error {
  constructor(){super('OCR 입력 크기 제한 · 해상도를 낮춰 다시 보여 주세요');this.name='OcrImageLimit';}
}
/** All listed outcomes remain unresolved; none establishes a card value. */
export function isIncompleteCardRead(error:unknown):error is CardReadTimeout|CardReadAdmissionDenied|CardReadInterrupted|OcrInitializationTimeout|OcrImageLimit {
  return error instanceof CardReadTimeout||error instanceof CardReadAdmissionDenied||error instanceof CardReadInterrupted||error instanceof OcrInitializationTimeout||error instanceof OcrImageLimit;
}
/** Processing time only; time spent waiting in a queue is not charged. */
export class CardReadBudget {
  private until:number;
  private now:()=>number;
  private expired=false;
  private timeouts?:WeakSet<CardReadTimeout>;
  private interruptedOperations?:WeakSet<CardReadTimeout>;
  private pending?:Set<Promise<void>>;
  private cleanupFailed=false;
  private readonly trackQuiescence:boolean;
  constructor(milliseconds=3000,now=()=>performance.now(),trackQuiescence=false){this.now=now;this.until=now()+milliseconds;this.trackQuiescence=trackQuiescence;}
  remaining(){return Math.max(0,this.until-this.now());}
  private timeout(operationStarted=false){
    const error=new CardReadTimeout();this.expired=true;(this.timeouts??=new WeakSet()).add(error);
    if(operationStarted)(this.interruptedOperations??=new WeakSet()).add(error);
    return error;
  }
  /** An admission failure or another reader's timeout is not this budget's timeout. */
  ownsTimeout(error:unknown):boolean{return error instanceof CardReadTimeout&&this.timeouts?.has(error)===true;}
  /** Unlike check(), this timer expired while a wait operation was in flight. */
  interruptedOperation(error:unknown):boolean{return error instanceof CardReadTimeout&&this.interruptedOperations?.has(error)===true;}
  check(){if(this.expired||!this.remaining())throw this.timeout();}
  private track(work:Promise<unknown>,cleanup=false) {
    if(!this.trackQuiescence){if(cleanup)void work.catch(()=>{});return;}
    const pending=this.pending??=new Set<Promise<void>>();
    let tracked:Promise<void>;
    tracked=work.then(()=>{},()=>{if(cleanup)this.cleanupFailed=true;}).finally(()=>pending.delete(tracked));
    pending.add(tracked);
  }
  /** This verifies tracked promise settlement and cancellation callback outcome,
   * not OS-level worker shutdown. Refuse on cleanup failure or missing proof. */
  async waitForQuiescence(milliseconds:number):Promise<boolean> {
    if(!this.trackQuiescence||!this.expired||!Number.isFinite(milliseconds)||milliseconds<0||milliseconds>30000)return false;
    if(this.cleanupFailed)return false;
    if(!this.pending?.size)return true;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      return await Promise.race([
        Promise.all([...this.pending]).then(()=>!this.cleanupFailed&&!this.pending?.size),
        new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);}),
      ]);
    } finally {if(timer)clearTimeout(timer);}
  }
  async wait<T>(operation:()=>Promise<T>,cancel:()=>void|Promise<void>=()=>{}):Promise<T>{
    this.check();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
        const error=this.timeout(true);
        // Reject first: terminating a worker may synchronously reject its own
        // promise, which must not mask the budget's actual deadline.
        reject(error);
        try{this.track(Promise.resolve(cancel()),true);}catch{this.cleanupFailed=true;}
      },this.remaining());});
      const work=operation();this.track(work);
      const result=await Promise.race([work,timeout]);
      this.check();return result;
    } finally {if(timer)clearTimeout(timer);}
  }
}
import type {InventorySource} from '../session/inventory-evidence';

export type CardReadStage = 'visual' | 'short' | 'full';
type SourceStages = {stages:Set<'short'|'full'>;visual:boolean};
type AttemptEntry = { mode:'legacy'|'source'; sources:Map<string,SourceStages>; used:number; active:number; startedAt:number };

/** A source is an observation, not an image key or a claim that cards match. */
export function cardReadSourceKey(source:InventorySource):string {
  return JSON.stringify([source.sessionId,source.frameId,source.observationId,source.captureOrder,
    source.captureTime,source.phase,source.slot,source.frame]);
}

const MAX_ATTEMPT_KEYS=20_000,MAX_SOURCES_PER_KEY=16,MAX_SOURCE_RESERVATIONS=40_000,MAX_ATTEMPT_KEY_LENGTH=1024;
/** Counts of retained admission metadata only; not a heap or throughput measurement. */
export interface CardReadAttemptStats {
  readonly scope:'retained-admission-metadata';
  readonly pixelKeys:number;readonly sources:number;readonly maxSourcesOnOneKey:number;
  readonly limits:Readonly<{pixelKeys:number;sources:number;sourcesPerKey:number;keyLength:number}>;
}
export type CardReadDenialReason='invalid-key'|'key-capacity'|'source-capacity'|'total-source-capacity'|
  'mode-conflict'|'time-exhausted'|'stage-used'|'visual-used';
/** Structural loss cannot be repaired by assuming a different source was read. */
export function cardReadDenialLosesEvidence(reason:CardReadDenialReason|null):boolean {
  return reason==='invalid-key'||reason==='key-capacity'||reason==='source-capacity'||
    reason==='total-source-capacity'||reason==='mode-conflict';
}

/** Exact crop identity survives live/recovery replay. Improved pixels get a new budget.
 * Reserve short/full independently: duplicate short work cannot consume the full
 * pass per source. Distinct sources never borrow a result and share the same
 * three-second pixel budget. Overlapping work shares one active-time window,
 * excluding queue waits. Exhausted map limits fail closed without eviction. */
export class CardReadAttempts {
  private entries=new Map<string,AttemptEntry>();
  private sourceCount=0;
  private maxSourcesOnOneKey=0;
  private visualRechecks=new WeakSet<object>();
  private now:()=>number;
  private readonly trackQuiescence:boolean;
  constructor(now=()=>performance.now(),trackQuiescence=false){this.now=now;this.trackQuiescence=trackQuiescence;}
  /** O(1), detached aggregate snapshot. It does not expose source IDs or pixels. */
  stats():CardReadAttemptStats {
    return Object.freeze({scope:'retained-admission-metadata',pixelKeys:this.entries.size,sources:this.sourceCount,
      maxSourcesOnOneKey:this.maxSourcesOnOneKey,limits:Object.freeze({pixelKeys:MAX_ATTEMPT_KEYS,
        sources:MAX_SOURCE_RESERVATIONS,sourcesPerKey:MAX_SOURCES_PER_KEY,keyLength:MAX_ATTEMPT_KEY_LENGTH})});
  }
  /** One new stable capture with an exact confirmed identity may recheck fields
   * visually. This never refunds OCR time/passes; the token is consumed once. */
  beginVerifiedVisual(token:object){
    if(this.visualRechecks.has(token))return null;
    this.visualRechecks.add(token);
    return {budget:new CardReadBudget(3000,this.now,this.trackQuiescence),finish:()=>{}};
  }
  private stage(source:SourceStages|undefined,requested:CardReadStage|boolean):CardReadStage {
    return typeof requested==='string'?requested:!requested?'visual':source?.stages.has('short')?'full':'short';
  }
  private remaining(entry:AttemptEntry|undefined) {
    return entry?Math.max(0,3000-entry.used-(entry.active?Math.max(0,this.now()-entry.startedAt):0)):3000;
  }
  /** Read-only admission check; callers may retain a duplicate short as a full
   * candidate without inventing a timeout result or refunding its crop budget. */
  denialReason(key:string,requested:CardReadStage|boolean=true,sourceKey?:string):CardReadDenialReason|null {
    if(typeof key!=='string'||!key||key.length>MAX_ATTEMPT_KEY_LENGTH||
      sourceKey!==undefined&&(typeof sourceKey!=='string'||!sourceKey||sourceKey.length>MAX_ATTEMPT_KEY_LENGTH))return 'invalid-key';
    const entry=this.entries.get(key),mode=sourceKey===undefined?'legacy':'source',id=sourceKey??'';
    if(!entry&&this.entries.size>=MAX_ATTEMPT_KEYS)return 'key-capacity';
    if(entry&&entry.mode!==mode)return 'mode-conflict';
    const source=entry?.sources.get(id),stage=this.stage(source,requested);
    if(this.remaining(entry)<=0)return 'time-exhausted';
    if(!source&&this.sourceCount>=MAX_SOURCE_RESERVATIONS)return 'total-source-capacity';
    if(!source&&entry&&entry.sources.size>=MAX_SOURCES_PER_KEY)return 'source-capacity';
    if(source?.stages.size===2)return 'stage-used';
    // A full pass already includes the short preprocessing. Never restart it
    // as a new short pass when recovery revisits these exact pixels.
    if(stage==='visual')return mode==='source'&&source?.visual?'visual-used':null;
    return source?.stages.has(stage)||stage==='short'&&source?.stages.has('full')?'stage-used':null;
  }
  canBegin(key:string,requested:CardReadStage|boolean=true,sourceKey?:string) {
    return this.denialReason(key,requested,sourceKey)===null;
  }
  begin(key:string,requested:CardReadStage|boolean=true,sourceKey?:string){
    if(!this.canBegin(key,requested,sourceKey))return null;
    const entry=this.entries.get(key)??{mode:sourceKey===undefined?'legacy' as const:'source' as const,
      sources:new Map<string,SourceStages>(),used:0,active:0,startedAt:0};
    const id=sourceKey??'',priorSource=entry.sources.get(id),source=priorSource??{stages:new Set<'short'|'full'>(),visual:false};
    const stage=this.stage(source,requested),remaining=this.remaining(entry);
    this.entries.set(key,entry);
    if(!priorSource)this.sourceCount++;
    entry.sources.set(id,source);
    if(!priorSource)this.maxSourcesOnOneKey=Math.max(this.maxSourcesOnOneKey,entry.sources.size);
    if(stage!=='visual')source.stages.add(stage);else source.visual=true;
    if(!entry.active)entry.startedAt=this.now();
    entry.active++;let finished=false;
    return {stage,budget:new CardReadBudget(remaining,this.now,this.trackQuiescence),finish:()=>{
      if(finished)return;finished=true;
      if(--entry.active===0)entry.used+=Math.max(0,this.now()-entry.startedAt);
    }};
  }
}
