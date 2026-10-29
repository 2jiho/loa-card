import {createRecordingInputRaster,recordingInputBytes,type RecordingRasterInput} from './recording-input-raster';

export type RecordingRasterEngine='nested-worker'|'inline';
export interface RasterResult {
 readonly pixels:Uint8Array<ArrayBuffer>;
 readonly readbackMs:number;
 readonly queueMs:number;
 readonly roundTripMs:number;
}
export interface RasterJob {
 read():Promise<RasterResult>;
 /** Join raster ownership, including a skipped codec slot. Does not mutate a
  * returned pixel buffer: the codec may retain it as its XOR predecessor. */
 release():Promise<void>;
}
export type RasterWorker=Pick<Worker,'onmessage'|'onerror'|'onmessageerror'|'postMessage'|'terminate'>;
export interface RecordingRasterPipelineOptions {
 createWorker?:()=>RasterWorker|undefined;
 inlineRead?:(input:RecordingRasterInput)=>Uint8Array<ArrayBuffer>;
 now?:()=>number;
 prepareTimeoutMs?:number;
 timeoutMs?:number;
 maxPendingBytes?:number;
 maxPendingJobs?:number;
}

type JobState={id:number;input:RecordingRasterInput;bytes:number;submitted:number;owned:boolean;started:boolean;released:boolean;settled:boolean;
 timer:ReturnType<typeof setTimeout>;promise:Promise<RasterResult>;resolve:(result:RasterResult)=>void;reject:(error:unknown)=>void;
 workDone:Promise<void>;finishWork:()=>void;release?:Promise<void>};
const finiteTime=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function closeBitmap(input:RecordingRasterInput){try{input?.bitmap?.close();}catch{/* Ownership still ends after a failed/closed native payload. */}}

/** Starts raster conversion independently of the ordered codec chain. Credits
 * remain reserved until release(), not merely until the child returns pixels. */
