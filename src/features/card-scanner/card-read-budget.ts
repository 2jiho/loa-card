export class CardReadTimeout extends Error {
  constructor(){super('카드 판독 시간 초과 · 다시 보여 주세요');this.name='CardReadTimeout';}
}
/** Processing time only; time spent waiting in a queue is not charged. */
export class CardReadBudget {
  private until:number;
  private now:()=>number;
  constructor(milliseconds=3000,now=()=>performance.now()){this.now=now;this.until=now()+milliseconds;}
  remaining(){return Math.max(0,this.until-this.now());}
  check(){if(!this.remaining())throw new CardReadTimeout();}
  async wait<T>(operation:()=>Promise<T>,cancel:()=>void=()=>{}):Promise<T>{
    this.check();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
        try{cancel();}catch{/* Cancellation failure must not strand the caller. */}finally{reject(new CardReadTimeout());}
      },this.remaining());});
      const result=await Promise.race([operation(),timeout]);
      this.check();return result;
    } finally {if(timer)clearTimeout(timer);}
  }
}
export type CardReadStage = 'visual' | 'short' | 'full';
type AttemptEntry = { stages:Set<'short'|'full'>; used:number; active:number; startedAt:number };

/** Exact crop identity survives live/recovery replay. Improved pixels get a new budget.
 * Reserve short/full independently: duplicate short work cannot consume the full
 * pass. Overlapping work shares one active-time window, excluding queue waits. */
export class CardReadAttempts {
  private entries=new Map<string,AttemptEntry>();
  private visualRechecks=new WeakSet<object>();
  private now:()=>number;
  constructor(now=()=>performance.now()){this.now=now;}
  /** One new stable capture with an exact confirmed identity may recheck fields
   * visually. This never refunds OCR time/passes; the token is consumed once. */
  beginVerifiedVisual(token:object){
    if(this.visualRechecks.has(token))return null;
    this.visualRechecks.add(token);
    return {budget:new CardReadBudget(3000,this.now),finish:()=>{}};
  }
  private stage(entry:AttemptEntry|undefined,requested:CardReadStage|boolean):CardReadStage {
    return typeof requested==='string'?requested:!requested?'visual':entry?.stages.has('short')?'full':'short';
  }
  private remaining(entry:AttemptEntry|undefined) {
    return entry?Math.max(0,3000-entry.used-(entry.active?Math.max(0,this.now()-entry.startedAt):0)):3000;
  }
  /** Read-only admission check; callers may retain a duplicate short as a full
   * candidate without inventing a timeout result or refunding its crop budget. */
  canBegin(key:string,requested:CardReadStage|boolean=true) {
    const entry=this.entries.get(key),stage=this.stage(entry,requested);
    if(this.remaining(entry)<=0||entry?.stages.size===2)return false;
    // A full pass already includes the short preprocessing. Never restart it
    // as a new short pass when recovery revisits these exact pixels.
    return stage==='visual'||!entry?.stages.has(stage)&&!(stage==='short'&&entry?.stages.has('full'));
  }
  begin(key:string,requested:CardReadStage|boolean=true){
    if(!this.canBegin(key,requested))return null;
    const entry=this.entries.get(key)??{stages:new Set<'short'|'full'>(),used:0,active:0,startedAt:0};
    const stage=this.stage(entry,requested),remaining=this.remaining(entry);
    this.entries.set(key,entry);
    if(stage!=='visual')entry.stages.add(stage);
    if(!entry.active)entry.startedAt=this.now();
    entry.active++;let finished=false;
    return {stage,budget:new CardReadBudget(remaining,this.now),finish:()=>{
      if(finished)return;finished=true;
      if(--entry.active===0)entry.used+=Math.max(0,this.now()-entry.startedAt);
    }};
  }
}
