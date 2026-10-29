import {gzipRunStateBytes,parseRunStateCompressionResponse,RUN_STATE_COMPRESSION_LIMITS} from './run-state-compression-worker';
export {RUN_STATE_COMPRESSION_LIMITS} from './run-state-compression-worker';
export type RunStateCompressionWorker=Pick<Worker,'postMessage'|'terminate'|'onmessage'|'onerror'|'onmessageerror'>;
export interface RunStateCompressionOptions {
 /** Test/platform adapters retain the same byte, deadline and concurrency bounds. */
 createWorker?:()=>RunStateCompressionWorker;
 nativeGzip?:(raw:Uint8Array<ArrayBuffer>,limit:number,signal:AbortSignal)=>Promise<Uint8Array<ArrayBuffer>>;
 deadlineMs?:number;idleMs?:number;
}
interface Job {
 id:number;raw?:string;bytes:number;limit:number;done:boolean;abort:AbortController;
 resolve:(value:Uint8Array<ArrayBuffer>)=>void;reject:(reason:unknown)=>void;timer?:ReturnType<typeof setTimeout>;
}
interface Lane {worker?:RunStateCompressionWorker;job?:Job;idleTimer?:ReturnType<typeof setTimeout>}
const bounded=(value:number,maximum:number)=>Number.isSafeInteger(value)&&value>0&&value<=maximum;

/** Two independent gzip lanes. Every queued/in-flight input remains reserved
 * until settled. Workers are reused briefly, then terminated, and dispose()
 * invalidates ownership before terminating so late replies cannot settle jobs. */
