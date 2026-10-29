import type {SnapshotSource} from './bitmap-dispatch';
import type {createCanonicalCapture} from './canonical-capture';
import type {PreparedSource,SourceBinding} from './source-preparation';
import type {PreparedAcquisitionInput} from './source-raster-receipt';
import {parsePreparedSource,sourceRgbaBytes} from './source-preparation-protocol';

type Capture=Pick<ReturnType<typeof createCanonicalCapture>,'reserve'|'submitPrepared'|'rejectReserved'|'cancel'|'captured'>&{
 readonly stats:Pick<ReturnType<typeof createCanonicalCapture>['stats'],'error'>;
 waitForRecoveryCapacity?:(size:number,signal:AbortSignal)=>Promise<void>;
 notePreparation?:(id:number,value:PreparedSource['timing'])=>void;
};
type Preparer={prepare(input:VideoFrame|ImageBitmap,binding:SourceBinding,request?:{attest?:boolean}):Promise<PreparedSource>};
type Owned=VideoFrame|ImageBitmap;
/** A small source queue outside detector/OCR. Persistence survives replacement
 * of a recognition representative; its full RGBA output does not. Physical IDs
 * are reserved before async preparation while recording is healthy. After its
 * sticky failure, new logical IDs bind preparation only and never name archive
 * frames. This is dev opt-in, not a new default. */
