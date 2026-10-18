import { acquireCards } from './card-acquisition';
import { createDetector } from './detector';
import type { Box, Layout } from './detector';
import { paintPixelRaster } from './pixel-raster';
import type { PixelRaster } from './pixel-raster';
type Cell=ReturnType<typeof acquireCards>[number]&{previewImage?:HTMLCanvasElement};
type WireCell=Omit<Cell,'image'|'previewImage'>&{bitmap?:ImageBitmap;pixels?:PixelRaster;previewBitmap?:ImageBitmap};
export type AcquisitionTiming={freezeMs:number;roundTripMs:number;workerMs:number;detectMs:number;cropMs:number;materializeMs:number};
type Acquisition={cells:Cell[];layout:Layout|null;timing?:AcquisitionTiming};

/** One frozen frame in flight. No unbounded full-resolution frame queue. */
export function createAcquisitionClient(signal:AbortSignal,options:{pixelTransport?:boolean}={}) {
 const worker=typeof OffscreenCanvas==='undefined'||typeof createImageBitmap==='undefined' ? undefined :
  new Worker(new URL('./acquisition-worker.ts',import.meta.url),{type:'module'});
 let closed=false, nextId=0, freezing=false;
 let pending:{id:number;sentAt:number;freezeMs:number;target?:HTMLCanvasElement;resolve:(result:Acquisition)=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let preparing:Promise<void>|undefined;
 let readyJob:{resolve:()=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let fallback:Awaited<ReturnType<typeof createDetector>>|undefined;
 let recordingAttached=false;
 let recordingEnded:(()=>void)|undefined;
 function dispose(){closed=true;worker?.terminate();fallback?.dispose();fallback=undefined;if(readyJob){clearTimeout(readyJob.timer);readyJob.reject(new DOMException('Stopped','AbortError'));readyJob=undefined;}if(pending){clearTimeout(pending.timer);pending.reject(new DOMException('Stopped','AbortError'));pending=undefined;}signal.removeEventListener('abort',dispose);}
 signal.addEventListener('abort',dispose,{once:true});
 if(signal.aborted)dispose();
 if(worker){
  worker.onerror=event=>{const error=new Error(event.message||'카드 수집 Worker 오류');if(readyJob){clearTimeout(readyJob.timer);readyJob.reject(error);readyJob=undefined;}if(pending){clearTimeout(pending.timer);pending.reject(error);pending=undefined;}};
  worker.onmessage=(event:MessageEvent<{id:number;recordingEnded?:boolean;cells?:WireCell[];patches?:{box:Box;bitmap:ImageBitmap}[];layout?:Layout|null;timing?:Pick<AcquisitionTiming,'workerMs'|'detectMs'|'cropMs'>;ready?:boolean;error?:string}>)=>{
   if(event.data.recordingEnded){recordingEnded?.();return;}
   const {id,cells,patches,error}=event.data;
   const closeImages=()=>{cells?.forEach(c=>{c.bitmap?.close();c.previewBitmap?.close();});patches?.forEach(p=>p.bitmap.close());};
   if(event.data.ready){if(readyJob){const job=readyJob;readyJob=undefined;clearTimeout(job.timer);if(error)job.reject(new Error(error));else job.resolve();}return;}
   if(!pending||pending.id!==id){closeImages();return;}
   const job=pending;pending=undefined;clearTimeout(job.timer);
   if(error){closeImages();job.reject(new Error(error));return;}
   const result:Cell[]=[];
   const receivedAt=performance.now();
   try {
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
    job.resolve({cells:result,layout:event.data.layout??null,timing:{freezeMs:job.freezeMs,roundTripMs:receivedAt-job.sentAt,
     workerMs:event.data.timing?.workerMs??0,detectMs:event.data.timing?.detectMs??0,cropMs:event.data.timing?.cropMs??0,materializeMs:performance.now()-receivedAt}});
   }catch(error){result.forEach(c=>{c.image.width=0;if(c.previewImage)c.previewImage.width=0;});job.reject(error);}
   finally{closeImages();}
  };
 }
 async function ready() {
  signal.throwIfAborted();if(closed)throw new Error('카드 수집 종료');
  if(!worker){if(!fallback)fallback=await createDetector();if(closed){fallback.dispose();fallback=undefined;signal.throwIfAborted();}return;}
  return preparing??=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>{readyJob=undefined;reject(new Error('카드 창 검출 Worker 준비 시간 초과'));},30000);
   readyJob={resolve,reject,timer};
   try{worker.postMessage({kind:'prepare'});}
   catch(error){clearTimeout(timer);readyJob=undefined;reject(error);}
  });
 }
 async function acquire(frame:HTMLCanvasElement,layout?:Layout,nativeSource?:HTMLVideoElement|VideoFrame,time=0,recordOnly=false):Promise<Acquisition>{
  signal.throwIfAborted();if(closed)throw new Error('카드 수집 종료');
  if(nativeSource&&!worker)throw new Error('직접 프레임 수집을 지원하지 않습니다.');
  if(!worker){if(!layout)await ready();const found=layout??fallback!.detect(frame);return {layout:found,cells:found?acquireCards(frame,found):[]};}
  if(pending||freezing)throw new Error('동시 수집 요청');
  freezing=true;
  const freezeStarted=performance.now();
  let bitmap:ImageBitmap|VideoFrame;
  try { bitmap=nativeSource?new VideoFrame(nativeSource):await createImageBitmap(frame); }
  finally { freezing=false; }
  if(closed||signal.aborted){bitmap.close();signal.throwIfAborted();throw new Error('카드 수집 종료');}
  const id=++nextId;
  return new Promise<Acquisition>((resolve,reject)=>{
   const timer=setTimeout(()=>{pending=undefined;worker.terminate();closed=true;reject(new Error('카드 수집 시간 초과'));},20000);
   pending={id,sentAt:performance.now(),freezeMs:performance.now()-freezeStarted,target:nativeSource?frame:undefined,resolve,reject,timer};
   try{worker.postMessage({id,bitmap,layout,time,recordOnly,patches:!!nativeSource,pixelTransport:options.pixelTransport===true},[bitmap]);}
   catch(error){clearTimeout(timer);pending=undefined;bitmap.close();reject(error);}
  });
 }
 return {dispose,ready,supportsNative:!!worker&&typeof VideoFrame!=='undefined',
  startRecording:(port:MessagePort)=>{if(!worker)throw Error('무손실 입력 기록 Worker 미지원');worker.postMessage({kind:'record',port},[port]);recordingAttached=true;},
  stopRecording:async()=>{if(recordingAttached){recordingAttached=false;await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('입력 기록 종료 응답 없음')),1000);
   recordingEnded=()=>{clearTimeout(timer);recordingEnded=undefined;resolve();};worker?.postMessage({kind:'record-end'});
  });}},
  recordOnly:async(frame:HTMLCanvasElement,time:number)=>{if(recordingAttached)await acquire(frame,undefined,undefined,time,true);},
  detectNative:(source:HTMLVideoElement|VideoFrame,target:HTMLCanvasElement,time=0)=>acquire(target,undefined,source,time),
  detectAndAcquire:(frame:HTMLCanvasElement,time=0)=>acquire(frame,undefined,undefined,time),
  acquire:async(frame:HTMLCanvasElement,layout:Layout)=>(await acquire(frame,layout)).cells};
}
