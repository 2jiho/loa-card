/** Transfer any deferred thumbnail canvas before a candidate is shared with a
 * retry queue. The recognition crop remains owned by the candidate. */
export async function finishCandidatePreview(item:{preview:string;previewCanvas?:HTMLCanvasElement;previewTask?:Promise<string>},
  encoder:{encodeOwnedWhenAvailable(canvas:HTMLCanvasElement):Promise<string>},signal:AbortSignal):Promise<void> {
  if(!item.previewTask&&item.previewCanvas){
    const canvas=item.previewCanvas;item.previewCanvas=undefined;
    item.previewTask=encoder.encodeOwnedWhenAvailable(canvas);
  }
  if(item.previewTask)item.preview=await item.previewTask;
  signal.throwIfAborted();
}

/** Presentation-flush time only; it is not the time since sufficient input,
 * scan completion, or share-stop latency. Missing/nonmonotonic clocks remain
 * unknown rather than producing a fabricated zero. */
export function previewFlushTimer(now:()=>number=()=>performance.now()):()=>number|null {
  const sample=()=>{try{const value=now();return Number.isFinite(value)?value:null;}catch{return null;}};
  const start=sample();
  return ()=>{const end=sample();return start!==null&&end!==null&&end>=start?end-start:null;};
}

/** Session-local attachment jobs own no pixels. A successful card may release
 * its recognition lane while its separately owned preview is encoding. */
export function createPreviewPresentation(signal:AbortSignal,limit=16) {
  const pending=new Set<Promise<void>>();
  let closed=false;
  if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid preview presentation limit');
  return {
    /** False leaves task ownership with the caller, which must await it. */
    track(task:Promise<string>,attach:(image:string)=>void):boolean {
      if(closed||signal.aborted||pending.size>=limit)return false;
      const work=task.then(image=>{if(!closed&&!signal.aborted)attach(image);}).catch(()=>{});
      pending.add(work);
      void work.then(()=>pending.delete(work),()=>pending.delete(work));
      return true;
    },
    /** Call after readers have joined, before final card projection/autosave. */
    async flush():Promise<void> {
      while(pending.size)await Promise.allSettled([...pending]);
    },
    close():void {closed=true;},
    /** Optional activity-image callbacks must share the same session lifetime. */
    get active():boolean{return !closed&&!signal.aborted;},
    get waiting():number{return pending.size;},
  };
}
