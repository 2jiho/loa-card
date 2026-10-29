import { createCardAcquirer } from './card-acquisition';
import { createDetector } from './detector';
import type { Layout, DetectorPlatform } from './detector';
import { metadataRegions } from './metadata-regions';
import { readPixelRaster } from './pixel-raster';
import {pixelHash} from './recording-frame-integrity';
import {acquisitionProfile} from './acquisition-profile';
import {recordDetectorStage,type DetectorProfile} from './detector-profile';
import {parsePreparedAcquisitionInput,parseMeasuredSourceRasterReceipt} from './source-raster-receipt';
import type {PreparedAcquisitionInput} from './source-raster-receipt';
const acquire=createCardAcquirer((w,h)=>new OffscreenCanvas(w,h),true);
const frame=new OffscreenCanvas(1,1);
const context=frame.getContext('2d',{willReadFrequently:true})!;
let detector:ReturnType<typeof createDetector>|undefined;
let recording:MessagePort|undefined,credits=3,inFlightBytes=0,peakInFlightBytes=0;
let acquiring=false;
let detectorWork:DetectorProfile={};
function prepare() {
 return detector??=(async()=>{
  const base=new URL(import.meta.env.BASE_URL,self.location.href).href;
  await import(/* @vite-ignore */ `${base}ocr/opencv.js`);
  const cv=await (self as unknown as {cv:Promise<DetectorPlatform['cv']>}).cv;
  return createDetector({cv,canvas:()=>new OffscreenCanvas(1,1),anchor:async name=>{
   const response=await fetch(`${base}scanner/${name}`);
   if(!response.ok)throw new Error('카드 창 기준 이미지 로드 실패');
   const bitmap=await createImageBitmap(await response.blob());
   try {
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true})!;
    ctx.drawImage(bitmap,0,0);return cv.matFromImageData(ctx.getImageData(0,0,canvas.width,canvas.height));
   }finally{bitmap.close();}
  }},true,import.meta.env.DEV?event=>recordDetectorStage(detectorWork,event):undefined);
 })();
}
self.onmessage=async(event:MessageEvent<{kind?:'prepare'|'record'|'record-end'|'prepared';port?:MessagePort;time?:number;recordOnly?:boolean;phase?:'input'|'recovery';id:number;bitmap?:ImageBitmap|VideoFrame;prepared?:PreparedAcquisitionInput;layout?:Layout;patches?:boolean;pixelTransport?:boolean;pixelProof?:boolean;measuredRasterReuse?:boolean;localCropPixels?:boolean}>)=>{
 const {id,bitmap}=event.data;
 if(event.data.kind==='record'){
  if(acquiring){event.data.port?.close();self.postMessage({id,error:'수집 중에는 이전 기록 포트를 연결할 수 없습니다.'});return;}
  recording=event.data.port;credits=3;inFlightBytes=peakInFlightBytes=0;
  if(recording){recording.onmessage=e=>{credits=Math.min(3,credits+1);inFlightBytes=Math.max(0,inFlightBytes-(e.data.bytes??0));};recording.start();}return;
 }
 if(event.data.kind==='record-end'){recording?.postMessage({kind:'end',peakInFlightBytes});recording?.close();recording=undefined;self.postMessage({recordingEnded:true});return;}
 if(event.data.kind==='prepare') {
  try{await prepare();self.postMessage({ready:true});}
  catch(error){self.postMessage({ready:true,error:String(error)});}
  return;
 }
 if(acquiring){bitmap?.close();self.postMessage({id,error:'동시 수집 요청'});return;}
 acquiring=true;
 const transfers:ImageBitmap[]=[];
 const pixelTransfers:ArrayBuffer[]=[];
 let forwarded=false;
 try {
  const started=performance.now();
  if(event.data.measuredRasterReuse!==undefined&&typeof event.data.measuredRasterReuse!=='boolean')
    throw Error('잘못된 측정 픽셀 재사용 옵션');
  if(event.data.localCropPixels!==undefined&&typeof event.data.localCropPixels!=='boolean')
    throw Error('잘못된 로컬 카드 픽셀 옵션');
  const prepared=event.data.kind==='prepared'?parsePreparedAcquisitionInput(event.data.prepared):undefined;
  if(event.data.localCropPixels&&(prepared||event.data.patches||event.data.recordOnly))
    throw Error('로컬 카드 픽셀은 일반 Canvas 수집에서만 지원합니다.');
  if(prepared&&(!Number.isSafeInteger(id)||id<1||bitmap!==undefined||event.data.recordOnly||event.data.patches||
    event.data.time!==undefined&&event.data.time!==prepared.binding.captureTime||recording))
    throw Error('준비된 원본과 이전 수집/기록 경로를 혼합할 수 없습니다.');
  if(!prepared&&event.data.prepared!==undefined)throw Error('준비된 원본 수집 방식 누락');
  if(!prepared&&!bitmap)throw Error('수집 원본 누락');
  const width=prepared?prepared.width:'displayWidth' in bitmap!?bitmap!.displayWidth:bitmap!.width;
  const height=prepared?prepared.height:'displayHeight' in bitmap!?bitmap!.displayHeight:bitmap!.height;
  if(!event.data.recordOnly){
   if(frame.width!==width||frame.height!==height){frame.width=width;frame.height=height;}
   context.globalCompositeOperation='copy';
   if(prepared)context.putImageData(new ImageData(new Uint8ClampedArray(prepared.pixels.buffer),width,height),0,0);
   else context.drawImage(bitmap!,0,0);
  }
  // Opt-in dev proof only. Ordinary acquisition never requests this additional
  // full-frame readback. It hashes the actual detector canvas, not another copy.
  const readbackStarted=performance.now(),proofPixels=(prepared||event.data.pixelProof)&&!event.data.recordOnly?context.getImageData(0,0,width,height).data:undefined,
    rasterReadbackMs=performance.now()-readbackStarted,hashStarted=performance.now();
  let rasterHashMs=0;
  const proofHash=proofPixels?pixelHash(new Uint8Array(proofPixels.buffer,proofPixels.byteOffset,proofPixels.byteLength))
    .then(hash=>{rasterHashMs=performance.now()-hashStarted;return hash;}):undefined;
  // Observe a failed digest while detector preparation is still awaited.
  void proofHash?.catch(()=>{});
  // drawImage has already copied this immutable source into the detector's
  // canvas. Transfer that source to the recorder; full-screen CPU readback
  // belongs there and must not serialize detection/cropping on this worker.
  if(recording&&!prepared){
   if(credits>0&&width*height*4<=32*1024*1024&&inFlightBytes+width*height*4<=64*1024*1024){
    try{
     recording.postMessage({kind:'frame',id,time:event.data.time??0,phase:event.data.recordOnly?'recovery':event.data.phase??'input',width,height,bitmap},[bitmap!]);
     forwarded=true;credits--;inFlightBytes+=width*height*4;peakInFlightBytes=Math.max(peakInFlightBytes,inFlightBytes);
    }catch{try{recording.postMessage({kind:'gap',id,time:event.data.time??0});}catch{/* Capture remains independent of a failed recorder. */}}
   }else recording.postMessage({kind:'gap',id,time:event.data.time??0});
  }
  if(event.data.recordOnly){self.postMessage({id,cells:[],layout:null});return;}
  const detectStarted=performance.now();
  detectorWork={};
  const layout=event.data.layout??(await prepare()).detect(frame);
  const cropStarted=performance.now();
  const reuse=!event.data.localCropPixels&&proofPixels&&event.data.measuredRasterReuse!==false?{
    measuredRaster:{width,height,data:proofPixels},ownCardPixels:!!event.data.pixelTransport,
  }:undefined;
  const cells=(layout?(event.data.localCropPixels?acquire.localPixels(frame,layout):acquire(frame,layout,reuse)):[]).map(({image,ownedPixels,...cell})=>{
   const pixels=!image?ownedPixels:event.data.pixelTransport?ownedPixels??readPixelRaster(image):undefined;
   const raster=pixels?undefined:image!.transferToImageBitmap();
   if(raster)transfers.push(raster);
   if(pixels){pixelTransfers.push(pixels.data.buffer);if(image)image.width=0;}
   let previewBitmap:ImageBitmap|undefined;
   if(event.data.patches&&cell.quality.usable){
    const box=cell.preview,preview=new OffscreenCanvas(Math.round(box.width),Math.round(box.height));
    preview.getContext('2d',{willReadFrequently:true})!.drawImage(frame,box.x,box.y,box.width,box.height,0,0,preview.width,preview.height);
    previewBitmap=preview.transferToImageBitmap();transfers.push(previewBitmap);
   }
   return {...cell,bitmap:raster,pixels,previewBitmap};
  });
  const patches=event.data.patches&&layout?metadataRegions(layout,width,height).map(box=>{
   const patch=new OffscreenCanvas(box.width,box.height);
   patch.getContext('2d',{willReadFrequently:true})!.drawImage(frame,box.x,box.y,box.width,box.height,0,0,box.width,box.height);
   const bitmap=patch.transferToImageBitmap();transfers.push(bitmap);return {box,bitmap};
  }):undefined;
  const cropFinished=performance.now(),hash=await proofHash;
  const pixelProof=proofPixels&&hash?{
   hash,
   sample:Array.from(proofPixels.subarray(0,32)),
  }:undefined;
  const rasterReceipt=prepared?parseMeasuredSourceRasterReceipt({version:1,kind:'measured',...prepared.binding,acquisitionFrameId:id,
    width:frame.width,height:frame.height,hash}):undefined;
  const reuseStats=layout?acquire.stats():undefined;
  self.postMessage({id,cells,layout,patches,pixelProof,...(rasterReceipt?{rasterReceipt}:{}),
    timing:{workerMs:performance.now()-started,detectMs:cropStarted-detectStarted,cropMs:cropFinished-cropStarted,
      ...(Object.keys(detectorWork).length?{detectorProfile:detectorWork}:{}),
      ...(reuseStats?{profile:acquisitionProfile(reuseStats)}:{}),
      ...(reuse?{gridReadbacksSaved:reuseStats?.gridReadbacksSaved??0,cropReadbacksSaved:reuseStats?.cropReadbacksSaved??0}:{}),
      ...(event.data.localCropPixels?{localPixelCrops:reuseStats?.localPixelCrops??0}:{}),
      ...(proofPixels?{rasterReadbackMs,rasterHashMs}:{})}}, {transfer:[...transfers,...pixelTransfers]});
 }catch(error){for(const raster of transfers)raster.close();self.postMessage({id,error:String(error)});}
 finally{acquiring=false;if(!forwarded)bitmap?.close();}
};
