/** Wake the existing primary reader at an acquisition idle boundary. The wake
 * is a scheduling hint only: it neither runs completion nor proves pixels. */
export class CompletionWake {
  private pending=false;
  private wake:(()=>void)|undefined;

  request():void {
    this.pending=true;
    this.wake?.();
  }

  /** Coalesce hints until the primary reader consumes them. */
  consume():boolean {
    const pending=this.pending;
    this.pending=false;
    return pending;
  }

  /** One primary reader may wait; abort and both completion paths release the
   * timer and listener. Repeated requests do not create additional work. */
  wait(signal:AbortSignal,delay=30):Promise<void> {
    signal.throwIfAborted();
    if(this.pending)return Promise.resolve();
    if(this.wake)throw new Error('Completion wake already has a reader');
    return new Promise<void>((resolve,reject)=>{
      let settled=false;
      const cleanup=()=>{
        clearTimeout(timer);
        signal.removeEventListener('abort',abort);
        if(this.wake===finish)this.wake=undefined;
      };
      const finish=()=>{if(settled)return;settled=true;cleanup();resolve();};
      const abort=()=>{if(settled)return;settled=true;cleanup();reject(signal.reason??new DOMException('Stopped','AbortError'));};
      const timer=setTimeout(finish,delay);
      this.wake=finish;
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();else if(this.pending)finish();
    });
  }
}
