import {ALL_FORMATS,BlobSource,CanvasSink,Input,VideoSampleSink} from 'mediabunny';
import type {InputVideoTrack} from 'mediabunny';
import type {ScannerInputFrame} from '../src/features/card-scanner/scanner-input-frame';
import {MAX_FRAME_BYTES} from '../src/features/card-scanner/exact-recording-codec';
import {yieldForCapture} from '../src/features/card-scanner/input-source';
import {createNativeYuvTransform} from './native-yuv-transform';
import type {NativeYuvTransformMetadata,NativeYuvTransformResult} from './native-yuv-transform';
import {planNativeYuvFrame} from './native-yuv-recipe';

export type ComparisonFrameMode='canvas-control'|'native-yuv';
export interface ComparisonFramesLimits {maxFrames:number;metadataBytes:number;operationTimeoutMs:number;cleanupTimeoutMs:number}
export const COMPARISON_FRAME_LIMITS:Readonly<ComparisonFramesLimits&{sourceBytes:number;frameBytes:number}>=Object.freeze({sourceBytes:256*1024*1024,frameBytes:MAX_FRAME_BYTES,
 maxFrames:10_000,metadataBytes:8*1024*1024,operationTimeoutMs:30_000,cleanupTimeoutMs:5_000});
type Canvas=HTMLCanvasElement|OffscreenCanvas;
type Context=CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D;
export interface ComparisonTrack {id:number;canDecode():Promise<boolean>;computeDuration():Promise<number>}
export interface ComparisonInput {getPrimaryVideoTrack():Promise<ComparisonTrack|null>;dispose():void}
export interface ComparisonNativeSample {
 timestamp:number;duration:number;rotation:number;flip:boolean;pixelAspectRatio:{num:number;den:number};
 toVideoFrame():VideoFrame;close():void;
}
export interface ComparisonCanvasSample {canvas:Canvas;timestamp:number;duration:number}
export interface ComparisonTransformer {
 transform(frame:VideoFrame,signal:AbortSignal):Promise<NativeYuvTransformResult>;
 dispose():Promise<void>;
 readonly cleanup?:unknown;
}
export interface ComparisonFramesPlatform {
 createInput(blob:Blob):ComparisonInput;
 canvasSamples(track:ComparisonTrack):AsyncIterator<ComparisonCanvasSample>;
 nativeSamples(track:ComparisonTrack):AsyncIterator<ComparisonNativeSample>;
 createTransformer():ComparisonTransformer;
 createCanvas():Canvas;
 imageData(data:Uint8ClampedArray<ArrayBuffer>,width:number,height:number):ImageData;
 hash(data:Uint8Array<ArrayBuffer>):Promise<string>;
 yieldTask(signal:AbortSignal):Promise<void>;
 now():number;
 /** Tests may tighten these bounds, never relax them. */
 limits?:Partial<ComparisonFramesLimits>;
}
export interface ComparisonInputUse {frame:number;sourceFrameId:number;time:number;phase:'input'}
export interface ComparisonFrameReceipt {
 ordinal:number;trackId:number;pts:number;duration:number;width:number;height:number;
 recipeId:string|null;nativeSha256:string|null;descriptorSha256:string|null;generatedRgbaSha256:string|null;
 postPaintRgbaSha256:string;native:NativeYuvTransformMetadata|null;
 processingUse:ComparisonInputUse|null;
}
const defaults:ComparisonFramesPlatform={
 createInput:blob=>new Input({formats:ALL_FORMATS,source:new BlobSource(blob)}),
 canvasSamples:track=>new CanvasSink(track as InputVideoTrack,{poolSize:2}).canvases(),
 nativeSamples:track=>new VideoSampleSink(track as InputVideoTrack,{hardwareAcceleration:'no-preference'}).samples(),
 createTransformer:createNativeYuvTransform,
 createCanvas:()=>document.createElement('canvas'),
 imageData:(data,width,height)=>new ImageData(data,width,height),
 hash:async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),byte=>byte.toString(16).padStart(2,'0')).join(''),
 yieldTask:yieldForCapture,now:()=>performance.now(),
};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const time=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const message=(error:unknown)=>String(error).slice(0,1500);
function pixelBytes(width:number,height:number){
 const size=width*height*4;if(!positive(width)||!positive(height)||!Number.isSafeInteger(size)||size>MAX_FRAME_BYTES)throw Error('Comparison frame size is unsupported.');return size;
}
function context(canvas:Canvas):Context {
 const value=canvas.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'}) as Context|null;
 if(!value)throw Error('Comparison input canvas is unavailable.');return value;
}
function nativeMetadata(value:NativeYuvTransformMetadata):NativeYuvTransformMetadata {
 const n=value.native,r=n.visibleRect,c=n.colorSpace;
 const native={format:n.format,codedWidth:n.codedWidth,codedHeight:n.codedHeight,displayWidth:n.displayWidth,displayHeight:n.displayHeight,
  visibleRect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,rotation:n.rotation,flip:n.flip,
  colorSpace:{primaries:c.primaries,transfer:c.transfer,matrix:c.matrix,fullRange:c.fullRange},
  timestampMicroseconds:n.timestampMicroseconds,durationMicroseconds:n.durationMicroseconds};
 const plan=planNativeYuvFrame(native);
 if(value.version!==1||value.frameClosed!==true||value.recipeId!==plan.recipe.id||value.nativeByteLength!==plan.nativeByteLength||value.rgbaByteLength!==plan.rgbaByteLength||
  !sha(value.nativeSha256)||!sha(value.descriptorSha256)||!sha(value.generatedRgbaSha256)||!Array.isArray(value.planes)||
  value.planes.length!==plan.layout.length||value.planes.some((p,i)=>p.offset!==plan.layout[i].offset||p.stride!==plan.layout[i].stride))throw Error('Invalid native comparison receipt.');
 return {version:1,recipeId:value.recipeId,native,planes:value.planes.map(p=>({offset:p.offset,stride:p.stride})),nativeByteLength:value.nativeByteLength,
  rgbaByteLength:value.rgbaByteLength,nativeSha256:value.nativeSha256,descriptorSha256:value.descriptorSha256,
  generatedRgbaSha256:value.generatedRgbaSha256,frameClosed:true};
}

