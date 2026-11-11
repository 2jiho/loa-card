import type {RecognitionInputMeta,ReaderCropClaim} from '../recognition/recognition-input-observer';
import type {ObservationSource} from '../session/observation-execution';
import {parseObservationFact} from '../session/observation-execution';
import type {OriginalBindingDescription} from './saved-acquisition';
import type {UnknownCrop} from '../session/unknown-crop-retention';
import type {RestoredPixelCapability,RestoredPixelIdentity} from './restored-pixel-capability';
import {createVerifiedCropReader,type PrivateCropReadResult} from './verified-crop-reader';
import {pixelHash} from '../reproduction/recording-frame-integrity';

/** Development-only composition that links an unidentified ORIGINAL source with
 * its actual recognition pixels. It is not wired into the scanner, its
 * completion conditions or any production path.
 *
 * Inputs: a prepared-source metadata binding (a SavedOriginalSourceBindings.read
 * result), the retained unknown crop copy for the same original source (an
 * UnknownCropRetention.get result, or null when nothing was retained), and the
 * one-use handoff of the authenticated restored original raster
 * (RestoredPixelCapability.consume). The read callback must be a trusted
 * wrapper around the intended recognizer with its own real budget.
 *
 * Guarantees enforced here: the retained crop must be byte-equal to the
 * restored original's region before any read attempt; the read is a re-read of
 * the SAME pixels, so it is never an independent observation and never
 * completion evidence; a result is resolved only when name, awakening and
 * count are all confirmed in that single read from the original source; and a
 * newer confirmed capture for the same card (caller oracle, capture-time
 * basis, not processing time) makes the result stale instead of overwriting.
 * Hash mismatch, budget, timeout and close stay unresolved with a reason. */

export type VerifiedRecoveryReadStatus='resolved'|'stale'|'unresolved'|'mismatch'|'unidentified'|
  'unavailable'|'cancelled'|'timeout'|'capacity'|'error';

export interface RecoveryReadIdentity {
  readonly id:string;
  readonly name:string;
  readonly review:readonly string[];
  /** Awakening confirmed in this single recovery read. null means unconfirmed. */
  readonly awakening:number|null;
  /** Extra copies confirmed in this single recovery read. null means unconfirmed, never 0. */
  readonly copies:number|null;
}
export type RecoveryReadCallback=(canvas:HTMLCanvasElement,signal:AbortSignal)=>Promise<RecoveryReadIdentity|null>;
/** Structural view of the restored pixel capability: only the one-use handoff. */
export interface RestoredPixelStore {
  readonly consume:(token:unknown,expected:RestoredPixelIdentity,signal:AbortSignal)=>
    Promise<{pixels:Uint8Array<ArrayBuffer>;identity:RestoredPixelIdentity}|undefined>;
}
export interface VerifiedRecoveryReadRequest {
  readonly description:OriginalBindingDescription;
  /** UnknownCropRetention.get(original source) copy, or null when nothing was retained. */
  readonly crop:UnknownCrop|null;
  readonly restored:RestoredPixelStore;
  readonly token:RestoredPixelCapability;
  readonly identity:RestoredPixelIdentity;
  readonly signal:AbortSignal;
}
export interface VerifiedRecoveryReadResult {
  readonly status:VerifiedRecoveryReadStatus;
  readonly identity:RecoveryReadIdentity|null;
  readonly source:ObservationSource|null;
  readonly reason:string|null;
  readonly independentObservation:false;
  readonly completionEvidence:false;
  readonly pixelByteMatch:boolean;
  readonly restoredPixelsConsumed:boolean;
  readonly latestConfirmedCaptureTime:number|null;
}
export interface VerifiedRecoveryReadOptions {
  readonly reader:RecoveryReadCallback;
  /** Latest confirmed capture time per card ID (capture-time basis, not
   * processing time). null means no confirmed evidence for that card. */
  readonly latestConfirmedCaptureTime?:(cardId:string)=>number|null;
  readonly canvasFactory?:()=>HTMLCanvasElement;
  readonly hash?:(bytes:Uint8Array<ArrayBuffer>)=>Promise<string>;
  /** Read budget shared with the scanner's per-card read budget. */
  readonly timeoutMs?:number;
}
export interface VerifiedRecoveryReader {
  read(request:VerifiedRecoveryReadRequest):Promise<VerifiedRecoveryReadResult>;
  close():void;
  stats():Readonly<{busy:boolean;closed:boolean;reservedBytes:number}>;
}

