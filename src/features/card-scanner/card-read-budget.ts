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
/** Exact crop identity survives live/recovery replay. Improved pixels get a new budget. */
export class CardReadAttempts {
  private entries=new Map<string,{attempts:number;used:number}>();
  private now:()=>number;
  constructor(now=()=>performance.now()){this.now=now;}
  begin(key:string,ocr=true){
    const entry=this.entries.get(key)??{attempts:0,used:0};
    this.entries.set(key,entry);
    if(entry.attempts>=2||entry.used>=3000)return null;
    if(ocr)entry.attempts++;
    const started=this.now();let finished=false;
    return {budget:new CardReadBudget(3000-entry.used,this.now),finish:()=>{if(!finished){finished=true;entry.used+=this.now()-started;}}};
  }
}