/** Lazy, one-use serial field comparison. Decoder ordinals are never fabricated
 * as archive provenance. The current borrowed canvas is valid only until the
 * consumer advances; callers link the actual scanner 'frame' trace before that. */
export function createComparisonFrames(blob:Blob,mode:ComparisonFrameMode,signal:AbortSignal,platform:ComparisonFramesPlatform=defaults){
 if(!(blob instanceof Blob)||!blob.size||blob.size>COMPARISON_FRAME_LIMITS.sourceBytes||!['canvas-control','native-yuv'].includes(mode))throw Error('Invalid comparison input.');
 const limits={...COMPARISON_FRAME_LIMITS,...platform.limits};
 for(const key of ['maxFrames','metadataBytes','operationTimeoutMs','cleanupTimeoutMs'] as const)
  if(!positive(limits[key])||limits[key]>COMPARISON_FRAME_LIMITS[key])throw Error('Invalid comparison limits.');
 const life=new AbortController(),receipts:ComparisonFrameReceipt[]=[],reserved=new WeakMap<ComparisonFrameReceipt,number>();
 const cleanup={inputDisposed:false,iteratorReturned:null as boolean|null,transformerDisposed:null as boolean|null,canvasCleared:false,sourceReferenceReleased:false,
  transformer:null as unknown,errors:[] as string[],pendingOperations:0};
 const state={started:false,finished:false,streamCompleted:false,produced:0,consumed:0,unconsumed:0,linkErrors:0,recoveryUseEvents:0,decodedSamples:0,nativeSamplesClosed:0,
  retainedMetadataBytes:0,reservedMetadataBytes:0,maxReadbackBytes:0,maxApplicationPixelArrayBytes:0,transformMs:0,readbackMs:0,postPaintHashMs:0,error:null as string|null};
 let sourceBlob:Blob|undefined=blob,input:ComparisonInput|undefined,iterator:AsyncIterator<ComparisonCanvasSample|ComparisonNativeSample>|undefined,transformer:ComparisonTransformer|undefined;
 let ownedCanvasesCreated=0;
 let ownCanvas:Canvas|undefined,current:ComparisonFrameReceipt|undefined,inputStopped=false,cleanupWork:Promise<void>|undefined,disposeWork:Promise<void>|undefined,lastUseFrame=0,lastUseSourceFrame=0;
 const operations=new Set<Promise<unknown>>();
 const error=(value:unknown)=>{const text=message(value);state.error??=text;return value;};
 const stopInput=()=>{if(input&&!inputStopped){inputStopped=true;try{input.dispose();cleanup.inputDisposed=true;}catch(cause){cleanup.errors.push(message(cause));}}};
 const abort=()=>{life.abort(signal.reason);stopInput();};
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 /** Abort may beat an unabortable decoder operation. Its late owned sample is
  * closed exactly once; the pending count stays explicit until it settles. */
 async function operation<T>(work:Promise<T>,late?:(value:T)=>void,timeout:number=limits.operationTimeoutMs,abortable=true):Promise<T>{
  let abandoned=false,timer:ReturnType<typeof setTimeout>|undefined,onAbort:(()=>void)|undefined;
  const tracked=Promise.resolve(work);operations.add(tracked);cleanup.pendingOperations=operations.size;
  void tracked.then(value=>{if(abandoned)try{late?.(value);}catch(cause){cleanup.errors.push(message(cause));}},()=>{}).finally(()=>{operations.delete(tracked);cleanup.pendingOperations=operations.size;});
  const stopped=new Promise<never>((_,reject)=>{
   if(abortable){onAbort=()=>reject(life.signal.reason??new DOMException('Comparison stopped','AbortError'));life.signal.addEventListener('abort',onAbort,{once:true});if(life.signal.aborted)onAbort();}
   timer=setTimeout(()=>reject(Error('Comparison operation deadline exceeded.')),timeout);
  });
  try{return await Promise.race([tracked,stopped]);}catch(cause){abandoned=true;throw cause;}
  finally{clearTimeout(timer);if(onAbort)life.signal.removeEventListener('abort',onAbort);}
 }
 function closeSample(sample:ComparisonNativeSample){try{sample.close();state.nativeSamplesClosed++;}catch(cause){cleanup.errors.push(message(cause));}}
 async function clean(){
  return cleanupWork??=(async()=>{
   stopInput();
   if(iterator){if(iterator.return){try{await operation(iterator.return(),undefined,limits.cleanupTimeoutMs,false);cleanup.iteratorReturned=true;}catch(cause){cleanup.iteratorReturned=false;cleanup.errors.push(message(cause));}}
    else{cleanup.iteratorReturned=false;cleanup.errors.push('Comparison iterator has no return cleanup API.');}}
   if(transformer){try{await transformer.dispose();cleanup.transformerDisposed=true;cleanup.transformer=transformer.cleanup??null;}catch(cause){cleanup.transformerDisposed=false;cleanup.errors.push(message(cause));}}
   if(ownCanvas){try{ownCanvas.width=0;ownCanvas.height=0;cleanup.canvasCleared=true;}catch(cause){cleanup.errors.push(message(cause));}}
   // Keep only receipt metadata after completion; a report object must not pin
   // the encoded Blob, disposed decoder graph or released pixel owner.
   sourceBlob=undefined;input=undefined;iterator=undefined;transformer=undefined;ownCanvas=undefined;cleanup.sourceReferenceReleased=true;
   signal.removeEventListener('abort',abort);
  })();
 }
 async function raster(canvas:Canvas){
  const size=pixelBytes(canvas.width,canvas.height),start=platform.now(),data=context(canvas).getImageData(0,0,canvas.width,canvas.height).data;
  state.readbackMs+=platform.now()-start;
  if(!(data.buffer instanceof ArrayBuffer)||data.byteLength!==size)throw Error('Invalid comparison canvas readback.');
  state.maxReadbackBytes=Math.max(state.maxReadbackBytes,size);
  const at=platform.now(),hash=await operation(platform.hash(new Uint8Array(data.buffer,data.byteOffset,data.byteLength)));state.postPaintHashMs+=platform.now()-at;
  life.signal.throwIfAborted();if(!sha(hash))throw Error('Invalid post-paint RGBA hash.');return hash;
 }
 async function converted(sample:ComparisonNativeSample){
  if(sample.rotation!==0||sample.flip!==false||sample.pixelAspectRatio.num!==1||sample.pixelAspectRatio.den!==1)throw Error('Comparison native sample orientation/aspect is unsupported.');
  transformer??=platform.createTransformer();life.signal.throwIfAborted();
  const frame=sample.toVideoFrame(),at=platform.now();
  // transform takes ownership on all paths, including pre-abort and rejection.
  const result=await transformer.transform(frame,life.signal);state.transformMs+=platform.now()-at;life.signal.throwIfAborted();
  const size=pixelBytes(result.width,result.height),pixels=result.pixels;
  if(!(pixels instanceof Uint8Array)||!(pixels.buffer instanceof ArrayBuffer)||pixels.byteLength!==size||(pixels.buffer as ArrayBuffer&{resizable?:boolean}).resizable)throw Error('Invalid comparison RGBA owner.');
  const metadata=nativeMetadata(result.metadata);
  if(metadata.native.displayWidth!==result.width||metadata.native.displayHeight!==result.height)throw Error('Native comparison geometry mismatch.');
  if(!ownCanvas){ownCanvas=platform.createCanvas();ownedCanvasesCreated++;}if(ownCanvas.width!==result.width||ownCanvas.height!==result.height){ownCanvas.width=result.width;ownCanvas.height=result.height;}
  context(ownCanvas).putImageData(platform.imageData(new Uint8ClampedArray(pixels.buffer,pixels.byteOffset,pixels.byteLength),result.width,result.height),0,0);
  state.maxApplicationPixelArrayBytes=Math.max(state.maxApplicationPixelArrayBytes,size*2);
  const postPaintRgbaSha256=await raster(ownCanvas);
  if(postPaintRgbaSha256!==metadata.generatedRgbaSha256)throw Error('Generated and post-paint RGBA do not match.');
  return {canvas:ownCanvas,metadata,postPaintRgbaSha256};
 }
 function retain(receipt:ComparisonFrameReceipt){
  const size=bytes(receipt),budget=size+256;
  if(receipts.length>=limits.maxFrames||state.reservedMetadataBytes+budget>limits.metadataBytes)throw Error('Comparison receipt bound exceeded.');
  reserved.set(receipt,budget);receipts.push(receipt);state.produced++;state.retainedMetadataBytes+=size;state.reservedMetadataBytes+=budget;current=receipt;
 }
 function retireCurrent(){if(!current)return;if(!current.processingUse)state.unconsumed++;current=undefined;}
 async function* generate():AsyncGenerator<ScannerInputFrame,void,unknown>{
  if(state.finished)throw Error('Comparison input was already disposed.');state.started=true;
  let lastPts=-Infinity,failed=false,failure:unknown;
  try{
   life.signal.throwIfAborted();if(!sourceBlob)throw Error('Comparison source was already released.');input=platform.createInput(sourceBlob);life.signal.throwIfAborted();
   const track=await operation(input.getPrimaryVideoTrack());life.signal.throwIfAborted();
   if(!track||!positive(track.id)||!await operation(track.canDecode()))throw Error('Comparison video decoder unavailable.');
   const duration=await operation(track.computeDuration());if(!time(duration))throw Error('Invalid comparison track duration.');
   iterator=mode==='canvas-control'?platform.canvasSamples(track):platform.nativeSamples(track);
   while(true){
    life.signal.throwIfAborted();
    const next=await operation(iterator.next(),value=>{if(mode==='native-yuv'&&!value.done&&value.value)closeSample(value.value as ComparisonNativeSample);});
    if(next.done)break;state.decodedSamples++;
    const sample=next.value;
    try{
     let output:ScannerInputFrame;
     try{
     life.signal.throwIfAborted();if(!time(sample.timestamp)||sample.timestamp<lastPts||!time(sample.duration))throw Error('Invalid comparison sample order or duration.');
     if(state.produced>=limits.maxFrames)throw Error('Comparison frame count bound exceeded.');
     let canvas:Canvas,metadata:NativeYuvTransformMetadata|null=null,postPaintRgbaSha256:string;
     if(mode==='native-yuv'){const value=await converted(sample as ComparisonNativeSample);canvas=value.canvas;metadata=value.metadata;postPaintRgbaSha256=value.postPaintRgbaSha256;}
     else{canvas=(sample as ComparisonCanvasSample).canvas;postPaintRgbaSha256=await raster(canvas);state.maxApplicationPixelArrayBytes=Math.max(state.maxApplicationPixelArrayBytes,canvas.width*canvas.height*4);}
     life.signal.throwIfAborted();
     retain({ordinal:state.produced+1,trackId:track.id,pts:sample.timestamp,duration:sample.duration,width:canvas.width,height:canvas.height,
      recipeId:metadata?.recipeId??null,nativeSha256:metadata?.nativeSha256??null,descriptorSha256:metadata?.descriptorSha256??null,
      generatedRgbaSha256:metadata?.generatedRgbaSha256??null,postPaintRgbaSha256,native:metadata,processingUse:null});
     lastPts=sample.timestamp;
     // No pixels or sample owner are part of this serializable receipt.
     output={element:canvas,time:sample.timestamp,percent:duration>0?Math.max(0,Math.min(100,(sample.timestamp+sample.duration)/duration*100)):0};
     }finally{if(mode==='native-yuv')closeSample(sample as ComparisonNativeSample);}
     if(cleanup.errors.length)throw Error('Comparison sample cleanup failed.');
     yield output!;
     life.signal.throwIfAborted();if(!current?.processingUse)throw Error('Comparison input advanced before its actual scanner use was linked.');
    }finally{retireCurrent();}
    if(cleanup.errors.length)throw Error('Comparison sample cleanup failed.');await platform.yieldTask(life.signal);
   }
   life.signal.throwIfAborted();if(!state.produced)throw Error('No comparison frames decoded.');state.streamCompleted=true;
  }catch(cause){error(cause);failed=true;failure=cause;}
  finally{await clean();state.finished=true;if(cleanup.errors.length)state.error??='Comparison resource cleanup failed.';}
  if(failed)throw failure;
  if(cleanup.errors.length)throw Error(state.error??'Comparison resource cleanup failed.');
 }
 const frames=generate();
 function stats(){return {...state,cleanup:{...cleanup,errors:[...cleanup.errors]},mode,
  complete:state.streamCompleted&&state.finished&&!state.error&&!state.unconsumed&&!state.linkErrors&&!cleanup.errors.length&&cleanup.pendingOperations===0,
  actualAcquisitionRgbaHashMeasured:false,hashScope:'Post-paint RGBA hashes cover the provider canvas before scanner copying. Processing-use links match the actual scanner frame trace, not a Worker pixel digest.',
  resourceScope:'Only serial receipt metadata is accumulated. Pixel-array sizes exclude Canvas backing, decoder prefetch, digest internals, GPU and full process memory.',
  controlCanvasPoolSize:mode==='canvas-control'?2:null,ownedCanvasCount:ownedCanvasesCreated};}
 return {
  frames,
  noteConsumed(value:unknown){
   try{
    if(object(value)&&value.phase==='recovery')state.recoveryUseEvents++;
    if(!current||!object(value)||!positive(value.frame)||!positive(value.sourceFrameId)||value.phase!=='input'||value.time!==current.pts)throw Error('Comparison scanner use does not match the currently yielded input.');
    const use:ComparisonInputUse={frame:value.frame,sourceFrameId:value.sourceFrameId,time:current.pts,phase:'input'};
    if(current.processingUse){if(JSON.stringify(current.processingUse)===JSON.stringify(use))return;throw Error('Comparison input has conflicting processing uses.');}
    if(use.frame<=lastUseFrame||use.sourceFrameId<=lastUseSourceFrame)throw Error('Comparison input received a stale processing-use identity.');
    const previous=bytes(current),next={...current,processingUse:use},size=bytes(next);
    if(size>(reserved.get(current)??0))throw Error('Comparison scanner-use metadata exceeds its reservation.');
    current.processingUse=use;state.retainedMetadataBytes+=size-previous;state.consumed++;lastUseFrame=use.frame;lastUseSourceFrame=use.sourceFrameId;
   }catch(cause){state.linkErrors++;error(cause);throw cause;}
  },
  get stats(){return stats();},
  snapshot(){return {...stats(),receipts:structuredClone(receipts)};},
  dispose(){return disposeWork??=(async()=>{
   life.abort(new DOMException('Comparison disposed','AbortError'));stopInput();
   try{await operation(frames.return(undefined),undefined,limits.cleanupTimeoutMs,false);}catch(cause){state.error??=message(cause);cleanup.errors.push(message(cause));}
   await clean();state.finished=true;
  })();},
 };
}
