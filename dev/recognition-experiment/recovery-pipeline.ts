import {runJoinedWorkers} from '../../src/features/card-scanner/joined-workers';

/** Recovery runs after capture: add image-only capacity, never more OCR models. */
export function recoveryVisualLanes(cores:number,readers:number) {
  return Math.max(readers,cores>=12?6:0);
}

/** OCR-designated lanes retain priority for short retries; only idle capacity
 * helps visual work, so faster bulk reading cannot starve occluded cards. */
export function nextRecoveryTask(index:number,fastLanes:number,hasVisual:boolean,queued:number,shortJobs:number,visualOnly=false) {
  if(visualOnly)return hasVisual&&queued>0?'visual':undefined;
  if(index>=fastLanes&&shortJobs>0)return 'short';
  if(hasVisual&&queued>0)return 'visual';
  return shortJobs>0?'short':undefined;
}
/** Broadcast a queue change without polling timers (which background tabs throttle). */
class QueueChanges {
  version=0;
  private listeners=new Set<()=>void>();
  notify(){this.version++;for(const resolve of [...this.listeners])resolve();}
  wait(version:number,signal:AbortSignal){
    signal.throwIfAborted();
    if(version!==this.version)return Promise.resolve();
    return new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{this.listeners.delete(done);signal.removeEventListener('abort',abort);};
      const done=()=>{cleanup();resolve();};
      const abort=()=>{cleanup();reject(signal.reason??new DOMException('Stopped','AbortError'));};
      this.listeners.add(done);signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
    });
  }
}

/** One acquisition in flight, bounded queued crops, one job per reader.
 * The decoder advances only after collect has copied its pooled canvas.
 * Errors join in-flight readers before the scanner releases shared resources. */
export async function runRecoveryPipeline<T>(options: {
  frames: AsyncIterable<T>;
  collect: (frame:T)=>Promise<void>;
  pending: ()=>number;
  lanes: {hasWork:()=>boolean; read:()=>Promise<void>}[];
  signal: AbortSignal;
  highWater?: number;
}) {
  const {frames,collect,pending,lanes,signal,highWater=120}=options;
  if(!lanes.length||!Number.isInteger(highWater)||highWater<1)throw Error('Invalid recovery pipeline');
  let producing=true,failed=false;
  const changes=new QueueChanges();
  const guard=(task:(stopped:()=>boolean)=>Promise<void>)=>async(stopped:()=>boolean)=>{
    try{await task(()=>failed||stopped());}
    catch(error){failed=true;changes.notify();throw error;}
  };
  await runJoinedWorkers([
    guard(async stopped=>{
      try {
        for await(const frame of frames) {
          while(!stopped()&&pending()>=highWater){
            const version=changes.version;
            await changes.wait(version,signal);
          }
          signal.throwIfAborted();
          if(stopped())break;
          await collect(frame);
          changes.notify();
        }
      } finally {producing=false;changes.notify();}
    }),
    ...lanes.map(lane=>guard(async(stopped:()=>boolean)=>{
      while(!stopped()&&(producing||lane.hasWork())) {
        signal.throwIfAborted();
        const version=changes.version;
        if(lane.hasWork()){await lane.read();changes.notify();}
        else await changes.wait(version,signal);
      }
    })),
  ]);
}
