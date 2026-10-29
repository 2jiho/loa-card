export interface RecoveryPipelineOptions<T> {
  collect(frame:T):Promise<void>;
  /** All queued stages, including deferred and full OCR retries. */
  pending():number;
  /** True when this lane took work; false when it has no eligible work. */
  consume(lane:number):Promise<boolean>;
  lanes:number;
  highWaterMark?:number;
}

/** Collect ordered frames while independent readers drain the resulting jobs.
 * Backpressure permits at most one frame's candidates beyond the watermark.
 * Callbacks and the frame iterator retain ownership of their resources; failure
 * stops new work and joins every already-started operation before returning. */
export async function runRecoveryPipeline<T>(frames:AsyncIterable<T>,signal:AbortSignal,options:RecoveryPipelineOptions<T>):Promise<void> {
  const {lanes,highWaterMark=80}=options;
  if(!Number.isInteger(lanes)||lanes<1)throw new RangeError('Recovery reader count must be a positive integer');
  if(!Number.isInteger(highWaterMark)||highWaterMark<1)throw new RangeError('Recovery watermark must be a positive integer');
  signal.throwIfAborted();
  const iterator=frames[Symbol.asyncIterator]();
  let stopped=false,failed=false,failure:unknown,finished=false,producerDone=false,producerBlocked=false;
  let active=0,version=0;
  const idleVersions=new Array<number>(lanes).fill(-1);
  const waiters=new Set<()=>void>();
  const wake=()=>{version++;for(const resolve of waiters)resolve();waiters.clear();};
  const fail=(error:unknown)=>{if(!failed){failed=true;failure=error;}stopped=true;wake();};
  const wait=(observed:number)=>{
    if(stopped||finished||version!==observed)return Promise.resolve();
    return new Promise<void>(resolve=>{waiters.add(resolve);});
  };
  const check=()=>{
    if(stopped||finished)return;
    const pending=options.pending();
    if(producerDone&&active===0&&pending===0){finished=true;wake();}
    else if(active===0&&pending>0&&(producerDone||producerBlocked)&&idleVersions.every(value=>value===version))
      fail(new Error('Recovery queue has work but no reader can consume it'));
  };
  const onAbort=()=>fail(signal.reason);
  signal.addEventListener('abort',onAbort,{once:true});
  const waitForSpace=async()=>{
    while(!stopped&&options.pending()>=highWaterMark){
      const observed=version;producerBlocked=true;check();
      await wait(observed);
    }
    producerBlocked=false;
  };

  const produce=async()=>{
    let exhausted=false;
    try {
      while(!stopped){
        await waitForSpace();
        if(stopped)break;
        const next=await iterator.next();
        if(next.done){exhausted=true;break;}
        // Decoding a frame can overlap retry production from active readers.
        await waitForSpace();
        if(stopped)break;
        await options.collect(next.value);
        wake();
      }
    } catch(error){fail(error);}
    finally {
      if(!exhausted){try{await iterator.return?.();}catch(error){fail(error);}}
      producerDone=true;producerBlocked=false;wake();
      try{check();}catch(error){fail(error);}
    }
  };
  const read=async(lane:number)=>{
    try {
      while(!stopped&&!finished){
        const observed=version;
        if(options.pending()>0){
          active++;
          let consumed:boolean;
          try{
            const queued=options.pending();
            const work=options.consume(lane);
            // Most readers dequeue before their first await. Release producer
            // backpressure immediately instead of waiting for OCR to finish.
            try{if(options.pending()<queued)wake();}catch(error){fail(error);}
            consumed=await work;
          }finally{active--;}
          if(stopped)break;
          if(consumed){wake();check();continue;}
        }
        idleVersions[lane]=observed;check();
        await wait(observed);
      }
    } catch(error){fail(error);}
  };
  try {
    await Promise.all([produce(),...Array.from({length:lanes},(_,lane)=>read(lane))]);
    if(failed)throw failure;
  } finally {
    stopped=true;wake();signal.removeEventListener('abort',onAbort);
  }
}