export function createPreparedLiveSource(capture:Capture,preparer:Preparer,signal:AbortSignal,options:{
 snapshot?:(source:SnapshotSource)=>Owned|Promise<Owned>;
 maxFrames?:number;maxBytes?:number;snapshotTimeoutMs?:number;
 attestNative?:true;
}={}){
 const maxFrames=options.maxFrames??4,maxBytes=options.maxBytes??128*1024*1024,snapshotTimeout=options.snapshotTimeoutMs??3000;
 if(options.attestNative!==undefined&&options.attestNative!==true||!Number.isSafeInteger(maxFrames)||maxFrames<1||maxFrames>4||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>128*1024*1024||
  !Number.isSafeInteger(snapshotTimeout)||snapshotTimeout<1||snapshotTimeout>10_000)
  throw Error('Invalid prepared source queue limit');
 type Job={id:number;width:number;height:number;time:number;bytes:number;reserved:boolean;recordingGap:boolean;owned:Promise<Owned>;retained:boolean;taken:boolean;pixels?:PreparedAcquisitionInput;ready:Promise<void>;
  resolve:()=>void;reject:(error:unknown)=>void;settled:boolean;running:boolean;cancelSnapshot:(error:unknown)=>void};
 const jobs=new Map<number,Job>(),queue:Job[]=[];
 // These are physical-source candidates only after a successful writer handoff.
 // An ephemeral logical source ID is never added here or later persisted.
 const physicalInputs=new Set<number>();
 let running=false,closing=false,finished=false,failure:unknown,hasFailure=false,bytes=0,peakBytes=0,peakJobs=0,prepared=0,released=0;
 let lastLogicalId=0,persistenceFailed=false,recordingError='',recordingGapSources=0,ephemeralSources=0,unpersistedPrepared=0;
 let idleResolve:(()=>void)|undefined,idle:Promise<void>|undefined;
 const snapshot=options.snapshot??((source:SnapshotSource)=>{
  if('displayWidth' in source)return source.clone();
  if('videoWidth' in source&&typeof VideoFrame==='function'){
   // Freeze a moving video's current sample synchronously, just like selected
   // native inputs. Only constructor failure may take the bitmap fallback;
   // preparation owns a successful snapshot and must never recapture video.
   try{return new VideoFrame(source);}catch{/* This video/browser cannot create a native snapshot. */}
  }
  return createImageBitmap(source);
 });
 const close=(input:Owned)=>{try{input.close();}catch{/* Ownership cleanup continues for other sources. */}};
 const notifyRejected=(id:number,error:unknown)=>{try{capture.rejectReserved(id,error);}catch{/* Reporting cannot retain a source lease. */}};
 function storageError(){const value=capture.stats.error;return typeof value==='string'&&value.trim()?value.slice(0,2000):undefined;}
 function losePersistence(error:string){persistenceFailed=true;recordingError||=error;}
 function gap(job:Job){if(!job.recordingGap){job.recordingGap=true;recordingGapSources++;}}
 function remove(job:Job){if(jobs.delete(job.id)){bytes-=job.bytes;job.pixels=undefined;released++;}}
 function settle(job:Job,error?:unknown){if(job.settled)return;job.settled=true;if(error!==undefined)job.reject(error);else job.resolve();}
 function fail(error:unknown){
  if(hasFailure)return;hasFailure=true;failure=error;
  try{capture.cancel();}catch{/* Local cleanup remains authoritative. */}
  for(const job of jobs.values()){
   job.cancelSnapshot(error);
   settle(job,error);
   if(!job.running)void job.owned.then(close,()=>{});
   remove(job);
  }
  queue.length=0;idleResolve?.();
 }
 async function pump(){
  if(running||hasFailure)return;running=true;
  try{
   for(let job=queue.shift();job;job=queue.shift()){
    job.running=true;let input:Owned|undefined;
    try{
     signal.throwIfAborted();input=await job.owned;
     if(hasFailure||signal.aborted){input.close();input=undefined;signal.throwIfAborted();throw failure;}
     // prepare() owns the handle even when it rejects.
     const owned=input;input=undefined;
     // Once persistence fails, later logical inputs must not issue unused
     // tickets into a writer that can no longer consume them.
     const requestAttestation=options.attestNative===true&&job.reserved&&!persistenceFailed&&!storageError();
     const binding={sourceFrameId:job.id,captureTime:job.time};
     const result=parsePreparedSource(options.attestNative?
       await preparer.prepare(owned,binding,{attest:requestAttestation}):await preparer.prepare(owned,binding));
     signal.throwIfAborted();if(hasFailure)throw failure;
     if(result.binding.sourceFrameId!==job.id||result.binding.captureTime!==job.time||result.width!==job.width||result.height!==job.height)
      throw Error('Prepared live source binding mismatch');
     if(result.storage.kind==='native'&&requestAttestation!==(result.storage.ticketId!==undefined))
      throw Error('Prepared live native ticket request mismatch');
     // A diagnostic callback cannot change ownership, admission or valid pixels.
     try{capture.notePreparation?.(job.id,result.timing);}catch{/* Timing is optional. */}
     const failedStorage=storageError();if(failedStorage)losePersistence(failedStorage);
     if(job.reserved&&!persistenceFailed){
      // A pre-existing recorder failure is separate from valid source pixels.
      // A NEW synchronous validation/transfer failure is not: keep it fatal.
      if(result.storage.kind==='native')capture.submitPrepared(job.id,{native:{descriptor:result.storage.descriptor,pixels:result.storage.pixels,
        ...(result.storage.ticketId?{ticketId:result.storage.ticketId}:{})},hash:result.hash});
      else capture.submitPrepared(job.id,{pixels:result.storage.pixels,hash:result.hash});
      const error=storageError();if(error)throw Error(error);physicalInputs.add(job.id);
     }
     if(!physicalInputs.has(job.id)){gap(job);unpersistedPrepared++;}
     if(job.retained)job.pixels={pixels:result.pixels,width:result.width,height:result.height,binding:result.binding};
     prepared++;settle(job);if(!job.retained)remove(job);
    }catch(error){if(input)close(input);if(job.reserved)notifyRejected(job.id,error);settle(job,error);fail(error);break;}
    finally{job.running=false;}
   }
  }finally{running=false;idleResolve?.();idleResolve=undefined;idle=undefined;}
 }
 function wait(){if(!running&&!queue.length)return Promise.resolve();return idle??=new Promise<void>(resolve=>{idleResolve=resolve;});}
 const abort=()=>fail(signal.reason??new DOMException('Prepared source aborted','AbortError'));
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 return {
  submit(source:SnapshotSource,time:number,elapsed:number,role:'input'|'backup'|'recovery'='backup'){
   if(closing||hasFailure||signal.aborted)return;
   const width='displayWidth' in source?source.displayWidth:'videoWidth' in source?source.videoWidth:source.width,
    height='displayHeight' in source?source.displayHeight:'videoHeight' in source?source.videoHeight:source.height;
   let size:number;
   try{
    size=sourceRgbaBytes(width,height)*2;
    if(!Number.isFinite(time)||time<0||!Number.isFinite(elapsed)||elapsed<0||!['input','backup','recovery'].includes(role))throw Error('Invalid prepared source time/role');
   }catch(error){fail(error);return;}
   if(jobs.size>=maxFrames||bytes+size>maxBytes){fail(Error('Prepared source queue capacity exceeded'));return;}
   const failedStorage=storageError();if(failedStorage)losePersistence(failedStorage);
   let record:ReturnType<Capture['reserve']>;
   if(!persistenceFailed){
    try{record=capture.reserve({width,height,time,elapsed,role},size);}catch(error){fail(error);return;}
    if(!record){const error=storageError();if(!error)return;losePersistence(error);}
   }
   let id:number;
   if(record){id=record.id;if(!Number.isSafeInteger(id)||id<=lastLogicalId){fail(Error('Prepared source reservation identity conflict'));return;}lastLogicalId=id;}
   else{
    // After the sticky recording failure, preserve capture chronology with
    // process-local source IDs above the physical namespace's final high water.
    // They bind exact preparation/acquisition pixels but are not archive IDs.
    const highWater=Math.max(lastLogicalId,capture.captured);
    if(!Number.isSafeInteger(highWater)||highWater<0||highWater>=Number.MAX_SAFE_INTEGER){fail(Error('Prepared ephemeral source identity limit'));return;}
    id=lastLogicalId=highWater+1;ephemeralSources++;
   }
   let raw:Promise<Owned>;
   try{raw=Promise.resolve(snapshot(source));}catch(error){if(record)notifyRejected(id,error);fail(error);return;}
   let cancelSnapshot!:(error:unknown)=>void;
   const owned=new Promise<Owned>((resolve,reject)=>{
    let settled=false,abandoned=false;
    const timer=setTimeout(()=>cancelSnapshot(Error('Prepared source snapshot timeout')),snapshotTimeout);
    cancelSnapshot=error=>{if(settled)return;settled=true;abandoned=true;clearTimeout(timer);reject(error);};
    void raw.then(input=>{if(abandoned){close(input);return;}settled=true;clearTimeout(timer);resolve(input);},error=>{
      if(settled)return;settled=true;clearTimeout(timer);reject(error);
    });
   });
   // Attach a handler immediately while earlier jobs are still active.
   void owned.catch(()=>{});
   let resolve!:()=>void,reject!:(error:unknown)=>void;const ready=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void ready.catch(()=>{});
   const job:Job={id,width,height,time,bytes:size,reserved:!!record,recordingGap:false,owned,retained:false,taken:false,ready,resolve,reject,settled:false,running:false,cancelSnapshot};
   if(!record)gap(job);
   jobs.set(job.id,job);queue.push(job);bytes+=size;peakBytes=Math.max(peakBytes,bytes);peakJobs=Math.max(peakJobs,jobs.size);
   // Same-stack retain() can attach the recognition lease before work starts.
   queueMicrotask(()=>{void pump();});return id;
  },
  retain(id:number|undefined){if(id===undefined)return;const job=jobs.get(id);if(!job||job.taken)throw Error('Prepared source lease missing');job.retained=true;},
  /** A physical handoff may still await ACK; this is not journal durability.
   * Logical-only IDs must never produce canonical archive-use events. */
  isPersistent(id:number|undefined){return id!==undefined&&physicalInputs.has(id);},
  async readyForRecovery(width:number,height:number,waitSignal:AbortSignal=signal){
   const combined=waitSignal===signal?signal:AbortSignal.any([signal,waitSignal]);
   combined.throwIfAborted();if(closing||hasFailure)throw failure??Error('Prepared source closed');
   const size=sourceRgbaBytes(width,height)*2;if(size>maxBytes)throw Error('Prepared recovery source exceeds byte limit');
   if(!persistenceFailed&&!storageError())await capture.waitForRecoveryCapacity?.(size,combined);
   combined.throwIfAborted();if(closing||hasFailure)throw failure??Error('Prepared source closed');
  },
  async take(id:number):Promise<PreparedAcquisitionInput>{
   const job=jobs.get(id);if(!job||!job.retained||job.taken)throw Error('Prepared source lease unavailable');
   job.taken=true;await job.ready;signal.throwIfAborted();if(hasFailure)throw failure;
   const pixels=job.pixels;if(!pixels)throw Error('Prepared source pixels missing');remove(job);return pixels;
  },
  release(id:number|undefined){if(id===undefined)return;const job=jobs.get(id);if(!job||job.taken)return;job.retained=false;if(job.settled)remove(job);},
  async flush(){await wait();if(hasFailure)throw failure;},
  async finish(){closing=true;await wait();if(hasFailure)throw failure;for(const job of jobs.values())if(!job.taken)remove(job);finished=true;},
  dispose(){closing=true;signal.removeEventListener('abort',abort);if(!finished)fail(new DOMException('Prepared source disposed','AbortError'));},
  get stats(){return {pending:jobs.size,pendingBytes:bytes,peakPendingBytes:peakBytes,peakJobs,prepared,released,failed:hasFailure,
    persistenceFailed,recordingError,recordingGapSources,ephemeralSources,unpersistedPrepared};},
 };
}
