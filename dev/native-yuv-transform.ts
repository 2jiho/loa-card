import {MAX_FRAME_BYTES} from '../src/features/card-scanner/exact-recording-codec';
import {nativeYuvDescriptorJson,UnsupportedNativeYuvError} from './native-yuv-recipe';
import type {NativeYuvPlaneLayout} from './native-yuv-recipe';
import {describeNativeYuvTransformFrame} from './native-yuv-transform-metadata';
import type {NativeYuvTransformNative,NativeYuvTransformSourceFrame} from './native-yuv-transform-metadata';
export {describeNativeYuvTransformFrame} from './native-yuv-transform-metadata';
export type {NativeYuvTransformNative,NativeYuvTransformSourceFrame} from './native-yuv-transform-metadata';

export interface NativeYuvTransformMetadata {
 readonly version:1;
 readonly recipeId:string;
 readonly native:NativeYuvTransformNative;
 readonly planes:readonly NativeYuvPlaneLayout[];
 readonly nativeByteLength:number;
 readonly rgbaByteLength:number;
 readonly nativeSha256:string;
 readonly descriptorSha256:string;
 readonly generatedRgbaSha256:string;
 readonly frameClosed:true;
}
export interface NativeYuvTransformResult {
 readonly width:number;
 readonly height:number;
 /** Exclusively caller-owned after resolution; not a pooled/borrowed view. */
 readonly pixels:Uint8Array<ArrayBuffer>;
 readonly metadata:NativeYuvTransformMetadata;
}
export type NativeYuvTransformWorker=Pick<Worker,'postMessage'|'terminate'|'onmessage'|'onerror'|'onmessageerror'>;
export interface NativeYuvTransformCleanup {
 readonly acknowledged:boolean;readonly forced:boolean;readonly workerTerminated:boolean;readonly error:string|null;
}
export interface NativeYuvTransformOptions {
 workerFactory?:()=>NativeYuvTransformWorker;
 timeoutMs?:number;
 disposeTimeoutMs?:number;
}
export type NativeYuvTransformErrorCode='unsupported'|'protocol'|'runtime'|'timeout'|'cleanup'|'cancelled';
export class NativeYuvTransformError extends Error {
 readonly code:NativeYuvTransformErrorCode;
 cleanup:NativeYuvTransformCleanup|null=null;
 constructor(code:NativeYuvTransformErrorCode,message:string){super(message);this.name='NativeYuvTransformError';this.code=code;}
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function exact(value:Record<string,unknown>,keys:readonly string[]){if(Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw new NativeYuvTransformError('protocol','Unexpected native YUV response fields.');}
const digest=async(bytes:Uint8Array<ArrayBuffer>)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');

function responseMetadata(value:unknown,expected:ReturnType<typeof describeNativeYuvTransformFrame>):NativeYuvTransformMetadata{
 if(!object(value))throw new NativeYuvTransformError('protocol','Missing native YUV transform receipt.');
 exact(value,['version','recipeId','native','planes','nativeByteLength','rgbaByteLength','nativeSha256','descriptorSha256','generatedRgbaSha256','frameClosed']);
 const {plan}=expected;
 if(value.version!==1||value.recipeId!==plan.recipe.id||value.nativeByteLength!==plan.nativeByteLength||value.rgbaByteLength!==plan.rgbaByteLength||
  value.frameClosed!==true||!sha(value.nativeSha256)||!sha(value.descriptorSha256)||!sha(value.generatedRgbaSha256)||!object(value.native))throw new NativeYuvTransformError('protocol','Invalid native YUV transform receipt.');
 const native=value.native;
 exact(native,['format','codedWidth','codedHeight','displayWidth','displayHeight','visibleRect','rotation','flip','colorSpace','timestampMicroseconds','durationMicroseconds']);
 if(!object(native.visibleRect)||!object(native.colorSpace))throw new NativeYuvTransformError('protocol','Missing native geometry or color metadata.');
 exact(native.visibleRect,['x','y','width','height']);exact(native.colorSpace,['primaries','transfer','matrix','fullRange']);
 // Normalize property order while comparing all source values, not just size.
 const actual={format:native.format,codedWidth:native.codedWidth,codedHeight:native.codedHeight,displayWidth:native.displayWidth,displayHeight:native.displayHeight,
  visibleRect:{x:native.visibleRect.x,y:native.visibleRect.y,width:native.visibleRect.width,height:native.visibleRect.height},rotation:native.rotation,flip:native.flip,
  colorSpace:{primaries:native.colorSpace.primaries,transfer:native.colorSpace.transfer,matrix:native.colorSpace.matrix,fullRange:native.colorSpace.fullRange},
  timestampMicroseconds:native.timestampMicroseconds,durationMicroseconds:native.durationMicroseconds};
 if(JSON.stringify(actual)!==JSON.stringify(expected.native)||!Array.isArray(value.planes)||value.planes.length!==plan.layout.length)throw new NativeYuvTransformError('protocol','Native transform source/planes do not match this request.');
 const planes=value.planes.map((plane,index)=>{
  if(!object(plane))throw new NativeYuvTransformError('protocol','Invalid native transform plane.');exact(plane,['offset','stride']);
  if(plane.offset!==plan.layout[index].offset||plane.stride!==plan.layout[index].stride)throw new NativeYuvTransformError('protocol','Native transform layout mismatch.');
  return Object.freeze({offset:plane.offset as number,stride:plane.stride as number});
 });
 return Object.freeze({version:1,recipeId:plan.recipe.id,native:expected.native,planes:Object.freeze(planes),nativeByteLength:plan.nativeByteLength,rgbaByteLength:plan.rgbaByteLength,
  nativeSha256:value.nativeSha256,descriptorSha256:value.descriptorSha256,generatedRgbaSha256:value.generatedRgbaSha256,frameClosed:true});
}
function milliseconds(value:number|undefined,fallback:number,cap:number){const result=value??fallback;if(!positive(result)||result>cap)throw new RangeError('Invalid native YUV transform deadline.');return result;}

/** Development-only one-frame transform. transform() consumes its VideoFrame on
 * EVERY path, including pre-abort, busy rejection and postMessage failure. Pass
 * a clone when the caller must retain a borrowed captured source. The returned
 * RGBA is owned by the caller; retaining a sequence is outside this client's
 * in-flight bound. No Canvas, inventory, recording or fallback is performed.
 * generatedRgbaSha256 is a worker pre-paint receipt; the receiving acquisition
 * and recording must independently verify their actual raster if it is painted.
 */
export function createNativeYuvTransform(options:NativeYuvTransformOptions={}){
 const timeout=milliseconds(options.timeoutMs,5000,30_000),disposeTimeout=milliseconds(options.disposeTimeoutMs,500,2000);
 let worker:NativeYuvTransformWorker|undefined,sequence=0,settled=0,busy=false,closing=false,closed=false;
 let cleanup:NativeYuvTransformCleanup|null=null,shutdownPromise:Promise<void>|undefined;
 type Pending={id:number;expected:ReturnType<typeof describeNativeYuvTransformFrame>;resolve:(value:NativeYuvTransformResult)=>void;reject:(error:unknown)=>void;
  timer:ReturnType<typeof setTimeout>;signal:AbortSignal;abort:()=>void;transferred:boolean;frame:VideoFrame;validating:boolean};
 let pending:Pending|undefined,disposal:{id:number;resolve:()=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 const locallyClosed=new WeakSet<object>();
 const closeLocal=(frame:VideoFrame)=>{if(!frame||typeof frame!=='object'||locallyClosed.has(frame))return;locallyClosed.add(frame);try{frame.close();}catch{/* The error/termination path remains explicit. */}};
 function releaseUnexpectedFrame(reply:unknown){
  if(typeof VideoFrame==='undefined'||!reply||typeof reply!=='object')return;
  const frame=(reply as {frame?:unknown}).frame;if(frame instanceof VideoFrame)try{frame.close();}catch{/* No such resource is allowed in a normal reply. */}
 }
 const shutdown=()=>shutdownPromise??=(async()=>{
  closing=true;
  let acknowledged=false,forced=false,error:string|null=null;
  if(worker){
   try{await new Promise<void>(resolve=>{
    const id=++sequence,timer=setTimeout(()=>{forced=true;error='Native transform disposal acknowledgement timed out.';resolve();},disposeTimeout);
    disposal={id,resolve,timer};
    try{worker!.postMessage({kind:'dispose',id});}catch(cause){clearTimeout(timer);forced=true;error=String(cause).slice(0,500);resolve();}
   });
   acknowledged=disposal?.id===settled;
   if(disposal)clearTimeout(disposal.timer);
   if(disposalError){error=disposalError;disposalError=null;}
   }finally{
    disposal=undefined;worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;
    worker.terminate();cleanup=Object.freeze({acknowledged,forced,workerTerminated:true,error});worker=undefined;
   }
  }else cleanup=Object.freeze({acknowledged:false,forced:false,workerTerminated:false,error:null});
  closed=true;
 })();
 let disposalError:string|null=null;
 const fail=(cause:unknown)=>{
  const job=pending;pending=undefined;
  if(job){clearTimeout(job.timer);job.signal.removeEventListener('abort',job.abort);if(!job.transferred)closeLocal(job.frame);}
  const error=cause instanceof NativeYuvTransformError?cause:new NativeYuvTransformError('runtime',String(cause).slice(0,2000));
  void shutdown().then(()=>{error.cleanup=cleanup;job?.reject(error);},cleanupFailure=>{error.cleanup=cleanup;job?.reject(new NativeYuvTransformError('cleanup',String(cleanupFailure)));});
 };
 function ensureWorker(){
  if(worker)return;
  worker=options.workerFactory?options.workerFactory():(()=>{if(typeof Worker==='undefined')throw new NativeYuvTransformError('unsupported','Native transform Worker unavailable.');return new Worker(new URL('./native-yuv-transform-worker.ts',import.meta.url),{type:'module'});})();
  worker.onmessage=event=>{
   const reply=event.data;releaseUnexpectedFrame(reply);
   if(closing){
    if(disposal&&object(reply)&&reply.kind==='disposed'&&reply.id===disposal.id){
     try{exact(reply,['kind','id','error']);if(reply.error!==null&&(typeof reply.error!=='string'||reply.error.length>2000))throw Error('Invalid disposal receipt.');
      disposalError=reply.error as string|null;settled=reply.id as number;clearTimeout(disposal.timer);disposal.resolve();}
     catch(error){disposalError=String(error).slice(0,500);clearTimeout(disposal.timer);disposal.resolve();}
    }
    return;
   }
   const job=pending;if(!job)return;
   if(object(reply)&&positive(reply.id)&&reply.id<=settled)return;
   if(job.validating){fail(new NativeYuvTransformError('protocol','Duplicate native transform response.'));return;}
   job.validating=true;
   void(async()=>{try{
    if(!object(reply)||reply.id!==job.id)throw new NativeYuvTransformError('protocol','Native transform response order mismatch.');
    if(reply.kind==='error'){
     exact(reply,['kind','id','code','error','frameClosed']);
     if(!['unsupported','protocol','runtime','cleanup','cancelled'].includes(String(reply.code))||typeof reply.error!=='string'||!reply.error.length||reply.error.length>2000||typeof reply.frameClosed!=='boolean')throw new NativeYuvTransformError('protocol','Invalid native transform error.');
     throw new NativeYuvTransformError(reply.code as NativeYuvTransformErrorCode,reply.error);
    }
    exact(reply,['kind','id','width','height','pixels','metadata']);
    if(reply.kind!=='frame'||reply.width!==job.expected.plan.width||reply.height!==job.expected.plan.height||
     !(reply.pixels instanceof ArrayBuffer)||(reply.pixels as ArrayBuffer&{resizable?:boolean}).resizable===true||reply.pixels.byteLength!==job.expected.plan.rgbaByteLength||reply.pixels.byteLength>MAX_FRAME_BYTES)throw new NativeYuvTransformError('protocol','Invalid native transform pixel buffer.');
    const metadata=responseMetadata(reply.metadata,job.expected);
    const descriptorHash=await digest(new TextEncoder().encode(nativeYuvDescriptorJson(job.expected.native,job.expected.plan.layout)));
    if(closing||pending!==job)return;
    if(descriptorHash!==metadata.descriptorSha256)throw new NativeYuvTransformError('protocol','Native transform descriptor hash mismatch.');
    job.signal.throwIfAborted();pending=undefined;settled=job.id;clearTimeout(job.timer);job.signal.removeEventListener('abort',job.abort);
    job.resolve(Object.freeze({width:job.expected.plan.width,height:job.expected.plan.height,pixels:new Uint8Array(reply.pixels),metadata}));
   }catch(error){if(!closing&&pending===job)fail(error);}})();
  };
  worker.onerror=event=>{if(closing){disposalError=String(event.message||'Native transform Worker failed during disposal.').slice(0,500);disposal?.resolve();}else fail(new NativeYuvTransformError('runtime',event.message||'Native transform Worker failed.'));};
  worker.onmessageerror=()=>{if(closing){disposalError='Unreadable native transform disposal message.';disposal?.resolve();}else fail(new NativeYuvTransformError('protocol','Unreadable native transform Worker response.'));};
 }
 return {
  get cleanup(){return cleanup;},
  async transform(frame:VideoFrame,signal:AbortSignal):Promise<NativeYuvTransformResult>{
   if(busy||closing||closed){closeLocal(frame);throw new NativeYuvTransformError('protocol',busy?'A native transform is already active.':'Native transform client is disposed.');}
   busy=true;
   try{
    if(signal.aborted){closeLocal(frame);throw new NativeYuvTransformError('cancelled','Native transform was aborted before transfer.');}
    let expected:ReturnType<typeof describeNativeYuvTransformFrame>;
    try{expected=describeNativeYuvTransformFrame(frame as unknown as NativeYuvTransformSourceFrame);ensureWorker();signal.throwIfAborted();}
    catch(error){closeLocal(frame);if(worker)await shutdown();throw error instanceof NativeYuvTransformError?error:new NativeYuvTransformError(error instanceof UnsupportedNativeYuvError?'unsupported':'runtime',String(error).slice(0,2000));}
    return await new Promise<NativeYuvTransformResult>((resolve,reject)=>{
     const id=++sequence,abort=()=>fail(new NativeYuvTransformError('cancelled','Native transform cancelled.'));
     const timer=setTimeout(()=>fail(new NativeYuvTransformError('timeout','Native transform frame deadline exceeded.')),timeout);
     const job:Pending={id,expected,resolve,reject,timer,signal,abort,transferred:false,frame,validating:false};pending=job;
     signal.addEventListener('abort',abort,{once:true});
     try{signal.throwIfAborted();worker!.postMessage({kind:'convert',id,frame},[frame]);job.transferred=true;}
     catch(error){fail(error);}
    });
   }finally{busy=false;}
  },
  async dispose(){
   if(pending)fail(new NativeYuvTransformError('cancelled','Native transform client disposed.'));
   await shutdown();
  },
 };
}
