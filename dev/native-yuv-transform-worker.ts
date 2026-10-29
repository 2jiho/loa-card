import {convertNativeYuvToRgba,nativeYuvDescriptorJson,UnsupportedNativeYuvError} from './native-yuv-recipe';
import {describeNativeYuvTransformFrame} from './native-yuv-transform-metadata';
import type {NativeYuvTransformSourceFrame} from './native-yuv-transform-metadata';
import type {NativeYuvTransformMetadata,NativeYuvTransformErrorCode} from './native-yuv-transform';

export interface NativeYuvTransformFrame extends NativeYuvTransformSourceFrame {
 allocationSize(options:VideoFrameCopyToOptions):number;
 copyTo(pixels:Uint8Array<ArrayBuffer>,options:VideoFrameCopyToOptions):Promise<PlaneLayout[]>;
}
export interface NativeYuvTransformPlatform {
 isFrame(value:unknown):value is NativeYuvTransformFrame;
 hash(bytes:Uint8Array<ArrayBuffer>):Promise<string>;
}
export interface NativeYuvTransformScope {postMessage(value:unknown,transfer?:Transferable[]):void}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const defaultPlatform:NativeYuvTransformPlatform={
 isFrame:(value):value is NativeYuvTransformFrame=>typeof VideoFrame!=='undefined'&&value instanceof VideoFrame,
 hash:async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join(''),
};
class TransformFailure extends Error {readonly code:NativeYuvTransformErrorCode;constructor(code:NativeYuvTransformErrorCode,message:string){super(message);this.code=code;}}
function keys(value:Record<string,unknown>,expected:readonly string[]){if(Object.keys(value).some(key=>!expected.includes(key))||expected.some(key=>!Object.hasOwn(value,key)))throw new TransformFailure('protocol','Unexpected native transform request fields.');}

/** One owned native source at a time. copyTo and SHA must settle before close or
 * native scratch reuse. Client termination is the bounded escape for a hung
 * browser operation; cooperative disposal acknowledges only after ownership is
 * released. No incoming source or output queue is retained here. */
export function createNativeYuvTransformWorkerRuntime(scope:NativeYuvTransformScope,platform:NativeYuvTransformPlatform=defaultPlatform){
 type Job={id:number;frame:NativeYuvTransformFrame;abort:AbortController;work:Promise<void>};
 let active:Job|undefined,closing=false,lastId=0,packed:Uint8Array<ArrayBuffer>|undefined;
 const closed=new WeakSet<object>();let closeError:string|null=null;
 const post=(value:unknown,transfer?:Transferable[])=>{scope.postMessage(value,transfer);};
 const close=(frame:NativeYuvTransformFrame)=>{
  if(closed.has(frame))return true;closed.add(frame);
  try{frame.close();return true;}catch(error){closeError=String(error).slice(0,500);return false;}
 };
 const error=(id:number,code:NativeYuvTransformErrorCode,cause:unknown,frameClosed:boolean)=>{try{post({kind:'error',id,code,error:String(cause).slice(0,2000)||'Native transform failed.',frameClosed});}catch{/* The client still owns the Worker deadline/termination. */}};
 async function convert(job:Job){
  const check=()=>job.abort.signal.throwIfAborted();
  let response:{width:number;height:number;pixels:ArrayBuffer;metadata:NativeYuvTransformMetadata}|undefined;
  let failed=false,cause:unknown,frameClosed=false;
  try{
   check();const {native,plan}=describeNativeYuvTransformFrame(job.frame);
   const options:VideoFrameCopyToOptions={layout:plan.layout.map(plane=>({...plane}))};
   if(job.frame.allocationSize(options)!==plan.nativeByteLength)throw new TransformFailure('unsupported','Native packed allocationSize mismatch.');
   if(!packed||packed.byteLength!==plan.nativeByteLength)packed=new Uint8Array(plan.nativeByteLength);
   packed.fill(0);
   const planes=await job.frame.copyTo(packed,options);check();
   if(!Array.isArray(planes)||planes.length!==plan.layout.length||planes.some((plane,index)=>!plane||plane.offset!==plan.layout[index].offset||plane.stride!==plan.layout[index].stride))throw new TransformFailure('unsupported','Native copy returned another plane layout.');
   const nativeSha256=await platform.hash(packed);check();
   const {rgba}=convertNativeYuvToRgba(native,packed,planes);check();
   const generatedRgbaSha256=await platform.hash(rgba);check();
   const descriptorSha256=await platform.hash(new TextEncoder().encode(nativeYuvDescriptorJson(native,planes)));check();
   if(!sha(nativeSha256)||!sha(generatedRgbaSha256)||!sha(descriptorSha256))throw new TransformFailure('runtime','Invalid native transform hash receipt.');
   const metadata:NativeYuvTransformMetadata={version:1,recipeId:plan.recipe.id,native,planes:planes.map(plane=>({offset:plane.offset,stride:plane.stride})),
    nativeByteLength:plan.nativeByteLength,rgbaByteLength:plan.rgbaByteLength,nativeSha256,descriptorSha256,generatedRgbaSha256,frameClosed:true};
   response={width:plan.width,height:plan.height,pixels:rgba.buffer,metadata};
  }catch(error){failed=true;cause=error;}
  finally{frameClosed=close(job.frame);}
  if(!frameClosed){error(job.id,'cleanup',closeError??'Native source close failed.',false);return;}
  if(job.abort.signal.aborted){error(job.id,'cancelled','Native transform cancelled.',true);return;}
  if(failed){error(job.id,cause instanceof UnsupportedNativeYuvError?'unsupported':cause instanceof TransformFailure?cause.code:'runtime',cause,true);return;}
  try{post({kind:'frame',id:job.id,...response!},[response!.pixels]);}
  catch(cause){error(job.id,'runtime',cause,true);}
 }
 return {
  async handle(value:unknown){
   const frame=platform.isFrame(value)?value:object(value)&&platform.isFrame(value.frame)?value.frame:undefined;
   if(!object(value)||!positive(value.id)){
    if(frame)close(frame);return;
   }
   const id=value.id;
   if(value.kind==='dispose'){
    try{keys(value,['kind','id']);if(id<=lastId)throw new TransformFailure('protocol','Non-monotonic native transform disposal.');lastId=id;}
    catch(cause){if(frame)close(frame);error(id,'protocol',cause,!!frame&&closed.has(frame));return;}
    closing=true;active?.abort.abort(new DOMException('Native transform disposed.','AbortError'));
    await active?.work;packed=undefined;
    try{post({kind:'disposed',id,error:closeError});}catch{/* Parent termination remains authoritative. */}return;
   }
   try{
    keys(value,['kind','id','frame']);
    if(value.kind!=='convert'||!frame||closed.has(frame)||id<=lastId)throw new TransformFailure('protocol','Invalid owned native transform source.');
    lastId=id;if(closing||active)throw new TransformFailure('protocol',closing?'Native transform is disposed.':'A native transform is already active.');
   }catch(cause){const frameClosed=frame?close(frame):false;error(id,'protocol',cause,frameClosed);return;}
   const job:Job={id,frame,abort:new AbortController(),work:Promise.resolve()};active=job;job.work=convert(job);
   try{await job.work;}finally{if(active===job)active=undefined;}
  },
 };
}

if(typeof document==='undefined'&&typeof self!=='undefined'){
 const scope=self as unknown as NativeYuvTransformScope&{onmessage:((event:MessageEvent)=>void)|null};
 const runtime=createNativeYuvTransformWorkerRuntime(scope);scope.onmessage=event=>{void runtime.handle(event.data);};
}
