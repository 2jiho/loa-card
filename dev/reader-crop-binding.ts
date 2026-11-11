import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';
import {parseObservationFact,type ObservationSource} from '../src/features/card-scanner/session/observation-execution';
import {beginRecognitionInspection} from '../src/features/card-scanner/recognition/recognition-input-observer';
import type {RecognitionInputMeta,RecognitionBox,ReaderCropClaim,RecognitionInputObserver} from '../src/features/card-scanner/recognition/recognition-input-observer';

/** The crop hash is a client-validated worker assertion, not authenticated OCR,
 * identity, independent observation or permission to clear an unknown. */
export type ReaderCropStatus='match'|'mismatch'|'unsupported'|'unavailable'|'capacity'|'cancelled'|'timeout';
export interface ReaderCropComparison {
  readonly scope:'reader-canvas-snapshot-vs-worker-claim';readonly status:ReaderCropStatus;
  readonly modelExecutionVerified:false;readonly independentObservation:false;readonly completionEvidence:false;
  readonly source:ObservationSource|null;readonly sourceFrameId:number|null;readonly invocationId:number|null;
  readonly expectedSha256:string|null;readonly actualSha256:string|null;readonly reason:string|null;
}
interface Options {maxPending?:number;maxPendingBytes?:number;maxAttempts?:number;timeoutMs?:number;maxCaptureEvents?:number;
  hash?:(bytes:Uint8Array<ArrayBuffer>)=>Promise<string>}
const MAX_CROP_BYTES=1024*1024;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(value:unknown,min=0):value is number=>Number.isSafeInteger(value)&&(value as number)>=min;
function plain(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('object');
  const descriptors=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(descriptors).length!==keys.length||keys.some(key=>!Object.hasOwn(descriptors,key)||!Object.hasOwn(descriptors[key],'value')))
    throw Error('fields');
  return Object.fromEntries(keys.map(key=>[key,descriptors[key].value]));
}
function box(value:unknown,width:number,height:number):RecognitionBox {
  const raw=plain(value,['x','y','width','height']);
  const {x,y,width:w,height:h}=raw;
  if(!integer(x)||!integer(y)||!integer(w,1)||!integer(h,1)||x+w>width||y+h>height)throw Error('integer box');
  return Object.freeze({x,y,width:w,height:h});
}
function sameBox(a:RecognitionBox,b:RecognitionBox){return a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height;}

/** Diagnostic-only bounded helper. `observe` snapshots the actual supplied
 * Canvas synchronously before returning its promise. Asynchronous hashing does
 * not block the reader. A match attests only to the copied bytes at that time,
 * against the stated worker claim; it does not attest what an OCR model read.
 * This helper intentionally accepts no inventory or completion authority. */
