import {exactEntries,executionSummary} from './exact-recording-codec';
import type {ExactRecording,ExactRecordingStats,ExactEventQueueStats} from './exact-recording';
import {yieldForCapture} from './input-source';

export interface CanonicalFinalizationReceipt {
  readonly version:1;readonly kind:'canonical-finalization-validation';
  readonly bytes:number;readonly frames:number;readonly events:number;
  readonly producer:{readonly canonical:true;readonly complete:true;readonly dropped:0;readonly eventQueueSettled:true};
  readonly raster:{readonly supported:true;readonly complete:true;readonly matches:true;
    readonly uses:number;readonly verified:number;readonly measured:number;readonly reused:number};
  readonly capturedState:{
    readonly input:{readonly supported:true;readonly admissionSupported:true;readonly pipelineSupported:true;readonly settled:true;readonly hash:string};
    readonly inventory:{readonly supported:true;readonly hash:string};
    readonly grid:{readonly supported:true;readonly hash:string};
    readonly unknown:{readonly supported:true;readonly complete:true;readonly hash:string};
    readonly freshness:{readonly supported:true;readonly complete:true;readonly hash:string};
  };
  readonly scope:{readonly eventEnvelopeAndCapturedState:true;readonly sourceUseRasterBinding:true;
    readonly payloadPixelsDecoded:false;readonly payloadPixelHashesVerified:false;readonly osCaptureTimingReplayed:false;
    readonly recognitionRecomputed:false;readonly liveOwnership:'enforced-by-caller'};
}
export class CanonicalFinalizationError extends Error {
  readonly reason:'producer'|'event-queue'|'execution'|'source-gap'|'unsupported'|'captured-state'|'changed';
  constructor(reason:CanonicalFinalizationError['reason'],detail:string){
    super(`Canonical finalization verification failed: ${detail}`);this.name='CanonicalFinalizationError';this.reason=reason;
  }
}
function fail(reason:CanonicalFinalizationError['reason'],detail:string):never {throw new CanonicalFinalizationError(reason,detail);}
const natural=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min;
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function dataRecord(value:unknown,label:string,maxKeys=32):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('producer',label);
  const keys=Reflect.ownKeys(value);if(keys.length>maxKeys)fail('producer',label);
  for(const key of keys)if(typeof key!=='string'||!('value'in Object.getOwnPropertyDescriptor(value,key)!))fail('producer',`${label} accessor`);
  return value as Record<string,unknown>;
}
const QUEUE_FIELDS=['version','acceptedEvents','postedBatches','acknowledgedBatches','pendingEvents','pendingBytes',
  'peakPendingBytes','inFlightBatches','peakInFlightBatches','firstFailure'];
function checkedQueue(value:unknown,events:number):Readonly<ExactEventQueueStats> {
  const queue=dataRecord(value,'missing event queue');
  if(Reflect.ownKeys(queue).length!==QUEUE_FIELDS.length||QUEUE_FIELDS.some(key=>!Object.hasOwn(queue,key))||
    queue.version!==1||queue.firstFailure!==null||QUEUE_FIELDS.filter(key=>key!=='firstFailure'&&key!=='version').some(key=>!natural(queue[key]))||
    queue.acceptedEvents!==events||queue.pendingEvents!==0||queue.pendingBytes!==0||queue.inFlightBatches!==0||
    queue.postedBatches!==queue.acknowledgedBatches||(queue.postedBatches as number)<1||
    (queue.postedBatches as number)>events||(queue.peakInFlightBatches as number)<1||(queue.peakInFlightBatches as number)>4||
    (queue.peakPendingBytes as number)<1||(queue.peakPendingBytes as number)>1024*1024)fail('event-queue','event queue failed, missing or unsettled');
  return Object.freeze({...queue}) as unknown as Readonly<ExactEventQueueStats>;
}
function producer(recording:ExactRecording){
  const owner=dataRecord(recording,'recording');
  if(['blob','stats','dispose'].some(key=>!Object.hasOwn(owner,key)))fail('producer','missing recording fields');
  const blob=owner.blob,stats=dataRecord(owner.stats,'stats');
  if(['canonical','complete','dropped','error','bytes','frames','events','eventQueue'].some(key=>!Object.hasOwn(stats,key)))
    fail('producer','missing producer fields');
  if(!(blob instanceof Blob)||typeof owner.dispose!=='function'||!natural(blob.size,1)||stats.canonical!==true||
    stats.complete!==true||stats.dropped!==0||stats.error!==''||stats.bytes!==blob.size||!natural(stats.frames,1)||
    !natural(stats.events,1))fail('producer','canonical producer is incomplete');
  const queue=checkedQueue(stats.eventQueue,stats.events as number);
  // Snapshot only bounded scalar totals consumed by the existing summary. Never
  // copy raster diagnostics, cards, source frames or arbitrary nested objects.
  const totals:ExactRecordingStats={frames:stats.frames as number,events:stats.events as number,dropped:0,bytes:blob.size,
    complete:true,error:'',canonical:true,peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,eventQueue:queue};
  for(const key of ['storageVersion','nativeFrames','rgbaFrames','nativeAttestedFrames','codec','policy'] as const)
    if(Object.hasOwn(stats,key))Object.assign(totals,{[key]:stats[key]});
  return {blob,statsIdentity:owner.stats,queueIdentity:stats.eventQueue,totals:Object.freeze(totals),
    fingerprint:JSON.stringify({frames:totals.frames,events:totals.events,bytes:totals.bytes,complete:true,dropped:0,error:'',canonical:true,
      storageVersion:totals.storageVersion,nativeFrames:totals.nativeFrames,rgbaFrames:totals.rgbaFrames,nativeAttestedFrames:totals.nativeAttestedFrames,
      codec:totals.codec,policy:totals.policy,eventQueue:queue})};
}
const CHECKPOINTS=['input-checkpoint','inventory-checkpoint','grid-checkpoint','unknown-checkpoint','freshness-checkpoint'];
/** A native Blob read is not necessarily cancellable. Observe both late success
 * and failure while ending the caller's wait as soon as its signal aborts. The
 * validation task also checks that same signal before creating any receipt. */
