import type {RecognitionInputMeta,ReaderCropClaim} from '../recognition/recognition-input-observer';
import type {ObservationSource} from '../session/observation-execution';
import {parseObservationFact} from '../session/observation-execution';
import {parseMeasuredSourceRasterReceipt} from './source-raster-receipt';
import {pixelHash} from '../reproduction/recording-frame-integrity';

/** Development-only comparison of one reader invocation against a supplied
 * crop claim. Neither the claim nor the callback is authenticated here. This
 * is not a new independent observation or authority to resolve/complete a scan.
 * The reader must be a trusted wrapper around the intended recognizer, with its
 * own real budget. Neither its claim nor its model input is authenticated here. */
export type PrivateCropReadStatus='identified'|'unknown'|'review'|'unavailable'|'mismatch'|'capacity'|'cancelled'|'timeout'|'error';
export type PrivateCropReadResult<T>={readonly status:PrivateCropReadStatus;readonly identity:T|null;
  readonly scope:'private-canvas-single-reader-call';readonly claimAuthenticated:false;
  readonly modelExecutionVerified:false;readonly completionEvidence:false;readonly independentObservation:false;
  readonly source:ObservationSource|null;readonly expectedSha256:string|null;readonly reason:string|null};
type Identity={readonly id:string;readonly name:string;readonly review:readonly string[]};
type Reader<T extends Identity>=(canvas:HTMLCanvasElement,signal:AbortSignal)=>Promise<T|null>;
type Options={maxCropBytes?:number;maxWorkBytes?:number;timeoutMs?:number;
  canvasFactory?:()=>HTMLCanvasElement;hash?:(bytes:Uint8Array<ArrayBuffer>)=>Promise<string>;now?:()=>number};
const CAP=1024*1024;
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0;
function data(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('plain object required');
  const d=Object.getOwnPropertyDescriptors(value);
  if(Reflect.ownKeys(d).length!==keys.length||keys.some(key=>!Object.hasOwn(d,key)||!Object.hasOwn(d[key],'value')))throw Error('own data properties required');
  return Object.fromEntries(keys.map(key=>[key,d[key].value]));
}
function field(value:object,key:string):unknown {const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))throw Error('metadata field');return d.value;}
function detached(value:unknown,depth=0,budget={nodes:0}):unknown {
  if(++budget.nodes>4096||depth>16)throw Error('identity size');
  if(value===null||typeof value==='boolean'||typeof value==='string'&&value.length<=65536||typeof value==='number'&&Number.isFinite(value)||value===undefined)return value;
  if(!value||typeof value!=='object')throw Error('identity data');
  if(Array.isArray(value)){
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>512||Reflect.ownKeys(value).length!==value.length+1)throw Error('identity array');
    return Object.freeze(Array.from({length:value.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))throw Error('identity array field');return detached(d.value,depth+1,budget);}));
  }
  if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('identity prototype');
  const out:Record<string,unknown>=Object.create(null);
  for(const key of Reflect.ownKeys(value)){
    if(typeof key!=='string'||key==='__proto__'||key==='constructor'||key==='prototype')throw Error('identity key');
    const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value')||!d.enumerable)throw Error('identity accessor');
    out[key]=detached(d.value,depth+1,budget);
  }
  return Object.freeze(out);
}
function evidence(meta:RecognitionInputMeta,claim:ReaderCropClaim,maxBytes:number){
  if(!meta||typeof meta!=='object')throw Error('metadata');
  const src=data(field(meta,'source'),['sessionId','frameId','observationId','captureOrder','captureTime','phase','slot']);
  const source=parseObservationFact({version:1,kind:'queued',attemptId:0,source:src}).source;
  const root=data(claim,['frame','crop']);
  const frame=parseMeasuredSourceRasterReceipt(data(root.frame,['version','kind','sourceFrameId','captureTime','acquisitionFrameId','width','height','hash']));
  const crop=data(root.crop,['slot','content','sha256']),box=data(crop.content,['x','y','width','height']);
  const metadataBox=data(field(meta,'sourceBox'),['x','y','width','height']);
  const {x,y,width,height}=box;
  if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||(x as number)<0||(y as number)<0||!positive(width)||!positive(height)||
    (x as number)+width>frame.width||(y as number)+height>frame.height||!digest(crop.sha256)||
    source.frameId!==frame.acquisitionFrameId||source.captureTime!==frame.captureTime||source.slot!==crop.slot||
    field(meta,'slot')!==source.slot||field(meta,'sourceWidth')!==frame.width||field(meta,'sourceHeight')!==frame.height||
    field(meta,'cropWidth')!==width||field(meta,'cropHeight')!==height||
    ['x','y','width','height'].some(k=>metadataBox[k]!==box[k])||width*height*4>maxBytes)throw Error('claim/source/geometry mismatch');
  return {source,width,height,sha256:crop.sha256};
}
/** One owner accepts at most one job. A cancelled/expired job retains its
 * credit and private canvas until the reader actually settles, preventing an
 * unresponsive reader from accumulating buffers or reading a freed canvas. */