const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
const nonnegativeCount=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0;
function ownData(value:unknown,keys:readonly string[]):Record<string,unknown>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return;
  const d=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(d).length!==keys.length||keys.some(key=>!Object.hasOwn(d,key)||!Object.hasOwn(d[key],'value')))return;
  return Object.fromEntries(keys.map(key=>[key,d[key].value]));
}
function checkedSource(value:unknown):ObservationSource|undefined {
  const record=ownData(value,['sessionId','frameId','observationId','captureOrder','captureTime','phase','slot']);
  if(!record)return;
  try{return parseObservationFact({version:1,kind:'queued',attemptId:0,source:record}).source;}catch{return;}
}
function checkedBox(value:unknown):{x:number;y:number;width:number;height:number}|undefined {
  const record=ownData(value,['x','y','width','height']);
  if(!record)return;
  const {x,y,width,height}=record;
  if(typeof x!=='number'||!Number.isFinite(x)||x<0||typeof y!=='number'||!Number.isFinite(y)||y<0)
    return;
  if(!positive(width)||!positive(height))return;
  return {x,y,width,height};
}
interface CheckedDescription {
  originalSource:ObservationSource;
  recoverySource:ObservationSource;
  group:number;
  physical:{sourceFrameId:number;captureTime:number;width:number;height:number;hash:string};
  content:{x:number;y:number;width:number;height:number};
}
function checkedDescription(value:unknown):CheckedDescription|undefined {
  const record=ownData(value,['scope','pixelsAuthenticated','originalSource','originalGroup','recoverySource','physical','content','preview']);
  if(!record||record.scope!=='prepared-source-metadata-only'||record.pixelsAuthenticated!==false)return;
  if(!Number.isSafeInteger(record.originalGroup)||(record.originalGroup as number)<1)return;
  const originalSource=checkedSource(record.originalSource),recoverySource=checkedSource(record.recoverySource);
  if(!originalSource||!recoverySource||originalSource.phase!=='input'||recoverySource.phase!=='recovery'||
    originalSource.sessionId!==recoverySource.sessionId)return;
  const physical=ownData(record.physical,['sourceFrameId','captureTime','width','height','hash']);
  if(!physical)return;
  const {sourceFrameId,captureTime,width,height,hash}=physical;
  if(!positive(sourceFrameId)||typeof captureTime!=='number'||!Number.isFinite(captureTime)||captureTime<0||
    !positive(width)||!positive(height)||!digest(hash))return;
  const content=checkedBox(record.content);
  if(!content||content.x+content.width>width||content.y+content.height>height)return;
  return {originalSource,recoverySource,group:record.originalGroup as number,
    physical:{sourceFrameId,captureTime,width,height,hash},content};
}
function cropMatches(crop:UnknownCrop,description:CheckedDescription):boolean {
  const s=crop.source,p=description.physical;
  if(!s||s.sessionId!==description.originalSource.sessionId||s.observationId!==description.originalSource.observationId||
    s.frameId!==description.originalSource.frameId||s.captureOrder!==description.originalSource.captureOrder||
    s.captureTime!==description.originalSource.captureTime||s.phase!==description.originalSource.phase||
    s.slot!==description.originalSource.slot)return false;
  if(crop.group!==description.group||!positive(crop.width)||!positive(crop.height)||
    crop.sourceWidth!==p.width||crop.sourceHeight!==p.height)return false;
  const box=crop.sourceBox;
  if(!box||box.x!==description.content.x||box.y!==description.content.y||
    box.width!==description.content.width||box.height!==description.content.height)return false;
  if(crop.width!==box.width||crop.height!==box.height)return false;
  return crop.rgba instanceof Uint8ClampedArray&&crop.rgba.buffer instanceof ArrayBuffer&&
    Number.isSafeInteger(crop.width*crop.height*4)&&crop.rgba.byteLength===crop.width*crop.height*4;
}

