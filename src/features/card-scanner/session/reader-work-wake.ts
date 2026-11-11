/** Wake idle readers when admitted work or scanner lifecycle changes.
 * This is only a scheduling hint: the queues and their existing policies remain
 * the authority for which observation a reader may consume. */
export class ReaderWorkWake {
  private revision=0;
  private closed=false;
  private waiters=new Set<()=>void>();

  get version(){return this.revision;}

  request(){
    if(this.closed)return;
    this.revision++;
    for(const wake of [...this.waiters])wake();
  }

  wait(signal:AbortSignal,version:number,delay=30):Promise<void> {
    signal.throwIfAborted();
    if(this.closed||version!==this.revision)return Promise.resolve();
    return new Promise<void>((resolve,reject)=>{
      let settled=false;
      const cleanup=()=>{clearTimeout(timer);this.waiters.delete(finish);signal.removeEventListener('abort',abort);};
      const finish=()=>{if(settled)return;settled=true;cleanup();resolve();};
      const abort=()=>{if(settled)return;settled=true;cleanup();reject(signal.reason??new DOMException('Stopped','AbortError'));};
      const timer=setTimeout(finish,delay);
      this.waiters.add(finish);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();else if(this.closed||version!==this.revision)finish();
    });
  }

  dispose(){
    if(this.closed)return;
    this.closed=true;
    for(const wake of [...this.waiters])wake();
  }
}

/** Keep idle consumers alive while another consumer may still enqueue a retry.
 * Count the complete dispatch, including any asynchronous metadata wait before
 * a candidate is removed from its queue. */
export class ReaderDispatches {
  private count=0;
  private readonly onSettled:()=>void;
  constructor(onSettled:()=>void){this.onSettled=onSettled;}
  get active(){return this.count;}
  start():()=>void {
    this.count++;
    let finished=false;
    return ()=>{
      if(finished)return;
      finished=true;
      this.count--;
      this.onSettled();
    };
  }
}
