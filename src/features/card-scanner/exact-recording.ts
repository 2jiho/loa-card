import type {ExactEvent} from './exact-recording-codec';
export interface ExactRecordingStats {frames:number;events:number;dropped:number;bytes:number;peakQueuedBytes:number;peakWorkingBytes:number;readbackMs:number;encodeMs:number;complete:boolean;error:string}
export interface ExactRecording {blob:Blob;stats:ExactRecordingStats;dispose():Promise<void>}
export async function createExactRecording(){
 const worker=new Worker(new URL('./exact-recording-worker.ts',import.meta.url),{type:'module'}),channel=new MessageChannel();
 let attached=false,closed=false,finished=false,sequence=0,pending:ExactEvent[]=[],pendingBytes=0,inFlight=0,overflow=false,incompleteReason='';
 let resolveReady!:()=>void,rejectReady!:(e:unknown)=>void,resolveDone!:(value:ExactRecording)=>void,rejectDone!:(e:unknown)=>void,resolveDispose:(()=>void)|undefined;
 const ready=new Promise<void>((r,j)=>{resolveReady=r;rejectReady=j;});
 let done:Promise<ExactRecording>|undefined;
 const flush=()=>{if(!pending.length||inFlight>=4)return;worker.postMessage({kind:'events',events:pending});pending=[];pendingBytes=0;inFlight++;};
 worker.onmessage=event=>{const m=event.data;
  if(m.kind==='ready')resolveReady();
  else if(m.kind==='events-written'){inFlight=Math.max(0,inFlight-1);flush();}
  else if(m.kind==='error'){rejectReady(Error(m.error));rejectDone?.(Error(m.error));}
  else if(m.kind==='disposed')resolveDispose?.();
  else if(m.kind==='done')resolveDone({blob:m.blob,stats:{...m.stats,complete:m.stats.complete&&!overflow&&!incompleteReason,error:incompleteReason||(overflow?'이벤트 기록 대기 한도 초과':m.stats.error)},dispose});
 };
 worker.onerror=event=>{rejectReady(Error(event.message));rejectDone?.(Error(event.message));};
 const timer=setTimeout(()=>rejectReady(Error('무손실 기록 준비 시간 초과')),10000);
 worker.postMessage({kind:'init',port:channel.port2},[channel.port2]);
 try{await ready;}catch(error){worker.terminate();channel.port1.close();throw error;}finally{clearTimeout(timer);}
 async function dispose(){
  if(closed)return;closed=true;channel.port1.close();
  await new Promise<void>(resolve=>{const timeout=setTimeout(resolve,2000);resolveDispose=()=>{clearTimeout(timeout);resolve();};worker.postMessage({kind:'dispose'});});worker.terminate();
 }
 return {
  incomplete(reason:string){incompleteReason=reason;},
  takePort(){if(attached)throw Error('재현 기록이 이미 연결되었습니다.');attached=true;return channel.port1;},
  event(type:string,value:unknown,time:number){
   if(closed||finished||overflow)return;
   const entry:ExactEvent={kind:'event',seq:++sequence,time:Math.max(0,time),type,value};
   const size=JSON.stringify(entry).length*2;
   if(pendingBytes+size>1024*1024){overflow=true;return;}
   pending.push(entry);pendingBytes+=size;if(pending.length>=64||pendingBytes>=64*1024)flush();
  },
  async finish(){
   if(done)return done;finished=true;
   done=new Promise<ExactRecording>((r,j)=>{resolveDone=r;rejectDone=j;});
   // Wait only for small event batches; source frames are drained by their port's end marker.
   const deadline=performance.now()+10000;
   void done.catch(()=>{});
   while((pending.length||inFlight)&&performance.now()<deadline){flush();await new Promise(r=>setTimeout(r,10));}
   if(pending.length||inFlight)overflow=true;
   worker.postMessage({kind:'finish',noSource:!attached||!!incompleteReason});
   const timeout=setTimeout(()=>rejectDone(Error('무손실 기록 종료 시간 초과')),Math.max(1,deadline-performance.now()));
   try{return await done;}finally{clearTimeout(timeout);}
  },dispose,
 };
}
export type ExactRecorder=Awaited<ReturnType<typeof createExactRecording>>;
