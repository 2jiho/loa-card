import {CardReadAdmissionDenied,CardReadInterrupted,OcrInitializationTimeout,type CardReadBudget} from './card-read-budget';
export class OcrResourceUnavailable extends Error {
 readonly reason:'capacity'|'cleanup';
 constructor(reason:'capacity'|'cleanup'){super(reason==='capacity'?'이전 OCR 종료 대기 · 다시 시도해 주세요':'OCR 종료 확인 필요');
  this.name='OcrResourceUnavailable';this.reason=reason;}
}
/** Experimental: timeouts retire one generation. Never terminate it until
 * every admitted call has settled. A bounded quarantine fails closed. */
type Generation<W>={pending:number;tail:Promise<void>;retired:boolean;disposed:boolean;ready:boolean;worker?:W;cleanupFailed?:boolean;
 finish:()=>void;done:Promise<void>;stopListeners:Set<()=>void>;creating:Promise<W>};
export type OcrLease<W>={request:<T>(fn:(worker:W,check:()=>void)=>Promise<T>|T)=>Promise<T>;
 requestOwned:<R,T>(create:()=>R,fn:(worker:W,check:()=>void,resource:R)=>Promise<T>|T,release:(resource:R)=>void)=>Promise<T>;
 invalidate:()=>Promise<void>};
/** A non-budget caller must not wait forever for initialization. Retirement
 * remains tracked by the pool until late initialization and cleanup settle. */
export async function waitForOcrInitialization<W>(ticket:{ready:Promise<OcrLease<W>>;invalidate:()=>Promise<void>},
 onCleanupError:(error:unknown)=>void, milliseconds=10000):Promise<OcrLease<W>>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([ticket.ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
  reject(new OcrInitializationTimeout());
  try{void ticket.invalidate().catch(onCleanupError);}catch(error){onCleanupError(error);}
 },milliseconds);})]);}finally{if(timer)clearTimeout(timer);}
}

/** Capacity waiting is part of the same card read and its existing deadline.
 * It creates no worker and grants no new recognition attempt while waiting.
 * Non-budget metadata preserves its existing fail-fast capacity behavior. */
