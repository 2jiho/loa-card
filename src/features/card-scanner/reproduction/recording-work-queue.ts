export type RecordingWorkLane='frame'|'event';
export interface RecordingWork {
 run():void|Promise<void>;
 /** Owned inputs remain charged until this settles, including skipped work. */
 release?():void|Promise<void>;
 onError?(error:unknown):void;
}
interface Barrier {run():void|Promise<void>;resolve():void;reject(error:unknown):void}
interface Segment {frame:RecordingWork[];event:RecordingWork[];barrier?:Barrier}

/** One append owner, FIFO per stream, with control boundaries across both.
 * Limits include the running job and its release. A barrier closes a segment:
 * later arrivals cannot overtake it, even when earlier work fails. */
export function createRecordingWorkQueue(limits:{frame:number;event:number}={frame:128,event:4}){
 for(const limit of Object.values(limits))if(!Number.isSafeInteger(limit)||limit<1)throw Error('기록 작업 큐 한도 오류');
 const segments:Segment[]=[{frame:[],event:[]}],pending={frame:0,event:0};
 let running=false,lastLane:RecordingWorkLane='event';
 function report(work:RecordingWork,error:unknown){
  // An error reporter must not strand another job's transferred input.
  try{work.onError?.(error);}catch{/* Keep draining owned releases and barriers. */}
 }
 async function pump(){
  try{
   for(;;){
    const segment=segments[0];
    const lane:RecordingWorkLane|undefined=segment.frame.length&&segment.event.length?
     lastLane==='frame'?'event':'frame':segment.frame.length?'frame':segment.event.length?'event':undefined;
    if(lane){
     const work=segment[lane].shift()!;lastLane=lane;
     try{await work.run();}catch(error){report(work,error);}
     finally{
      try{await work.release?.();}catch(error){report(work,error);}
      finally{pending[lane]--;}
     }
     continue;
    }
    if(!segment.barrier)return;
    const barrier=segment.barrier;segments.shift();
    try{await barrier.run();barrier.resolve();}catch(error){barrier.reject(error);}
   }
  }finally{running=false;}
 }
 function start(){if(!running){running=true;void pump();}}
 return {
  /** False leaves ownership with the caller; nothing has been enqueued. */
  enqueue(lane:RecordingWorkLane,work:RecordingWork):boolean{
   if(pending[lane]>=limits[lane])return false;
   pending[lane]++;segments[segments.length-1][lane].push(work);start();return true;
  },
  barrier(run:()=>void|Promise<void>=()=>{}):Promise<void>{
   const result=new Promise<void>((resolve,reject)=>{
    segments[segments.length-1].barrier={run,resolve,reject};segments.push({frame:[],event:[]});
   });
   start();return result;
  },
  get pending(){return {...pending};},
 };
}