export class RunStateCompression {
 private readonly lanes:Lane[]=[{},{}];
 private readonly queue:Job[]=[];
 private readonly options:RunStateCompressionOptions;
 private readonly deadlineMs:number;
 private readonly idleMs:number;
 private sequence=0;
 private pendingBytes=0;
 private peakPendingBytes=0;
 private peakActive=0;
 private closed=false;
 private scheduled=false;
 private workerStarts=0;
 private workerTerminations=0;
 private workerJobs=0;
 private nativeJobs=0;
 constructor(options:RunStateCompressionOptions={}){
  this.options=options;this.deadlineMs=options.deadlineMs??RUN_STATE_COMPRESSION_LIMITS.deadlineMs;
  this.idleMs=options.idleMs??RUN_STATE_COMPRESSION_LIMITS.idleMs;
  if(!bounded(this.deadlineMs,RUN_STATE_COMPRESSION_LIMITS.deadlineMs)||!bounded(this.idleMs,RUN_STATE_COMPRESSION_LIMITS.idleMs))
   throw Error('잘못된 상태 기록 압축 시간 한도');
 }
 compress(raw:string,bytes:number,limit:number):Promise<Uint8Array<ArrayBuffer>> {
  if(this.closed||typeof raw!=='string'||!bounded(bytes,RUN_STATE_COMPRESSION_LIMITS.pendingBytes)||
   !bounded(limit,RUN_STATE_COMPRESSION_LIMITS.outputBytes)||this.pendingBytes+bytes>RUN_STATE_COMPRESSION_LIMITS.pendingBytes||
   this.sequence>=Number.MAX_SAFE_INTEGER)return Promise.reject(Error('상태 기록 압축 대기 한도 또는 종료'));
  const promise=new Promise<Uint8Array<ArrayBuffer>>((resolve,reject)=>{
   const job:Job={id:++this.sequence,raw,bytes,limit,done:false,abort:new AbortController(),resolve,reject};
   this.pendingBytes+=bytes;this.peakPendingBytes=Math.max(this.peakPendingBytes,this.pendingBytes);this.queue.push(job);
   // Queueing is synchronous; encoding, Worker setup and gzip begin after capture.
   job.timer=setTimeout(()=>{
    if(job.done)return;
    const lane=this.lanes.find(value=>value.job===job);
    if(lane&&!lane.worker){this.dispose(Error('상태 기록 압축 시간 한도 초과'));return;}
    if(lane)this.terminate(lane);
    this.settle(job,undefined,Error('상태 기록 압축 시간 한도 초과'),lane);this.schedule();
   },this.deadlineMs);
  });
  this.schedule();return promise;
 }
 private schedule():void {
  if(this.scheduled||this.closed)return;this.scheduled=true;
  queueMicrotask(()=>{this.scheduled=false;this.pump();});
 }
 private terminate(lane:Lane):void {
  clearTimeout(lane.idleTimer);lane.idleTimer=undefined;
  const worker=lane.worker;lane.worker=undefined;
  if(worker){worker.onmessage=worker.onerror=worker.onmessageerror=null;try{worker.terminate();}catch{/* Ownership is already revoked. */}this.workerTerminations++;}
 }
 private settle(job:Job,value?:Uint8Array<ArrayBuffer>,error?:unknown,lane?:Lane):void {
  if(job.done)return;job.done=true;job.raw=undefined;clearTimeout(job.timer);job.abort.abort();
  this.pendingBytes-=job.bytes;if(lane?.job===job)lane.job=undefined;
  if(error!==undefined)job.reject(error);else job.resolve(value!);
  this.schedule();
 }
 private pump():void {
  if(this.closed)return;
  for(const lane of this.lanes){
   if(lane.job)continue;
   let job:Job|undefined;while(this.queue.length&&!job){const next=this.queue.shift()!;if(!next.done)job=next;}
   if(!job){
    if(lane.worker&&!lane.idleTimer)lane.idleTimer=setTimeout(()=>{if(!lane.job)this.terminate(lane);},this.idleMs);
    continue;
   }
   clearTimeout(lane.idleTimer);lane.idleTimer=undefined;lane.job=job;
   this.peakActive=Math.max(this.peakActive,this.lanes.filter(value=>value.job).length);
   this.start(lane,job);
  }
 }
 private start(lane:Lane,job:Job):void {
  try{
   const raw=new TextEncoder().encode(job.raw);job.raw=undefined;
   if(raw.byteLength!==job.bytes)throw Error('상태 기록 압축 원문 크기 불일치');
   const worker=lane.worker??(this.options.createWorker?this.options.createWorker():
    typeof Worker==='undefined'?undefined:new Worker(new URL('./run-state-compression-worker.ts',import.meta.url),{type:'module'}));
   if(!worker){
    this.nativeJobs++;
    void (this.options.nativeGzip??gzipRunStateBytes)(raw,job.limit,job.abort.signal).then(output=>{
     if(job.done||lane.job!==job)return;
     if(!(output instanceof Uint8Array)||!(output.buffer instanceof ArrayBuffer)||output.byteOffset!==0||
      output.byteLength!==output.buffer.byteLength||!bounded(output.byteLength,job.limit))throw Error('잘못된 상태 기록 압축 결과');
     this.settle(job,output,undefined,lane);
    }).catch(error=>{if(!job.done&&lane.job===job)this.settle(job,undefined,error,lane);});return;
   }
   if(!lane.worker){lane.worker=worker;this.workerStarts++;}
   this.workerJobs++;
   const owned=()=>!job.done&&lane.job===job&&lane.worker===worker;
   const fail=(error:unknown)=>{if(!owned())return;this.terminate(lane);this.settle(job,undefined,error,lane);};
   worker.onmessage=event=>{
    if(!owned())return;
    try{this.settle(job,parseRunStateCompressionResponse(event.data,job.id,job.bytes,job.limit),undefined,lane);}
    catch(error){fail(error);}
   };
   worker.onerror=worker.onmessageerror=()=>fail(Error('상태 기록 압축 Worker 실패'));
   worker.postMessage({version:1,id:job.id,rawBytes:job.bytes,limit:job.limit,raw:raw.buffer},[raw.buffer]);
  }catch(error){this.terminate(lane);this.settle(job,undefined,error,lane);}
 }
 dispose(reason:unknown=Error('상태 기록 압축 종료')):void {
  if(this.closed)return;this.closed=true;
  for(const lane of this.lanes){const job=lane.job;this.terminate(lane);if(job)this.settle(job,undefined,reason,lane);}
  for(const job of this.queue)this.settle(job,undefined,reason);this.queue.length=0;
 }
 get stats(){return Object.freeze({pendingBytes:this.pendingBytes,peakPendingBytes:this.peakPendingBytes,
  active:this.lanes.filter(lane=>lane.job).length,peakActive:this.peakActive,workerStarts:this.workerStarts,
  workerTerminations:this.workerTerminations,workerJobs:this.workerJobs,nativeJobs:this.nativeJobs,disposed:this.closed});}
}