export async function acquireBudgetedOcrWorker<W>(pool:OcrLeasePool<W>,budget:CardReadBudget|undefined,
 signal:AbortSignal|undefined,onCleanupError:(error:unknown)=>void):Promise<OcrLease<W>> {
 for(;;){
  signal?.throwIfAborted();budget?.check();
  let ticket:ReturnType<OcrLeasePool<W>['reserve']>;
  try{ticket=pool.reserve();}catch(error){
   if(!budget||!(error instanceof OcrResourceUnavailable)||error.reason!=='capacity')throw error;
   const waitAbort=new AbortController();
   const abort=()=>waitAbort.abort(signal?.reason);
   signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted)abort();
   try{await budget.wait(()=>pool.waitForCapacity(waitAbort.signal),()=>waitAbort.abort());}
   finally{signal?.removeEventListener('abort',abort);waitAbort.abort();}
   continue; // another waiter may have reserved or retired a generation
  }
  const invalidate=()=>ticket.invalidate().catch(error=>{onCleanupError(error);throw error;});
  return budget?budget.wait(()=>ticket.ready,invalidate):waitForOcrInitialization(ticket,onCleanupError);
 }
}
export class OcrLeasePool<W> {
 private current:Generation<W>|undefined;private retired=new Set<Generation<W>>();private closed=false;
 private cleanupError:unknown;private cleanupFailed=false;
 private capacityWaiters=new Set<()=>void>();
 private readonly create:()=>Promise<W>;private readonly dispose:(worker:W)=>Promise<void>;private readonly limit:number;
 constructor(create:()=>Promise<W>,dispose:(worker:W)=>Promise<void>,limit=2){
  if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid OCR worker limit');
  this.create=create;this.dispose=dispose;this.limit=limit;
 }
 private async disposeIfIdle(g:Generation<W>){
  if(!g.retired||g.pending||!g.ready||g.disposed)return;g.disposed=true;
  try{await this.dispose(g.worker!);}catch(error){g.cleanupFailed=true;this.reportCleanupFailure(error);}
  finally{this.retired.delete(g);g.finish();this.notifyCapacity();}
 }
 private retire(g:Generation<W>){if(g.retired)return;g.retired=true;for(const stop of g.stopListeners)stop();g.stopListeners.clear();if(this.current===g)this.current=undefined;
  this.retired.add(g);void this.disposeIfIdle(g);}
 private invalidate(g:Generation<W>){this.retire(g);const result=g.done.then(()=>{if(g.cleanupFailed||this.cleanupFailed)throw new OcrResourceUnavailable('cleanup');});
  void result.catch(()=>{});return result;}
 reportCleanupFailure(error:unknown){if(!this.cleanupFailed)this.cleanupError=error;this.cleanupFailed=true;if(this.current)this.retire(this.current);this.notifyCapacity();}
 private notifyCapacity(){for(const wake of [...this.capacityWaiters])wake();}
 /** Only waits for permission to try reserve again. A wake is not a worker
  * lease; concurrent callers must each re-check the pool state and budget. */
 waitForCapacity(signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{this.capacityWaiters.delete(check);signal.removeEventListener('abort',abort);};
   const abort=()=>{cleanup();reject(signal.reason);};
   const check=()=>{
    if(signal.aborted){abort();return;}
    if(this.closed){cleanup();reject(Error('OCR 종료'));return;}
    if(this.cleanupFailed){cleanup();reject(new OcrResourceUnavailable('cleanup'));return;}
    if(this.current||this.retired.size<this.limit){cleanup();resolve();}
   };
   this.capacityWaiters.add(check);signal.addEventListener('abort',abort,{once:true});check();
  });
 }
 reserve():{ready:Promise<OcrLease<W>>;invalidate:()=>Promise<void>}{
  if(this.closed)throw Error('OCR 종료');if(this.cleanupFailed)throw new OcrResourceUnavailable('cleanup');
  let generation=this.current;
  if(!generation){
   if(this.retired.size>=this.limit)throw new OcrResourceUnavailable('capacity');
   let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});
   const g:Generation<W>={pending:0,tail:Promise.resolve(),retired:false,disposed:false,ready:false,finish,done,stopListeners:new Set(),creating:undefined!};
   generation=g;this.current=g;
   g.creating=Promise.resolve().then(()=>this.create()).then(worker=>{g.worker=worker;g.ready=true;void this.disposeIfIdle(g);return worker;},error=>{
    if(this.current===g)this.current=undefined;this.retired.delete(g);g.finish();this.notifyCapacity();throw error;
   });
  }
  const g=generation;
  const checkGeneration=()=>{if(this.cleanupFailed)throw new OcrResourceUnavailable('cleanup');
   if(this.closed)throw Error('OCR 종료');if(g.retired)throw new CardReadInterrupted();};
  const untilRetired=<T>(work:Promise<T>):Promise<T>=>new Promise<T>((resolve,reject)=>{
   const stop=()=>{try{checkGeneration();reject(Error('OCR 종료'));}catch(error){reject(error);}};
   work.then(value=>{g.stopListeners.delete(stop);resolve(value);},error=>{g.stopListeners.delete(stop);reject(error);});
   if(g.retired){stop();return;}g.stopListeners.add(stop);
  });
  const created=g.creating.then(worker=>{
   checkGeneration();
   const requestOwned=<R,T>(create:()=>R,fn:(worker:W,check:()=>void,resource:R)=>Promise<T>|T,release:(resource:R)=>void):Promise<T>=>{
    if(this.cleanupFailed)return Promise.reject(new OcrResourceUnavailable('cleanup'));
    if(this.closed)return Promise.reject(Error('OCR 종료'));
    if(g.retired)return Promise.reject(new CardReadInterrupted());
    if(g.pending>=8)return Promise.reject(new CardReadAdmissionDenied());
    let resource:R;try{resource=create();}catch(error){return Promise.reject(error);}
    g.pending++;
    const check=checkGeneration;
    const run=g.tail.then(()=>{check();return fn(worker,check,resource);});
    g.tail=run.then(()=>{},()=>{});
    const observed=run.then(value=>{check();return value;})
     .finally(()=>{try{release(resource);}finally{g.pending--;void this.disposeIfIdle(g);}});
    return untilRetired(observed);
   };
   return {request:<T>(fn:(worker:W,check:()=>void)=>Promise<T>|T)=>requestOwned(()=>undefined,fn,()=>{}),
    requestOwned,invalidate:()=>this.invalidate(g)};
  },error=>{checkGeneration();throw error;});
  const ready=untilRetired(created);
  return {ready,invalidate:()=>this.invalidate(g)};
 }
 async acquire(){return this.reserve().ready;}
 get stats(){return {retired:this.retired.size,capacityWaiters:this.capacityWaiters.size,closed:this.closed,cleanupFailed:this.cleanupFailed};}
 async close(){this.closed=true;if(this.current)this.retire(this.current);this.notifyCapacity();await Promise.all([...this.retired].map(g=>g.done));
  if(this.cleanupFailed)throw new AggregateError([this.cleanupError],'OCR 종료 확인 실패');}
}
