import { acquireCards } from './card-acquisition';
import { createDetector } from './detector';
import type { Box, Layout } from './detector';
import { paintPixelRaster } from './pixel-raster';
import type { PixelRaster } from './pixel-raster';
import {pixelHash} from './recording-frame-integrity';
import {acquisitionProfile} from './acquisition-profile';
import type {AcquisitionProfile} from './acquisition-profile';
import {detectorProfile,type DetectorProfile} from './detector-profile';
import {parsePreparedAcquisitionInput,parseAcquisitionPixelProof,validateMeasuredSourceRasterReceipt} from './source-raster-receipt';
import type {AcquisitionPixelProof,ExpectedRasterReceipt,MeasuredSourceRasterReceipt,PreparedAcquisitionInput} from './source-raster-receipt';
type Cell=Omit<ReturnType<typeof acquireCards>[number],'ownedPixels'>&{previewImage?:HTMLCanvasElement};
type WireCell=Omit<Cell,'image'|'previewImage'>&{bitmap?:ImageBitmap;pixels?:PixelRaster;previewBitmap?:ImageBitmap};
export type AcquisitionTiming={freezeMs:number;roundTripMs:number;workerMs:number;detectMs:number;cropMs:number;materializeMs:number;
 profile?:AcquisitionProfile;
 detectorProfile?:DetectorProfile;
 preparedHashMs?:number;targetPaintMs?:number;inputBytes?:number;rasterReadbackMs?:number;rasterHashMs?:number;
 gridReadbacksSaved?:number;cropReadbacksSaved?:number;localPixelCrops?:number};
// These IDs identify processing uses (legacy: also an exact archive frame).
// Canonical pixels have a separate source ID, including when analysis is reused.
export type Acquisition={frameId:number;cells:Cell[];layout:Layout|null;timing?:AcquisitionTiming;
 pixelProof?:AcquisitionPixelProof;rasterReceipt?:MeasuredSourceRasterReceipt};
export type PreparedAcquisition=Acquisition&{rasterReceipt:MeasuredSourceRasterReceipt};
type FallbackDetector=Pick<Awaited<ReturnType<typeof createDetector>>,'detect'|'dispose'>;

/** One frozen frame in flight. No unbounded full-resolution frame queue.
 * localCropPixels opts only ordinary Canvas requests into local owned crops;
 * native/prepared requests retain their existing transport and receipt paths. */