export async function createRecordingRasterPipeline(options:RecordingRasterPipelineOptions={}) {
 const now=options.now??(()=>performance.now()),timeout=options.timeoutMs??30_000,prepareTimeout=options.prepareTimeoutMs??3000,
  limit=options.maxPendingBytes??128*1024*1024,jobLimit=options.maxPendingJobs??128;
 if(!Number.isSafeInteger(limit)||limit<1||!finiteTime(timeout)||timeout<1||timeout>60_000||
  !Number.isSafeInteger(jobLimit)||jobLimit<1||jobLimit>10_000||
  !finiteTime(prepareTimeout)||prepareTimeout<1||prepareTimeout>10_000)throw Error('기록 픽셀 작업 한도 오류');
 const inline=options.inlineRead??createRecordingInputRaster().read;
 let worker:RasterWorker|undefined,engine:RecordingRasterEngine='inline',ready=false,closed=false,fatal:unknown;
 let nextId=0,pendingBytes=0,peakPendingBytes=0,submitted=0,dispatched=0,completed=0,failures=0,cancelled=0;
 let readbackMs=0,queueMs=0,roundTripMs=0,maxReadbackMs=0,maxQueueMs=0,maxRoundTripMs=0,lastError='';
 const jobs=new Map<number,JobState>();
 let resolveReady!:()=>void,rejectReady!:(reason:unknown)=>void,resolveDisposed:(()=>void)|undefined,disposing:Promise<void>|undefined;
 const prepared=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});void prepared.catch(()=>{});
 const rememberError=(error:unknown)=>{lastError ||= String(error).slice(0,2000);};
 function finishWork(job:JobState){if(job.settled)return;job.settled=true;clearTimeout(job.timer);job.finishWork();}
 function rejectJob(job:JobState,error:unknown){
  if(job.settled)return;
  failures++;rememberError(error);if(job.owned){closeBitmap(job.input);job.owned=false;}
  job.reject(error);finishWork(job);
 }
 function stopWorker(error:unknown){
  fatal??=error;rememberError(error);
  if(worker){worker.onmessage=worker.onerror=worker.onmessageerror=null;worker.terminate();worker=undefined;}
  for(const job of jobs.values())rejectJob(job,error);
  resolveDisposed?.();
 }
 function accept(job:JobState,result:RasterResult){
  if(job.settled)return;
  if(!(result.pixels instanceof Uint8Array)||!(result.pixels.buffer instanceof ArrayBuffer)||result.pixels.byteOffset!==0||
   result.pixels.byteLength!==job.bytes||result.pixels.buffer.byteLength!==job.bytes||
   !finiteTime(result.readbackMs)||!finiteTime(result.queueMs)||!finiteTime(result.roundTripMs)){
   rejectJob(job,Error('기록 픽셀 응답 크기 또는 시각 오류'));return;
  }
  completed++;readbackMs+=result.readbackMs;queueMs+=result.queueMs;roundTripMs+=result.roundTripMs;
  maxReadbackMs=Math.max(maxReadbackMs,result.readbackMs);maxQueueMs=Math.max(maxQueueMs,result.queueMs);maxRoundTripMs=Math.max(maxRoundTripMs,result.roundTripMs);
  if(!job.released)job.resolve(result);
  finishWork(job);
 }
 function receive(event:MessageEvent){
  const data=event.data;
  if(!ready){if(data?.kind==='ready'){ready=true;resolveReady();}else rejectReady(Error('기록 픽셀 Worker 준비 응답 오류'));return;}
  if(data?.kind==='disposed'){resolveDisposed?.();return;}
  if(data?.kind!=='raster'&&data?.kind!=='raster-error'){stopWorker(Error('기록 픽셀 Worker 응답 오류'));return;}
  if(!Number.isSafeInteger(data.id)||data.id<1||data.id>nextId){stopWorker(Error('기록 픽셀 응답 식별 오류'));return;}
  const job=jobs.get(data.id);
  // Released/timed-out tasks may return late. Their transferable buffer has no
  // retained owner here and cannot update a later request with another ID.
  if(!job||job.settled)return;
  if(data.kind==='raster-error'){rejectJob(job,Error(String(data.error).slice(0,2000)));return;}
  if(data.width!==job.input.width||data.height!==job.input.height||!(data.pixels instanceof ArrayBuffer)){
   rejectJob(job,Error('기록 픽셀 응답 식별 또는 크기 오류'));return;
  }
  accept(job,{pixels:new Uint8Array(data.pixels),readbackMs:data.readbackMs,queueMs:data.queueMs,roundTripMs:Math.max(0,now()-job.submitted)});
 }
 try{
  worker=(options.createWorker??(()=>typeof Worker!=='undefined'&&typeof OffscreenCanvas!=='undefined'
   ?new Worker(new URL('./recording-raster-worker.ts',import.meta.url),{type:'module'}):undefined))();
  if(worker){
   worker.onmessage=receive;worker.onerror=worker.onmessageerror=()=>{
    const error=Error('기록 픽셀 Worker 실행 실패');if(!ready)rejectReady(error);else stopWorker(error);
   };
   const timer=setTimeout(()=>rejectReady(Error('기록 픽셀 Worker 준비 시간 초과')),prepareTimeout);
   try{worker.postMessage({kind:'init'});await prepared;engine='nested-worker';}
   finally{clearTimeout(timer);}
  }
 }catch{
  // No payload has been transferred before this preparation boundary.
  if(worker){worker.onmessage=worker.onerror=worker.onmessageerror=null;worker.terminate();worker=undefined;}
  ready=false;engine='inline';fatal=undefined;
 }
 function rejected(input:RecordingRasterInput,error:unknown):RasterJob{
  failures++;rememberError(error);closeBitmap(input);
  const promise=Promise.reject<RasterResult>(error);void promise.catch(()=>{});
  return {read:()=>promise,release:()=>Promise.resolve()};
 }
 function release(job:JobState){return job.release??=(async()=>{
  if(!job.released){
   job.released=true;
   if(!job.settled){cancelled++;job.reject(new DOMException('기록 픽셀 작업 해제','AbortError'));
    if(!job.started){if(job.owned){closeBitmap(job.input);job.owned=false;}finishWork(job);}}
  }
  await job.workDone;
  if(jobs.delete(job.id))pendingBytes-=job.bytes;
  // Remove the pipeline's input reference, but do not detach/zero returned data.
  job.input={width:job.input.width,height:job.input.height};
 })();}
 return {
  get engine(){return engine;},
  submit(input:RecordingRasterInput):RasterJob{
   submitted++;
   let bytes:number;
   try{
    bytes=recordingInputBytes(input);
    if(closed||fatal)throw fatal??Error('기록 픽셀 작업 종료');
    if(input.bitmap&&input.pixels||!input.bitmap&&!(input.pixels instanceof ArrayBuffer))throw Error('기록 픽셀 입력 형식 오류');
    if(input.pixels&&input.pixels.byteLength!==bytes)throw Error('기록 픽셀 입력 크기 오류');
    if(pendingBytes+bytes>limit||jobs.size>=jobLimit||nextId>=Number.MAX_SAFE_INTEGER)throw Error('기록 픽셀 작업 용량 한도 초과');
   }catch(error){return rejected(input,error);}
   let resolve!:(result:RasterResult)=>void,reject!:(error:unknown)=>void,finishWork!:()=>void;
   const promise=new Promise<RasterResult>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});
   const workDone=new Promise<void>(yes=>{finishWork=yes;});
   const job:JobState={id:++nextId,input:{width:input.width,height:input.height,...(input.bitmap?{bitmap:input.bitmap}:{pixels:input.pixels})},
    bytes,submitted:now(),owned:!!input.bitmap,started:false,released:false,settled:false,promise,resolve,reject,workDone,finishWork,
    timer:setTimeout(()=>{const error=Error('기록 픽셀 작업 시간 초과');if(engine==='nested-worker')stopWorker(error);else rejectJob(job,error);},timeout)};
   jobs.set(job.id,job);pendingBytes+=bytes;peakPendingBytes=Math.max(peakPendingBytes,pendingBytes);
   if(engine==='nested-worker'&&job.input.bitmap){
    try{
     worker!.postMessage({kind:'raster',id:job.id,width:job.input.width,height:job.input.height,bitmap:job.input.bitmap,
      sentAt:performance.timeOrigin+job.submitted},[job.input.bitmap]);
     job.owned=false;job.started=true;dispatched++;
    }catch(error){rejectJob(job,error);}
   }
   return {
    read(){
     if(!job.started&&!job.settled&&!job.released){
      job.started=true;const start=now();
      try{const pixels=inline(job.input);accept(job,{pixels,readbackMs:Math.max(0,now()-start),queueMs:Math.max(0,start-job.submitted),roundTripMs:Math.max(0,now()-job.submitted)});}
      catch(error){rejectJob(job,error);}
      finally{if(job.owned){closeBitmap(job.input);job.owned=false;}}
     }
     return job.promise;
    },release:()=>release(job),
   };
  },
  async drain(){await Promise.all([...jobs.values()].map(job=>job.workDone));},
  dispose(reason?:unknown){return disposing??=(async()=>{
   closed=true;const error=reason??new DOMException('기록 픽셀 작업 종료','AbortError');
   for(const job of jobs.values()){
    if(!job.settled){cancelled++;job.reject(error);if(job.owned){closeBitmap(job.input);job.owned=false;}finishWork(job);}
    await release(job);
   }
   if(worker){const current=worker;
    await new Promise<void>(resolve=>{const timer=setTimeout(resolve,2000);resolveDisposed=()=>{clearTimeout(timer);resolve();};
     try{current.postMessage({kind:'dispose'});}catch{clearTimeout(timer);resolve();}});
    current.onmessage=current.onerror=current.onmessageerror=null;if(worker===current){current.terminate();worker=undefined;}
   }
  })();},
  get stats(){return {engine,submitted,dispatched,completed,failures,cancelled,pending:jobs.size,pendingBytes,peakPendingBytes,
   readbackMs,queueMs,roundTripMs,maxReadbackMs,maxQueueMs,maxRoundTripMs,error:lastError};},
 };
}