export function createVerifiedRecoveryRead(options:VerifiedRecoveryReadOptions):VerifiedRecoveryReader {
  if(!options||typeof options.reader!=='function')throw Error('Invalid verified recovery read options');
  const reader=options.reader;
  const oracle=typeof options.latestConfirmedCaptureTime==='function'?options.latestConfirmedCaptureTime:()=>null;
  const factory=options.canvasFactory??(()=>document.createElement('canvas'));
  const hash=options.hash??pixelHash;
  const verified=createVerifiedCropReader({canvasFactory:factory,hash,timeoutMs:options.timeoutMs??3000});
  let closed=false;
  const result=(status:VerifiedRecoveryReadStatus,identity:RecoveryReadIdentity|null=null,source:ObservationSource|null=null,
    reason:string|null=null,pixelByteMatch=false,consumed=false,latestTime:number|null=null):VerifiedRecoveryReadResult=>
    Object.freeze({status,identity,source,reason,independentObservation:false,completionEvidence:false,
      pixelByteMatch,restoredPixelsConsumed:consumed,latestConfirmedCaptureTime:latestTime});
  const queryLatest=(id:string):{value:number|null;failed:boolean}=>{
    try{
      const value=oracle(id);
      if(value===null||value===undefined)return {value:null,failed:false};
      if(typeof value!=='number'||!Number.isFinite(value))return {value:null,failed:true};
      return {value,failed:false};
    }catch{return {value:null,failed:true};}
  };
  function mapOutcome(outcome:PrivateCropReadResult<RecoveryReadIdentity>,source:ObservationSource):VerifiedRecoveryReadResult {
    const latestFor=(identity:RecoveryReadIdentity|null)=>identity?queryLatest(identity.id):{value:null,failed:false};
    switch(outcome.status){
      case 'identified':{
        const identity=outcome.identity;
        if(!identity)return result('error',null,source,'identified without identity',true,true);
        const complete=nonnegativeCount(identity.awakening)&&nonnegativeCount(identity.copies);
        if(!complete){
          const latest=latestFor(identity);
          return result('unresolved',identity,source,'awakening or count not confirmed in this single read',true,true,
            latest.failed?null:latest.value);
        }
        const latest=latestFor(identity);
        if(latest.failed)return result('unresolved',identity,source,'freshness oracle failed',true,true,null);
        if(latest.value!==null&&latest.value>source.captureTime)
          return result('stale',identity,source,'newer confirmed capture exists for this card',true,true,latest.value);
        return result('resolved',identity,source,null,true,true,latest.value);
      }
      case 'review':{
        const latest=latestFor(outcome.identity);
        return result('unresolved',outcome.identity,source,'reader requested review',true,true,
          latest.failed?null:latest.value);
      }
      case 'unknown':return result('unresolved',null,source,'recovery read returned no identity',true,true);
      case 'unavailable':return result('unavailable',null,source,outcome.reason??'reader input unavailable',true,true);
      case 'mismatch':return result('mismatch',null,source,outcome.reason??'reader hash mismatch',true,true);
      case 'cancelled':return result('cancelled',null,source,outcome.reason,true,true);
      case 'timeout':return result('timeout',null,source,outcome.reason,true,true);
      case 'capacity':return result('capacity',null,source,outcome.reason,true,true);
      case 'error':return result('error',null,source,outcome.reason??'reader error',true,true);
    }
  }
  async function read(request:VerifiedRecoveryReadRequest):Promise<VerifiedRecoveryReadResult> {
    if(closed)return result('cancelled',null,null,'recovery read session closed');
    if(!request||typeof request!=='object')return result('error',null,null,'invalid request');
    const signal=request.signal;
    if(!signal||typeof signal!=='object'||typeof (signal as AbortSignal).aborted!=='boolean')
      return result('error',null,null,'invalid signal');
    if(signal.aborted)return result('cancelled');
    const description=checkedDescription(request.description);
    if(!description)return result('error',null,null,'invalid binding description');
    const {originalSource,physical,content}=description;
    if(request.crop===null||request.crop===undefined)
      return result('unidentified',null,originalSource,'no retained crop for this original source');
    if(!cropMatches(request.crop,description))
      return result('mismatch',null,originalSource,'retained crop does not match the bound original');
    if(!request.restored||typeof request.restored.consume!=='function')
      return result('error',null,originalSource,'invalid restored pixel store');
    let restored:{pixels:Uint8Array<ArrayBuffer>;identity:RestoredPixelIdentity}|undefined;
    try{restored=await request.restored.consume(request.token,request.identity,signal);}
    catch(error){
      return result(signal.aborted?'cancelled':'unavailable',null,originalSource,String(error).slice(0,200),false,true);
    }
    if(!restored)return result('unavailable',null,originalSource,'restored pixels unavailable',false,true);
    const frame=restored.identity;
    if(frame.sourceFrameId!==physical.sourceFrameId||frame.time!==physical.captureTime||
      frame.width!==physical.width||frame.height!==physical.height||frame.hash!==physical.hash)
      return result('mismatch',null,originalSource,'restored raster is not the bound original frame',false,true);
    const bytes=physical.width*physical.height*4,rgba=request.crop.rgba;
    if(restored.pixels.byteLength!==bytes)
      return result('unavailable',null,originalSource,'restored raster size',false,true);
    let byteMatch=true;
    for(let y=0;y<content.height&&byteMatch;y++){
      const frameIndex=(content.y+y)*physical.width*4+content.x*4,cropIndex=y*content.width*4;
      for(let i=0;i<content.width*4;i++)if(restored.pixels[frameIndex+i]!==rgba[cropIndex+i]){byteMatch=false;break;}
    }
    if(!byteMatch)
      return result('mismatch',null,originalSource,'retained crop differs from the restored original region',false,true);
    let cropSha:string;
    try{cropSha=await hash(new Uint8Array(rgba));}
    catch(error){return result('error',null,originalSource,String(error).slice(0,200),true,true);}
    if(!digest(cropSha))return result('error',null,originalSource,'invalid crop digest',true,true);
    const meta:RecognitionInputMeta={diagnosticReadId:0,processingFrame:0,slot:originalSource.slot,source:originalSource,
      group:description.group,trace:0,pixelKey:`recovery:${originalSource.observationId}`,stage:'full',stable:false,
      borderAlignment:0,sourceBox:{...content},sourceWidth:physical.width,sourceHeight:physical.height,
      cropWidth:content.width,cropHeight:content.height};
    const claim:ReaderCropClaim={frame:{version:1,kind:'measured',sourceFrameId:physical.sourceFrameId,
      acquisitionFrameId:originalSource.frameId,captureTime:physical.captureTime,width:physical.width,
      height:physical.height,hash:physical.hash},crop:{slot:originalSource.slot,content:{...content},sha256:cropSha}};
    let canvas:HTMLCanvasElement;
    try{
      canvas=factory();
      canvas.width=content.width;canvas.height=content.height;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      if(!context)throw Error('canvas context');
      context.putImageData(new ImageData(new Uint8ClampedArray(rgba),content.width,content.height),0,0);
    }catch(error){
      return result('unavailable',null,originalSource,String(error).slice(0,200),true,true);
    }
    try{
      const outcome=await verified.read(meta,claim,canvas,reader,signal);
      return mapOutcome(outcome,originalSource);
    }finally{
      try{canvas.width=0;canvas.height=0;}catch{/* Best effort release of the transport canvas. */}
    }
  }
  return {
    read,
    close(){closed=true;verified.close();},
    stats(){return verified.stats();},
  };
}