export function createVerifiedCropReader(options:Options={}) {
 const maxCropBytes=options.maxCropBytes??CAP,maxWorkBytes=options.maxWorkBytes??4*CAP,timeoutMs=options.timeoutMs??3000;
 const make=options.canvasFactory??(()=>document.createElement('canvas')),hash=options.hash??pixelHash,now=options.now??(()=>performance.now());
 if(!positive(maxCropBytes)||maxCropBytes>CAP||!positive(maxWorkBytes)||maxWorkBytes>4*CAP||
   !positive(timeoutMs)||timeoutMs>30000||typeof make!=='function'||typeof hash!=='function'||typeof now!=='function')throw Error('Invalid private crop reader options');
 let busy=false,closed=false,reserved=0,cancelActive:(()=>void)|undefined;
 const result=<T>(status:PrivateCropReadStatus,source:ObservationSource|null=null,sha256:string|null=null,identity:T|null=null,reason:string|null=null):PrivateCropReadResult<T>=>Object.freeze({status,identity,scope:'private-canvas-single-reader-call',claimAuthenticated:false,modelExecutionVerified:false,completionEvidence:false,independentObservation:false,source,expectedSha256:sha256,reason});
 function read<T extends Identity>(meta:RecognitionInputMeta,claim:ReaderCropClaim,canvas:HTMLCanvasElement,reader:Reader<T>,signal:AbortSignal):Promise<PrivateCropReadResult<T>> {
  if(closed||signal.aborted)return Promise.resolve(result('cancelled'));
  if(busy)return Promise.resolve(result<T>('capacity',null,null,null,'another job is active'));
  busy=true;let source:ObservationSource|null=null,expected:string|null=null,pixels:Uint8Array<ArrayBuffer>,width=0,height=0,bytes=0;
  const started=now(),deadline=started+timeoutMs;
  try {
   if(!Number.isFinite(started)||typeof reader!=='function')throw Error('invalid clock or reader');
   const verified=evidence(meta,claim,maxCropBytes);source=verified.source;expected=verified.sha256;width=verified.width;height=verified.height;bytes=width*height*4;
   if(bytes*4>maxWorkBytes)throw Error('work budget');
   if(canvas.width!==width||canvas.height!==height)throw Error('canvas size');
   const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('canvas context');
   const rgba=context.getImageData(0,0,width,height).data;
   if(!(rgba instanceof Uint8ClampedArray)||rgba.length!==bytes)throw Error('canvas readback');
   pixels=new Uint8Array(rgba);for(let i=3;i<bytes;i+=4)if(pixels[i]!==255)throw Error('nonopaque crop');
   reserved=bytes*4;
  }catch(error){busy=false;return Promise.resolve(result<T>('unavailable',source,expected,null,String(error).slice(0,200)));}
  const fixedSource=source!,fixedExpected=expected!,privateSignal=new AbortController();
  let done=false,privateCanvas:HTMLCanvasElement|undefined,timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
  return new Promise(resolve=>{
   const finish=(value:PrivateCropReadResult<T>)=>{if(done)return;done=true;if(timer!==undefined)clearTimeout(timer);signal.removeEventListener('abort',abort);resolve(value);};
   const stop=(status:'cancelled'|'timeout')=>{privateSignal.abort(new DOMException(status,status==='timeout'?'TimeoutError':'AbortError'));finish(result(status,fixedSource,fixedExpected));};
   abort=()=>stop('cancelled');cancelActive=()=>stop('cancelled');signal.addEventListener('abort',abort,{once:true});
   if(signal.aborted)abort();else timer=setTimeout(()=>stop('timeout'),Math.max(0,deadline-now()));
   const check=()=>{if(privateSignal.signal.aborted||closed)throw Error('operation cancelled');if(now()>=deadline){stop('timeout');throw Error('operation timed out');}};
   void (async()=>{
    try {
     check();const hashInput=pixels.slice();const actual=await hash(hashInput);check();
     for(let i=0;i<bytes;i++)if(hashInput[i]!==pixels[i])throw Error('hash input mutated');
     if(actual!==fixedExpected){finish(result('mismatch',fixedSource,fixedExpected));return;}
     privateCanvas=make();if(privateCanvas===canvas){privateCanvas=undefined;throw Error('private canvas must be fresh');}privateCanvas.width=width;privateCanvas.height=height;
     const context=privateCanvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('private canvas context');
     context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer),width,height),0,0);
     const restored=context.getImageData(0,0,width,height).data;
     if(!(restored instanceof Uint8ClampedArray)||restored.length!==bytes)throw Error('private canvas readback');
     for(let i=0;i<bytes;i++)if(restored[i]!==pixels[i])throw Error('private canvas differs');
     check();const value=await reader(privateCanvas,privateSignal.signal);check();
     if(value===null){finish(result('unknown',fixedSource,fixedExpected));return;}
     const copy=detached(value) as T;
     if(!copy||typeof copy.id!=='string'||!copy.id.length||copy.id.length>160||typeof copy.name!=='string'||!copy.name.length||copy.name.length>1024||
       !Array.isArray(copy.review)||copy.review.length>16||copy.review.some(entry=>typeof entry!=='string'||entry.length>256))throw Error('invalid reader identity');
     finish(result(copy.review.length?'review':'identified',fixedSource,fixedExpected,copy));
    }catch(error){if(!done)finish(result<T>('error',fixedSource,fixedExpected,null,String(error).slice(0,200)));}
    finally{try{if(privateCanvas){privateCanvas.width=0;privateCanvas.height=0;}}catch{/* Best effort cleanup of the private canvas. */}busy=false;reserved=0;cancelActive=undefined;}
   })();
  });
 }
 return {read,close(){closed=true;cancelActive?.();},stats:()=>Object.freeze({busy,closed,reservedBytes:reserved})};
}