function abortableValidation(pending:Promise<CanonicalFinalizationReceipt>,signal:AbortSignal):Promise<CanonicalFinalizationReceipt> {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const clean=()=>signal.removeEventListener('abort',abort);
    const abort=()=>{if(settled)return;settled=true;clean();reject(signal.reason??new DOMException('Aborted','AbortError'));};
    signal.addEventListener('abort',abort,{once:true});
    pending.then(receipt=>{if(settled)return;settled=true;clean();resolve(receipt);},
      error=>{if(settled)return;settled=true;clean();reject(error);});
    if(signal.aborted)abort();
  });
}
/** Event/header verification of a live-owned finished recording. The caller owns
 * the live provenance boundary and any separate opaque store reconciliation.
 * This receipt is bounded JSON, not a transferable capability or a pixel decode
 * proof. All component replay limits remain those of executionSummary. */
export async function verifyCanonicalFinalization(recording:ExactRecording,signal:AbortSignal):Promise<CanonicalFinalizationReceipt> {
  signal.throwIfAborted();
  return abortableValidation(validateCanonicalFinalization(recording,signal),signal);
}
async function validateCanonicalFinalization(recording:ExactRecording,signal:AbortSignal):Promise<CanonicalFinalizationReceipt> {
  signal.throwIfAborted();const captured=producer(recording);
  let frameId=0,entries=0;
  try{
    // Header-only audit adds the channels which executionSummary deliberately
    // treats as optional diagnostics. The bounded envelope cache may prefetch
    // payload bytes; no complete payload is materialized or decoded here.
    for await(const {header}of exactEntries(captured.blob,signal)){
      if(header.kind==='frame'){
        if(header.canonical!==true||header.id<=frameId)fail('source-gap','mixed or unordered canonical source');frameId=header.id;
      }else{
        if(header.type.endsWith('-recording-error'))fail('source-gap','recorded channel loss');
        if(CHECKPOINTS.includes(header.type)){
          const point=dataRecord(header.value,'checkpoint');
          if(point.complete!==true||point.error!==undefined&&point.error!=='')fail('captured-state','failed checkpoint');
        }
      }
      if(++entries%256===0)await yieldForCapture(signal);
    }
    const summary=await executionSummary(captured.blob,signal,captured.totals);
    if(summary.recordingComplete!==true)fail('execution','recording is not complete');
    const raster=summary.rasterProof;
    if(!raster?.supported||raster.complete!==true||raster.matches!==true||raster.uses<1||raster.verified!==raster.uses||raster.measured<1)
      fail('unsupported','canonical raster contract or source-use receipts missing');
    const {input,inventory,grid,unknownLifecycle:unknown,freshness}=summary;
    if(!input.supported||!input.admission.supported||!input.pipeline.supported||!input.settled||
      !inventory.supported||!grid.supported||!unknown.supported||!unknown.complete||!freshness.supported||!freshness.complete)
      fail('unsupported','captured-state channel missing or incomplete');
    for(const channel of [input,inventory,grid,unknown,freshness])
      if(channel.matchesCapturedState!==true||!digest(channel.hash)||!digest(channel.expectedHash)||channel.hash!==channel.expectedHash)
        fail('captured-state','captured-state checkpoint mismatch');
    const current=producer(recording);
    if(current.blob!==captured.blob||current.statsIdentity!==captured.statsIdentity||current.queueIdentity!==captured.queueIdentity||
      current.fingerprint!==captured.fingerprint)fail('changed','recording changed during verification');
    signal.throwIfAborted();
    const reused='reused'in raster&&natural(raster.reused)?raster.reused:0;
    return Object.freeze({version:1,kind:'canonical-finalization-validation',bytes:captured.blob.size,frames:summary.frames,events:summary.events,
      producer:Object.freeze({canonical:true,complete:true,dropped:0,eventQueueSettled:true}),
      raster:Object.freeze({supported:true,complete:true,matches:true,uses:raster.uses,verified:raster.verified,measured:raster.measured,reused}),
      capturedState:Object.freeze({
        input:Object.freeze({supported:true,admissionSupported:true,pipelineSupported:true,settled:true,hash:input.hash!}),
        inventory:Object.freeze({supported:true,hash:inventory.hash!}),grid:Object.freeze({supported:true,hash:grid.hash!}),
        unknown:Object.freeze({supported:true,complete:true,hash:unknown.hash!}),freshness:Object.freeze({supported:true,complete:true,hash:freshness.hash!})}),
      scope:Object.freeze({eventEnvelopeAndCapturedState:true,sourceUseRasterBinding:true,payloadPixelsDecoded:false,payloadPixelHashesVerified:false,
        osCaptureTimingReplayed:false,recognitionRecomputed:false,liveOwnership:'enforced-by-caller'})});
  }catch(error){
    signal.throwIfAborted();
    if(error instanceof CanonicalFinalizationError)throw error;
    fail('execution',error instanceof Error?error.message.slice(0,240):'execution replay rejected');
  }
}
