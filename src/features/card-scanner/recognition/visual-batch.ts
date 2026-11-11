import type {VisualResult} from './visual-client';

/** Development experiment (docs/scanner-live-redesign.md, section 12): read the crops of one
 * frame with ONE message per visual worker instead of one round trip per crop.
 *
 * The worker runs the same reading for each crop as the single-crop client, so a batch
 * result is the result the single-crop path would return for the same pixels. The pixels
 * are copied when `read` is called; a crop released afterwards does not change its result.
 *
 * Nothing here decides anything about a card. A promise resolves to `null` whenever the
 * batch could not produce that crop's result (stopped, worker error, timeout, unreadable
 * crop); the caller then reads the crop on its ordinary path. `read` returns `null` and
 * takes nothing when too many crops are already waiting, so a slow batch never becomes an
 * unbounded backlog or a lost crop. */
export interface VisualBatchStats {
  /** Frames accepted / crops accepted / crops refused because too many were waiting. */
  readonly batches:number;readonly crops:number;readonly declinedCrops:number;
  /** Crops whose result came back / crops that fell back to the ordinary path. */
  readonly resolved:number;readonly failed:number;
  /** Mean time from `read` to the results of a worker's share of a frame. */
  readonly meanRoundTripMs:number;
}

export function createVisualBatchClient(signal:AbortSignal,options:{workers?:number;maxOutstanding?:number;timeoutMs?:number}={}) {
  if(typeof OffscreenCanvas==='undefined'||typeof createImageBitmap==='undefined'||typeof Worker==='undefined')return undefined;
  const count=Math.max(1,Math.floor(options.workers??2)),maxOutstanding=Math.max(1,Math.floor(options.maxOutstanding??160)),timeoutMs=options.timeoutMs??30000;
  type Job={resolve:(results:readonly (VisualResult|null)[]|null)=>void;timer:ReturnType<typeof setTimeout>};
  type Lane={worker:Worker;jobs:Map<number,Job>};
  let closed=false,nextId=0,outstanding=0;
  let batches=0,crops=0,declinedCrops=0,resolved=0,failed=0,roundTripMs=0,roundTrips=0;
  const failLane=(lane:Lane)=>{
    const jobs=[...lane.jobs.values()];lane.jobs.clear();
    for(const job of jobs){clearTimeout(job.timer);job.resolve(null);}
  };
  const startLane=():Lane=>{
    const lane:Lane={worker:new Worker(new URL('./visual-worker.ts',import.meta.url),{type:'module'}),jobs:new Map()};
    lane.worker.onmessage=(event:MessageEvent<{id:number;results?:(VisualResult|null)[];result?:null;error?:string}>)=>{
      const job=lane.jobs.get(event.data.id);if(!job)return;
      lane.jobs.delete(event.data.id);clearTimeout(job.timer);
      job.resolve(event.data.error?null:event.data.results??[]);
    };
    lane.worker.onerror=()=>{restart(lane);};
    return lane;
  };
  const lanes=Array.from({length:count},startLane);
  /** A worker that failed or timed out is replaced; whatever it still owed falls back. */
  function restart(lane:Lane){
    lane.worker.terminate();failLane(lane);
    const index=lanes.indexOf(lane);
    if(index>=0&&!closed)lanes[index]=startLane();
  }
  function dispose(){
    if(closed)return;closed=true;signal.removeEventListener('abort',dispose);
    for(const lane of lanes){lane.worker.terminate();failLane(lane);}
  }
  signal.addEventListener('abort',dispose,{once:true});if(signal.aborted)dispose();
  const send=(lane:Lane,message:{id:number;bitmaps?:ImageBitmap[]},transfer:Transferable[])=>new Promise<readonly (VisualResult|null)[]|null>(resolve=>{
    const timer=setTimeout(()=>{if(lane.jobs.has(message.id))restart(lane);},timeoutMs);
    lane.jobs.set(message.id,{resolve,timer});
    try{lane.worker.postMessage(message,transfer);}
    catch{lane.jobs.delete(message.id);clearTimeout(timer);resolve(null);}
  });
  return {
    /** Loads each worker's reference data. */
    async ready():Promise<void> {
      if(closed)return;
      await Promise.all(lanes.map(lane=>send(lane,{id:++nextId},[])));
    },
    /** One promise per image, in order; `null` when the batch is refused. */
    read(images:readonly HTMLCanvasElement[]):Promise<VisualResult|null>[]|null {
      if(closed||!images.length)return null;
      if(outstanding+images.length>maxOutstanding){declinedCrops+=images.length;return null;}
      batches++;crops+=images.length;outstanding+=images.length;
      const started=performance.now();
      // Copy the pixels now, before anything else can release or reuse these canvases.
      const frozen=images.map(image=>{try{return createImageBitmap(image);}catch(error){return Promise.reject(error);}});
      for(const bitmap of frozen)bitmap.catch(()=>{});
      const shares=lanes.map(()=>[] as number[]);
      images.forEach((_,index)=>shares[index%shares.length].push(index));
      const output:Promise<VisualResult|null>[]=Array<Promise<VisualResult|null>>(images.length);
      shares.forEach((indices,laneIndex)=>{
        if(!indices.length)return;
        const share=(async()=>{
          const settled=await Promise.allSettled(indices.map(index=>frozen[index]));
          const bitmaps=settled.flatMap(item=>item.status==='fulfilled'?[item.value]:[]);
          // One unreadable canvas makes this worker's share fall back; the indices would no longer line up.
          if(closed||bitmaps.length!==indices.length){for(const bitmap of bitmaps)bitmap.close();return null;}
          const results=await send(lanes[laneIndex],{id:++nextId,bitmaps},bitmaps);
          if(results){roundTripMs+=performance.now()-started;roundTrips++;}
          return results&&results.length===indices.length?results:null;
        })().catch(()=>null);
        indices.forEach((index,position)=>{
          output[index]=share.then(results=>{
            outstanding--;
            const result=results?.[position]??null;
            if(result)resolved++;else failed++;
            return result;
          });
        });
      });
      return output;
    },
    stats:():VisualBatchStats=>({batches,crops,declinedCrops,resolved,failed,meanRoundTripMs:roundTrips?Math.round(roundTripMs/roundTrips*10)/10:0}),
    dispose,
  };
}