export function createAcquisitionClient(signal:AbortSignal,options:{pixelTransport?:boolean;pixelProof?:boolean;measuredRasterReuse?:boolean;localCropPixels?:boolean}={},
 platform:{detectorFactory?:()=>Promise<FallbackDetector>}={}) {
 if(options.measuredRasterReuse!==undefined&&typeof options.measuredRasterReuse!=='boolean')throw Error('Invalid measured raster reuse option');
 if(options.localCropPixels!==undefined&&typeof options.localCropPixels!=='boolean')throw Error('Invalid local crop pixels option');
 const measuredRasterReuse=options.measuredRasterReuse;
 const worker=typeof OffscreenCanvas==='undefined'||typeof createImageBitmap==='undefined' ? undefined :
  new Worker(new URL('./acquisition-worker.ts',import.meta.url),{type:'module'});
 let closed=false, nextId=0, freezing=false,preparedBusy=false;
 let pending:{id:number;sentAt:number;freezeMs:number;target?:HTMLCanvasElement;expectedRaster?:ExpectedRasterReceipt;
  proofRequired?:boolean;preparedHashMs?:number;targetPaintMs?:number;inputBytes?:number;
  resolve:(result:Acquisition)=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let preparing:Promise<void>|undefined;
 let readyJob:{resolve:()=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let fallback:FallbackDetector|undefined;
 let recordingAttached=false;
 let recordingEnded:(()=>void)|undefined;
 let preparedCancel:((reason:unknown)=>void)|undefined;
 function dispose(){closed=true;worker?.terminate();fallback?.dispose();fallback=undefined;preparedCancel?.(new DOMException('Stopped','AbortError'));if(readyJob){clearTimeout(readyJob.timer);readyJob.reject(new DOMException('Stopped','AbortError'));readyJob=undefined;}if(pending){clearTimeout(pending.timer);pending.reject(new DOMException('Stopped','AbortError'));pending=undefined;}signal.removeEventListener('abort',dispose);}
 function failClosed(error:unknown){closed=true;worker?.terminate();fallback?.dispose();fallback=undefined;
  preparedCancel?.(error);
  if(readyJob){clearTimeout(readyJob.timer);readyJob.reject(error);readyJob=undefined;}
  if(pending){clearTimeout(pending.timer);pending.reject(error);pending=undefined;}signal.removeEventListener('abort',dispose);}
 signal.addEventListener('abort',dispose,{once:true});
 if(signal.aborted)dispose();
 if(worker){
  worker.onerror=event=>failClosed(new Error(event.message||'카드 수집 Worker 오류'));
  worker.onmessage=(event:MessageEvent<{id:number;recordingEnded?:boolean;cells?:WireCell[];patches?:{box:Box;bitmap:ImageBitmap}[];layout?:Layout|null;
   timing?:Pick<AcquisitionTiming,'workerMs'|'detectMs'|'cropMs'|'rasterReadbackMs'|'rasterHashMs'|'gridReadbacksSaved'|'cropReadbacksSaved'|'localPixelCrops'|'profile'|'detectorProfile'>;
   pixelProof?:unknown;rasterReceipt?:unknown;ready?:boolean;error?:string}>)=>{
   if(event.data.recordingEnded){recordingEnded?.();return;}
   const {id,cells,patches,error}=event.data;
   const closeImages=()=>{if(Array.isArray(cells))for(const cell of cells){try{cell?.bitmap?.close();}catch{/* Late ownership cleanup. */}try{cell?.previewBitmap?.close();}catch{/* Late ownership cleanup. */}}
    if(Array.isArray(patches))for(const patch of patches)try{patch?.bitmap?.close();}catch{/* Late ownership cleanup. */}};
   if(event.data.ready){if(readyJob){const job=readyJob;readyJob=undefined;clearTimeout(job.timer);if(error)job.reject(new Error(error));else job.resolve();}return;}
   if(!pending||pending.id!==id){closeImages();return;}
   const job=pending;pending=undefined;clearTimeout(job.timer);
   if(error){closeImages();job.reject(new Error(error));return;}
   const result:Cell[]=[];
   const receivedAt=performance.now();
   try {
    const rasterReceipt=job.expectedRaster?validateMeasuredSourceRasterReceipt(event.data.rasterReceipt,job.expectedRaster):undefined;
    if(!job.expectedRaster&&event.data.rasterReceipt!==undefined)throw Error('요청하지 않은 원본 래스터 영수증');
    const pixelProof=event.data.pixelProof===undefined?undefined:parseAcquisitionPixelProof(event.data.pixelProof);
    if(job.proofRequired&&!pixelProof)throw Error('요청한 수집 픽셀 증명 누락');
    if(job.expectedRaster&&pixelProof&&pixelProof.hash!==job.expectedRaster.hash)throw Error('수집 픽셀 증명 해시 불일치');
    if(!Array.isArray(cells)||cells.length>40)throw Error('잘못된 수집 카드 응답');
    if(job.target){
     const context=job.target.getContext('2d',{willReadFrequently:true})!;
     context.clearRect(0,0,job.target.width,job.target.height);
     for(const patch of patches??[])context.drawImage(patch.bitmap,patch.box.x,patch.box.y);
    }
    for(const {bitmap,pixels,previewBitmap,...cell} of cells!){
     const raster=pixels??bitmap;
     if(!raster)throw new Error('카드 픽셀 데이터 누락');
     const image=document.createElement('canvas');image.width=raster.width;image.height=raster.height;
     const context=image.getContext('2d',{willReadFrequently:true})!;
     if(pixels)paintPixelRaster(context,pixels);
     else context.drawImage(bitmap!,0,0);
     const entry:Cell={...cell,image};result.push(entry);
     if(previewBitmap){
      const previewImage=document.createElement('canvas');entry.previewImage=previewImage;
      previewImage.width=previewBitmap.width;previewImage.height=previewBitmap.height;
      previewImage.getContext('2d',{willReadFrequently:true})!.drawImage(previewBitmap,0,0);
     }
    }
    job.resolve({frameId:id,cells:result,layout:event.data.layout??null,...(pixelProof?{pixelProof}:{}),...(rasterReceipt?{rasterReceipt}:{}),
     timing:{freezeMs:job.freezeMs,roundTripMs:receivedAt-job.sentAt,
     ...(detectorProfile(event.data.timing?.detectorProfile)?{detectorProfile:detectorProfile(event.data.timing?.detectorProfile)}:{}),
     ...(acquisitionProfile(event.data.timing?.profile)?{profile:acquisitionProfile(event.data.timing?.profile)}:{}),
     workerMs:event.data.timing?.workerMs??0,detectMs:event.data.timing?.detectMs??0,cropMs:event.data.timing?.cropMs??0,materializeMs:performance.now()-receivedAt,
     ...(job.expectedRaster?{preparedHashMs:job.preparedHashMs,targetPaintMs:job.targetPaintMs,inputBytes:job.inputBytes}:{}),
     ...(event.data.timing?.rasterReadbackMs===undefined?{}:{rasterReadbackMs:event.data.timing.rasterReadbackMs}),
     ...(event.data.timing?.rasterHashMs===undefined?{}:{rasterHashMs:event.data.timing.rasterHashMs}),
     ...(Number.isInteger(event.data.timing?.gridReadbacksSaved)&&event.data.timing!.gridReadbacksSaved!>=0&&event.data.timing!.gridReadbacksSaved!<=1?
       {gridReadbacksSaved:event.data.timing!.gridReadbacksSaved}:{}),
     ...(Number.isInteger(event.data.timing?.cropReadbacksSaved)&&event.data.timing!.cropReadbacksSaved!>=0&&event.data.timing!.cropReadbacksSaved!<=40?
       {cropReadbacksSaved:event.data.timing!.cropReadbacksSaved}:{}),
     ...(Number.isInteger(event.data.timing?.localPixelCrops)&&event.data.timing!.localPixelCrops!>=0&&event.data.timing!.localPixelCrops!<=40?
       {localPixelCrops:event.data.timing!.localPixelCrops}:{})}});
   }catch(error){result.forEach(c=>{c.image.width=0;if(c.previewImage)c.previewImage.width=0;});job.reject(error);}
   finally{closeImages();}
  };
 }
 async function ready() {
  signal.throwIfAborted();if(closed)throw new Error('카드 수집 종료');
  return preparing??=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{readyJob=undefined;reject(new Error('카드 창 검출 Worker 준비 시간 초과'));},30000);
   const job=readyJob={resolve,reject,timer};
   try{if(worker)worker.postMessage({kind:'prepare'});
    else void (platform.detectorFactory??createDetector)().then(value=>{
      if(closed||readyJob!==job){value.dispose();return;}
      fallback=value;readyJob=undefined;clearTimeout(timer);resolve();
    },error=>{if(readyJob===job){readyJob=undefined;clearTimeout(timer);reject(error);}});}
   catch(error){clearTimeout(timer);readyJob=undefined;reject(error);}
  });
 }
 async function acquire(frame:HTMLCanvasElement,layout?:Layout,nativeSource?:HTMLVideoElement|VideoFrame,time=0,recordOnly=false,phase:'input'|'recovery'='input'):Promise<Acquisition>{
  signal.throwIfAborted();if(closed)throw new Error('카드 수집 종료');
  if(nativeSource&&!worker)throw new Error('직접 프레임 수집을 지원하지 않습니다.');
  if(pending||freezing)throw new Error('동시 수집 요청');
  if(!worker){freezing=true;try{if(!layout)await ready();signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');
    const frameId=++nextId,found=layout??fallback!.detect(frame),cells=found?acquireCards(frame,found):[];
    let pixelProof:AcquisitionPixelProof|undefined;
    if(options.pixelProof){const pixels=frame.getContext('2d',{willReadFrequently:true})!.getImageData(0,0,frame.width,frame.height).data;
      pixelProof=parseAcquisitionPixelProof({hash:await pixelHash(new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength)),sample:Array.from(pixels.subarray(0,32))});
      signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');}
    return {frameId,layout:found,cells,...(pixelProof?{pixelProof}:{})};
   }finally{freezing=false;}}
  freezing=true;
  const freezeStarted=performance.now();
  let bitmap:ImageBitmap|VideoFrame;
  try { bitmap=nativeSource?new VideoFrame(nativeSource):await createImageBitmap(frame); }
  finally { freezing=false; }
  if(closed||signal.aborted){bitmap.close();signal.throwIfAborted();throw new Error('카드 수집 종료');}
  const id=++nextId;
  return new Promise<Acquisition>((resolve,reject)=>{
   const timer=setTimeout(()=>{pending=undefined;worker.terminate();closed=true;reject(new Error('카드 수집 시간 초과'));},20000);
   pending={id,sentAt:performance.now(),freezeMs:performance.now()-freezeStarted,target:nativeSource?frame:undefined,
    proofRequired:options.pixelProof===true&&!recordOnly,resolve,reject,timer};
   try{worker.postMessage({id,bitmap,layout,time,recordOnly,phase,patches:!!nativeSource,pixelTransport:options.pixelTransport===true,
    ...(!nativeSource&&!recordOnly&&options.localCropPixels?{localCropPixels:true}:{}),
    ...(options.pixelProof?{pixelProof:true}:{}),...(measuredRasterReuse===undefined?{}:{measuredRasterReuse})},[bitmap]);}
   catch(error){clearTimeout(timer);pending=undefined;bitmap.close();reject(error);}
  });
 }
 /** Consumes the one owned full RGBA raster. Neither route rereads a video or
  * converts a VideoFrame; the returned receipt measures the detector canvas. */
 async function detectPrepared(input:PreparedAcquisitionInput,target?:HTMLCanvasElement):Promise<PreparedAcquisition>{
  signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');
  if(recordingAttached)throw Error('준비된 원본은 이전 기록 포트와 함께 수집할 수 없습니다.');
  if(pending||freezing)throw Error('동시 수집 요청');
  const checked=parsePreparedAcquisitionInput(input),started=performance.now();
  freezing=true;preparedBusy=true;
  let cancel!:(reason:unknown)=>void,internal:HTMLCanvasElement|undefined;
  const stopped=new Promise<never>((_,reject)=>{cancel=reject;});preparedCancel=cancel;
  const timeout=setTimeout(()=>failClosed(Error('준비된 카드 수집 시간 초과')),20_000);
  const abort=()=>cancel(signal.reason);signal.addEventListener('abort',abort,{once:true});
  const check=()=>{signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');};
  try{return await Promise.race([stopped,(async()=>{
    // Taking ownership first detaches any caller aliases before the first await.
    // This moves the whole buffer; it does not make a second pixel copy.
    const pixels=structuredClone(checked.pixels,{transfer:[checked.pixels.buffer]}),freezeMs=performance.now()-started;
    const paint=(canvas:HTMLCanvasElement)=>{const at=performance.now();canvas.width=checked.width;canvas.height=checked.height;
      const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('준비된 원본 Canvas 미지원');
      context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer),checked.width,checked.height),0,0);return performance.now()-at;};
    let targetPaintMs=target?paint(target):0;
    const hashStarted=performance.now(),hash=await pixelHash(pixels),preparedHashMs=performance.now()-hashStarted;check();
    if(worker){
      const id=++nextId,expectedRaster={...checked.binding,acquisitionFrameId:id,width:checked.width,height:checked.height,hash};
      const result=await new Promise<Acquisition>((resolve,reject)=>{
        const timer=setTimeout(()=>failClosed(Error('준비된 카드 수집 시간 초과')),20_000);
        pending={id,sentAt:performance.now(),freezeMs,expectedRaster,preparedHashMs,targetPaintMs,inputBytes:pixels.byteLength,
          proofRequired:options.pixelProof===true,resolve,reject,timer};
        try{worker.postMessage({kind:'prepared',id,prepared:{pixels,width:checked.width,height:checked.height,binding:checked.binding},
          pixelTransport:options.pixelTransport===true,...(options.pixelProof?{pixelProof:true}:{}),
          ...(measuredRasterReuse===undefined?{}:{measuredRasterReuse})},[pixels.buffer]);}
        catch(error){clearTimeout(timer);pending=undefined;reject(error);}
      });
      if(!result.rasterReceipt)throw Error('준비된 원본 래스터 영수증 누락');return result as PreparedAcquisition;
    }
    await ready();check();
    const canvas=target??(internal=document.createElement('canvas'));if(!target)targetPaintMs=paint(canvas);
    const context=canvas.getContext('2d',{willReadFrequently:true})!,readAt=performance.now(),
      actual=context.getImageData(0,0,checked.width,checked.height).data,rasterReadbackMs=performance.now()-readAt,
      actualBytes=new Uint8Array(actual.buffer,actual.byteOffset,actual.byteLength),hashAt=performance.now(),actualHash=await pixelHash(actualBytes),
      rasterHashMs=performance.now()-hashAt;check();
    const id=++nextId,rasterReceipt=validateMeasuredSourceRasterReceipt({version:1,kind:'measured',...checked.binding,
      acquisitionFrameId:id,width:canvas.width,height:canvas.height,hash:actualHash},
      {...checked.binding,acquisitionFrameId:id,width:checked.width,height:checked.height,hash});
    const detectAt=performance.now(),layout=fallback!.detect(canvas),cropAt=performance.now(),cells=layout?acquireCards(canvas,layout):[],finished=performance.now();
    return {frameId:id,cells,layout,rasterReceipt,
      ...(options.pixelProof?{pixelProof:parseAcquisitionPixelProof({hash:actualHash,sample:Array.from(actual.subarray(0,32))})}:{}),
      timing:{freezeMs,roundTripMs:finished-started,workerMs:0,detectMs:cropAt-detectAt,cropMs:finished-cropAt,materializeMs:0,
        preparedHashMs,targetPaintMs,inputBytes:pixels.byteLength,rasterReadbackMs,rasterHashMs}};
  })()]);}
  finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);if(preparedCancel===cancel)preparedCancel=undefined;
    freezing=false;preparedBusy=false;if(internal){internal.width=0;internal.height=0;}}
 }
 return {dispose,ready,supportsNative:!!worker&&typeof VideoFrame!=='undefined',
  reserveFrameId:()=>{signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');if(pending||freezing)throw Error('동시 수집은 허용되지 않습니다.');return ++nextId;},
  startRecording:(port:MessagePort)=>{signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');if(preparedBusy)throw Error('준비된 원본 수집 중에는 이전 기록 포트를 연결할 수 없습니다.');
    if(!worker)throw Error('무손실 입력 기록 Worker 미지원');worker.postMessage({kind:'record',port},[port]);recordingAttached=true;},
  stopRecording:async()=>{if(recordingAttached){recordingAttached=false;await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('입력 기록 종료 응답 없음')),1000);
   recordingEnded=()=>{clearTimeout(timer);recordingEnded=undefined;resolve();};worker?.postMessage({kind:'record-end'});
  });}},
  recordOnly:async(frame:HTMLCanvasElement,time:number):Promise<number|undefined>=>{if(recordingAttached)return (await acquire(frame,undefined,undefined,time,true)).frameId;},
  detectNative:(source:HTMLVideoElement|VideoFrame,target:HTMLCanvasElement,time=0)=>acquire(target,undefined,source,time),
  detectPrepared,
  detectAndAcquire:(frame:HTMLCanvasElement,time=0,phase:'input'|'recovery'='input')=>acquire(frame,undefined,undefined,time,false,phase),
  acquire:async(frame:HTMLCanvasElement,layout:Layout)=>(await acquire(frame,layout)).cells};
}
