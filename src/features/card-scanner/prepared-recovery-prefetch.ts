import type {SnapshotSource} from './bitmap-dispatch';
import type {createPreparedLiveSource} from './prepared-live-source';
import {sourceRgbaBytes} from './source-preparation-protocol';
import {parsePreparedAcquisitionInput,type PreparedAcquisitionInput} from './source-raster-receipt';
import type {ScannerInputElement} from './scanner-input-frame';

export interface RecoveryPreparationInput {
 readonly element:ScannerInputElement;readonly time:number;readonly percent:number;
 readonly nativeFrame?:VideoFrame;readonly canonicalFrameId?:number;readonly rgba?:Uint8Array<ArrayBuffer>;readonly sourceHash?:string;
}
export type PreparedRecoveryFrame<T extends RecoveryPreparationInput>=T extends unknown?Omit<T,'element'|'nativeFrame'|'rgba'>&{
 readonly element:HTMLCanvasElement;readonly width:number;readonly height:number;
 readonly preparedSourceId:number;readonly preparedInput?:PreparedAcquisitionInput;readonly rgba?:Uint8Array<ArrayBuffer>;
}:never;
type Sources=Pick<ReturnType<typeof createPreparedLiveSource>,'submit'|'retain'|'take'|'release'|'flush'>&{
 readyForRecovery?:(width:number,height:number,signal:AbortSignal)=>Promise<void>;
};
export interface PreparedRecoveryPrefetchOptions {
 canvasFactory?:()=>HTMLCanvasElement;
 /** Recording-local arrival clock, distinct from the preserved sample PTS. */
 elapsed:()=>number;
 /** May tighten the two-frame ownership budget, never widen its 128MiB cap. */
 maxRetainedBytes?:number;
}
export interface PreparedRecoveryPrefetchStats {
 readonly prepared:number;readonly canonical:number;readonly yielded:number;readonly pendingReads:number;
 readonly retainedFrames:number;readonly retainedBytes:number;readonly peakRetainedFrames:number;readonly peakRetainedBytes:number;
 readonly serializedForBudget:number;readonly returned:boolean;
}
export type PreparedRecoveryPrefetch<T extends RecoveryPreparationInput>=AsyncGenerator<PreparedRecoveryFrame<T>> &{
 readonly stats:PreparedRecoveryPrefetchStats;
};

/** One preparation ahead of serial collection. Every borrowed decoder raster
 * is frozen before its iterator advances; this adapter never acquires cards or
 * mutates recognition state. Its upstream decoder must bound next()/return().
 * Decoder backings, source-worker/writer credits and acquisition allocations
 * remain separate from this adapter's placeholder+owned-RGBA reservation. */