export function createReaderCropBinding(sessionId:string,options:Options={}) {
  if(typeof sessionId!=='string'||!sessionId.length||sessionId.length>160)throw Error('Invalid reader diagnostic session');
  const {maxPending=4,maxPendingBytes=4*MAX_CROP_BYTES,maxAttempts=512,timeoutMs=5000,hash=pixelHash}=options;
  if(!integer(maxPending,1)||maxPending>40||!integer(maxPendingBytes,1)||maxPendingBytes>8*MAX_CROP_BYTES||
    !integer(maxAttempts,1)||maxAttempts>10_000||!integer(timeoutMs,1)||timeoutMs>30_000||typeof hash!=='function')throw Error('Invalid reader diagnostic limits');
  let pending=0,pendingBytes=0,attempts=0,closed=false;
  const seen=new Set<number>(),cancelPending=new Set<()=>void>();
  const result=(status:ReaderCropStatus,source:ObservationSource|null=null,sourceFrameId:number|null=null,invocationId:number|null=null,
    expectedSha256:string|null=null,actualSha256:string|null=null,reason:string|null=null):ReaderCropComparison=>Object.freeze({
      scope:'reader-canvas-snapshot-vs-worker-claim',status,modelExecutionVerified:false,independentObservation:false,
      completionEvidence:false,source,sourceFrameId,invocationId,expectedSha256,actualSha256,reason});
  const immediate=(value:ReaderCropComparison)=>Promise.resolve(value);
  function observe(meta:RecognitionInputMeta,claim:ReaderCropClaim|undefined,canvas:HTMLCanvasElement,signal:AbortSignal):Promise<ReaderCropComparison> {
    if(closed||signal.aborted)return immediate(result('cancelled'));
    if(!claim){
      try{
        const source=parseObservationFact({version:1,kind:'queued',attemptId:0,source:meta.source}).source;
        if(source.sessionId!==sessionId||source.slot!==meta.slot||!integer(meta.diagnosticReadId,1))throw Error('source');
        return immediate(result('unavailable',source,null,meta.diagnosticReadId,null,null,'claim-missing'));
      }catch{return immediate(result('unsupported',null,null,null,null,null,'invalid-source'));}
    }
    let source:ObservationSource,sourceFrameId:number,invocationId:number,expectedSha256:string,content:RecognitionBox;
    let frameWidth:number,frameHeight:number;
    try {
      const input=meta as RecognitionInputMeta;
      source=parseObservationFact({version:1,kind:'queued',attemptId:0,source:input.source}).source;
      invocationId=input.diagnosticReadId;
      if(!integer(invocationId,1)||source.sessionId!==sessionId||source.slot!==input.slot)throw Error('invocation/source');
      const root=plain(claim,['frame','crop']),frame=plain(root.frame,['version','kind','sourceFrameId','acquisitionFrameId','captureTime','width','height','hash']),
        crop=plain(root.crop,['slot','content','sha256']);
      if(frame.version!==1||frame.kind!=='measured'||!integer(frame.sourceFrameId,1)||!integer(frame.acquisitionFrameId,1)||!integer(frame.width,1)||!integer(frame.height,1)||
        !Number.isFinite(frame.captureTime)||!sha(frame.hash)||!integer(crop.slot)||!sha(crop.sha256))throw Error('frame/crop');
      sourceFrameId=frame.sourceFrameId;frameWidth=frame.width;frameHeight=frame.height;expectedSha256=crop.sha256;
      content=box(crop.content,frameWidth,frameHeight);
      if(source.frameId!==frame.acquisitionFrameId||source.captureTime!==frame.captureTime||source.slot!==crop.slot||
        input.sourceWidth!==frameWidth||input.sourceHeight!==frameHeight||!sameBox(box(input.sourceBox,frameWidth,frameHeight),content)||
        input.cropWidth!==content.width||input.cropHeight!==content.height)throw Error('source/frame/geometry mismatch');
    } catch {return immediate(result('unsupported',null,null,null,null,null,'invalid-or-unmatched-claim'));}
    const base=(status:ReaderCropStatus,actual:string|null=null,reason:string|null=null)=>
      result(status,source,sourceFrameId,invocationId,expectedSha256,actual,reason);
    if(seen.has(invocationId))return immediate(base('unsupported',null,'duplicate-invocation'));
    if(attempts>=maxAttempts)return immediate(base('capacity',null,'attempt-limit'));
    seen.add(invocationId);attempts++;
    const bytes=content.width*content.height*4;
    if(!Number.isSafeInteger(bytes)||bytes>MAX_CROP_BYTES)return immediate(base('unsupported',null,'crop-size'));
    if(pending>=maxPending||pendingBytes+bytes>maxPendingBytes)return immediate(base('capacity',null,'pending-limit'));
    let pixels:Uint8Array<ArrayBuffer>;
    try{
      if(canvas.width!==content.width||canvas.height!==content.height)return immediate(base('unsupported',null,'canvas-size'));
      const ctx=canvas.getContext('2d',{willReadFrequently:true});if(!ctx)return immediate(base('unavailable',null,'canvas-context'));
      const rgba=ctx.getImageData(0,0,content.width,content.height).data;
      if(!(rgba instanceof Uint8ClampedArray)||rgba.length!==bytes)return immediate(base('unavailable',null,'readback-size'));
      pixels=new Uint8Array(rgba);
      for(let i=3;i<bytes;i+=4)if(pixels[i]!==255)return immediate(base('unsupported',null,'nonopaque'));
    }catch{return immediate(base('unavailable',null,'canvas-readback'));}
    pending++;pendingBytes+=bytes;
    let complete=false,stopTimer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
    return new Promise(resolve=>{
      const finish=(value:ReaderCropComparison)=>{if(complete)return;complete=true;
        if(stopTimer!==undefined)clearTimeout(stopTimer);signal.removeEventListener('abort',abort);cancelPending.delete(cancel);resolve(value);};
      const cancel=()=>finish(base('cancelled',null,'closed'));
      cancelPending.add(cancel);
      abort=()=>finish(base('cancelled',null,'aborted'));signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted){abort();pending--;pendingBytes-=bytes;return;}
      stopTimer=setTimeout(()=>finish(base('timeout',null,'digest-timeout')),timeoutMs);
      // Reserve until the underlying digest actually settles, even when timeout
      // or cancellation returns first; outstanding buffers remain bounded.
      const release=()=>{pending--;pendingBytes-=bytes;};
      Promise.resolve().then(()=>hash(pixels)).then(actual=>{
        release();
        if(closed||signal.aborted)finish(base('cancelled',null,'closed-or-aborted'));
        else if(!sha(actual))finish(base('unavailable',null,'digest-format'));
        else finish(base(actual===expectedSha256?'match':'mismatch',actual));
      },()=>{release();finish(base('unavailable',null,'digest-error'));});
    });
  }
  return {observe,close(){closed=true;for(const cancel of cancelPending)cancel();},stats:()=>Object.freeze({attempts,pending,pendingBytes,closed})};
}