export function preparedRecoveryPrefetch<T extends RecoveryPreparationInput>(frames:AsyncIterable<T>,sources:Sources,
 signal:AbortSignal,options:PreparedRecoveryPrefetchOptions):PreparedRecoveryPrefetch<T>{
 const limit=options.maxRetainedBytes??128*1024*1024;
 if(!Number.isSafeInteger(limit)||limit<1||limit>128*1024*1024||typeof options.elapsed!=='function')throw Error('Invalid recovery prefetch budget/clock');
 type Ticket={frame:PreparedRecoveryFrame<T>;canvas:HTMLCanvasElement;bytes:number;id?:number;released:boolean};
 type Outcome={ticket?:Ticket;error?:unknown;failed:boolean;cancelled?:boolean};
 let iterator:AsyncIterator<T>|undefined,returning:Promise<IteratorResult<T>>|undefined,closing=false;
 let prepared=0,canonical=0,yielded=0,pendingReads=0,retainedFrames=0,retainedBytes=0,peakRetainedFrames=0,peakRetainedBytes=0,serializedForBudget=0;
 const local=new AbortController(),budgetWaiters=new Set<()=>void>();
 const abort=()=>local.abort(signal.reason??new DOMException('Recovery prefetch aborted','AbortError'));
 const check=()=>{signal.throwIfAborted();local.signal.throwIfAborted();};
 const wakeBudget=()=>{for(const resolve of budgetWaiters)resolve();budgetWaiters.clear();};
 const release=(ticket:Ticket)=>{
  if(ticket.released)return;ticket.released=true;
  let error:unknown,failed=false;
  try{if(ticket.id!==undefined)sources.release(ticket.id);}catch(cause){failed=true;error=cause;}
  try{ticket.canvas.width=0;ticket.canvas.height=0;}catch(cause){if(!failed){failed=true;error=cause;}}
  retainedFrames--;retainedBytes-=ticket.bytes;wakeBudget();if(failed)throw error;
 };
 const returnIterator=()=>returning??=Promise.resolve().then(async()=>iterator?.return?await iterator.return():{done:true,value:undefined as never});
 async function reserve(bytes:number){
  if(bytes>limit)throw Error('Recovery prefetch frame exceeds ownership budget');
  let counted=false;
  while(retainedBytes+bytes>limit){
   check();if(!counted){serializedForBudget++;counted=true;}
   await new Promise<void>((resolve,reject)=>{
    const abort=()=>{budgetWaiters.delete(wake);local.signal.removeEventListener('abort',abort);reject(local.signal.reason);};
    const wake=()=>{local.signal.removeEventListener('abort',abort);resolve();};
    budgetWaiters.add(wake);local.signal.addEventListener('abort',abort,{once:true});if(local.signal.aborted)abort();
   });
  }
  check();retainedFrames++;retainedBytes+=bytes;peakRetainedFrames=Math.max(peakRetainedFrames,retainedFrames);peakRetainedBytes=Math.max(peakRetainedBytes,retainedBytes);
 }
 async function load():Promise<Outcome>{
  let canvas:HTMLCanvasElement|undefined,id:number|undefined,bytes=0,reserved=false;
  try{
   check();pendingReads++;
   let next:IteratorResult<T>;
   try{next=await iterator!.next();}finally{pendingReads--;}
   if(next.done)return {failed:false};
   check();const input=next.value;
   if(!input||!input.element||!Number.isFinite(input.time)||input.time<0||!Number.isFinite(input.percent)||input.percent<0||input.percent>100)
    throw Error('Invalid recovery prefetch source time/percent');
   if(Object.hasOwn(input,'preparedSourceId')||Object.hasOwn(input,'preparedInput'))throw Error('Recovery source is already prepared');
   const element=input.element,native=input.nativeFrame;
   const width=native?.displayWidth??('videoWidth' in element?element.videoWidth:'naturalWidth' in element?element.naturalWidth:element.width),
    height=native?.displayHeight??('videoHeight' in element?element.videoHeight:'naturalHeight' in element?element.naturalHeight:element.height);
   const rgbaBytes=sourceRgbaBytes(width,height);bytes=rgbaBytes*2;
   if(native&&('width' in element&&element.width!==width||'height' in element&&element.height!==height))throw Error('Recovery native/placeholder geometry mismatch');
   // If two large frames cannot coexist, retain the next borrowed sample but
   // wait for the consumer to release the current owned frame. No sample drops.
   await reserve(bytes);reserved=true;check();
   const isCanonical=input.canonicalFrameId!==undefined;
   if(isCanonical){
    if(!Number.isSafeInteger(input.canonicalFrameId)||input.canonicalFrameId!<1||native||!(input.rgba instanceof Uint8Array)||
      !(input.rgba.buffer instanceof ArrayBuffer)||input.rgba.byteOffset!==0||input.rgba.byteLength!==rgbaBytes||input.rgba.buffer.byteLength!==rgbaBytes||
      (input.rgba.buffer as ArrayBuffer&{resizable?:boolean}).resizable===true||typeof input.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(input.sourceHash))
      throw Error('Invalid canonical recovery source pixels/hash');
   }else if(input.rgba!==undefined||input.sourceHash!==undefined)throw Error('Unbound recovery RGBA/hash');
   if(!isCanonical)await sources.readyForRecovery?.(width,height,local.signal);
   check();canvas=(options.canvasFactory??(()=>document.createElement('canvas')))();canvas.width=width;canvas.height=height;
   const {element:_element,nativeFrame:_native,rgba:_rgba,...metadata}=input;
   if(isCanonical){
    // Consume the independently restored whole buffer before advancing the
    // source canvas pool. No duplicate physical source or pixel copy is made.
    const rgba=structuredClone(input.rgba!,{transfer:[input.rgba!.buffer]});canonical++;
    return {failed:false,ticket:{canvas,bytes,released:false,frame:{...metadata,element:canvas,width,height,preparedSourceId:input.canonicalFrameId!,rgba} as PreparedRecoveryFrame<T>}};
   }
   if(!native){
    const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('Recovery snapshot Canvas unavailable');
    context.globalCompositeOperation='copy';context.drawImage(element,0,0);
   }
   const elapsed=options.elapsed();if(!Number.isFinite(elapsed)||elapsed<0)throw Error('Invalid recovery prefetch arrival clock');
   // submit() clones borrowed native synchronously. The fallback above has its
   // own immutable Canvas until preparation finishes, independently of decoder.
   id=sources.submit((native??canvas) as SnapshotSource,input.time,elapsed,'recovery');
   if(id===undefined)throw Error('Recovery prefetch source reservation failed');
   sources.retain(id);const preparedInput=parsePreparedAcquisitionInput(await sources.take(id));check();
   if(preparedInput.binding.sourceFrameId!==id||preparedInput.binding.captureTime!==input.time||preparedInput.width!==width||preparedInput.height!==height)
    throw Error('Recovery prefetch prepared source binding mismatch');
   prepared++;
   return {failed:false,ticket:{canvas,bytes,id,released:false,frame:{...metadata,element:canvas,width,height,preparedSourceId:id,preparedInput} as PreparedRecoveryFrame<T>}};
  }catch(error){
   try{if(id!==undefined)sources.release(id);}catch{/* Preserve the source error while cleaning local ownership. */}
   try{if(canvas){canvas.width=0;canvas.height=0;}}catch{/* Preserve the source error. */}
   if(reserved){retainedFrames--;retainedBytes-=bytes;wakeBudget();}
   return {failed:true,error,cancelled:local.signal.aborted&&(error===local.signal.reason||signal.aborted&&error===signal.reason)};
  }
 }
 const generator=(async function*(){
  let current:Ticket|undefined,prefetched:Promise<Outcome>|undefined,failed=false;
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  try{
   check();iterator=frames[Symbol.asyncIterator]();let next=await load();
   while(next.ticket){
    current=next.ticket;check();
    // load's rejection is represented immediately, even while the consumer is
    // still acquiring N. Only this one extra next()/preparation can be active.
    prefetched=load();
    try{yielded++;yield current.frame;}finally{release(current);current=undefined;}
    next=await prefetched;prefetched=undefined;if(next.failed)throw next.error;
   }
   if(next.failed)throw next.error;
  }catch(error){failed=true;throw error;}
  finally{
   closing=true;local.abort(new DOMException('Recovery prefetch closed','AbortError'));wakeBudget();
   let cleanupError:unknown,cleanupFailed=false;
   const cleanupFailure=(error:unknown)=>{if(!cleanupFailed){cleanupFailed=true;cleanupError=error;}};
   try{if(current)release(current);}catch(error){cleanupFailure(error);}
   // Calling return once also lets cooperative decoders stop a pending next.
   // Their finite next/cleanup deadlines bound adapters that queue the return.
   const returned=returnIterator();void returned.catch(()=>{});
   if(prefetched){const result=await prefetched;if(result.ticket){try{release(result.ticket);}catch(error){cleanupFailure(error);}}
    else if(result.failed&&!result.cancelled)cleanupFailure(result.error);}
   try{await sources.flush();}catch(error){cleanupFailure(error);}
   try{await returned;}catch(error){cleanupFailure(error);}
   signal.removeEventListener('abort',abort);
   // oxlint-disable-next-line no-unsafe-finally
   if(!failed&&!signal.aborted&&cleanupFailed)throw cleanupError;
  }
 })();
 Object.defineProperty(generator,'stats',{get:():PreparedRecoveryPrefetchStats=>Object.freeze({prepared,canonical,yielded,pendingReads,
  retainedFrames,retainedBytes,peakRetainedFrames,peakRetainedBytes,serializedForBudget,returned:closing})});
 return generator as PreparedRecoveryPrefetch<T>;
}