/** Compose with existing crop journals without modifying their stored shape.
 * Callbacks receive diagnostics only; neither can change scanner evidence. */
export function createReaderCropBindingObserver(sessionId:string|null,signal:AbortSignal,onResult:(result:ReaderCropComparison)=>void,
  options:Options={},other?:RecognitionInputObserver) {
  if(typeof onResult!=='function')throw Error('Reader diagnostic result callback required');
  const maxCaptureEvents=options.maxCaptureEvents??100_000;
  if(!integer(maxCaptureEvents,1)||maxCaptureEvents>100_000)throw Error('Invalid reader diagnostic capture limit');
  // Scanner owns the session ID. Dev callers can defer creating the binding
  // until the first real observer invocation supplies it.
  let binding=sessionId===null?undefined:createReaderCropBinding(sessionId,options),closed=false;
  let captures=0,delivered=0,callbackFailures=0,internalFailures=0,countersTruncated=false;
  const countFailure=(kind:'callback'|'internal')=>{
    if(kind==='callback'){if(callbackFailures<maxCaptureEvents)callbackFailures++;else countersTruncated=true;}
    else if(internalFailures<maxCaptureEvents)internalFailures++;else countersTruncated=true;
  };
  const stats=()=>{
    const core=binding?.stats()??{attempts:0,pending:0,pendingBytes:0,closed};
    return Object.freeze({...core,captures,delivered,failures:callbackFailures+internalFailures,callbackFailures,internalFailures,countersTruncated,
      // Accounting completeness says nothing about match or OCR correctness.
      accountingComplete:closed&&core.pending===0&&captures===delivered&&!callbackFailures&&!internalFailures&&!countersTruncated});
  };
  const observer:RecognitionInputObserver={begin(meta){
    const secondary=beginRecognitionInspection(other,meta);let captured=false;
    return {
      captureInput(canvas,claim){
        // Synchronous readback happens before control returns to the reader.
        if(!captured&&!closed){captured=true;
          if(captures>=maxCaptureEvents)countersTruncated=true;
          else {captures++;try{
            binding??=createReaderCropBinding(meta.source.sessionId,options);
            void binding.observe(meta,claim,canvas,signal).then(value=>{
              if(!closed)try{onResult(value);delivered++;}catch{countFailure('callback');}
            },()=>countFailure('internal'));
          }catch{countFailure('internal');/* Invalid diagnostics must not reject the reader. */}}
        }
        secondary?.captureInput?.(canvas,claim);
      },
      captureCard(canvas){secondary?.captureCard(canvas);},
      captureLabel(pixels,recipe){secondary?.captureLabel(pixels,recipe);},
      finish(outcome){secondary?.finish(outcome);},
    };
  }};
  return {observer,close(){closed=true;binding?.close();return stats();},stats};
}
