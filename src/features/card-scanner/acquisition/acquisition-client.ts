import { acquireCards } from './card-acquisition';
import type {ExperimentalExactReceipt} from './card-acquisition';
import {createExperimentalAcquisitionReceiptBridge} from './experimental-acquisition-receipts';
import { createDetector } from './detector';
import type { Box, Layout } from './detector';
import { paintPixelRaster } from './pixel-raster';
import type { PixelRaster } from './pixel-raster';
import {pixelHash} from '../reproduction/recording-frame-integrity';
import {acquisitionProfile} from './acquisition-profile';
import type {AcquisitionProfile} from './acquisition-profile';
import {detectorProfile,type DetectorProfile} from './detector-profile';
import {parsePreparedAcquisitionInput,parseAcquisitionPixelProof,validateMeasuredSourceRasterReceipt} from './source-raster-receipt';
import type {AcquisitionPixelProof,ExpectedRasterReceipt,MeasuredSourceRasterReceipt,PreparedAcquisitionInput} from './source-raster-receipt';
import type {FrameObstructionResult} from './frame-obstruction-candidate';
import type {ObstructionRoiHash} from './frame-obstruction-worker';
import {createPreparedCanvasHasher,preparedCropDiagnostic,type PreparedCropDiagnostic} from './prepared-crop-proof-client';
export type FrameObstructionProbeEvent={kind:'result';id:number;time:number;roi:{x:number;y:number;width:number;height:number};readbackMs:number;readbackBytes:number;computeMs:number;result:FrameObstructionResult|null;roiHash?:ObstructionRoiHash;error?:string}|
 {kind:'submitted';id:number;time:number;roi:{x:number;y:number;width:number;height:number};readbackMs:number;readbackBytes:number;hashRequested:boolean}|
 {kind:'skipped';id:number;time:number;reason:string}|{kind:'error';reason:string};
type Cell=Omit<ReturnType<typeof acquireCards>[number],'ownedPixels'>&{previewImage?:HTMLCanvasElement};
export type RejectedTransportCell=Omit<Cell,'image'>&(
 {cropState:'materialized';image:HTMLCanvasElement}|{cropState:'omitted-rejected';image:null;originalWidth:number;originalHeight:number});
type WireCell=Omit<Cell,'image'|'previewImage'>&{bitmap?:ImageBitmap;pixels?:PixelRaster;previewBitmap?:ImageBitmap;
 cropState?:'materialized'|'omitted-rejected';originalWidth?:number;originalHeight?:number};
/** Validate all experimental wire entries before painting any canvas. The
 * metadata says what was omitted; it is not a pixel or recognition proof. */
export function validateRejectedTransport(cells:readonly WireCell[],expectedCount?:number):{omitted:number;kept:number;omittedRgbaBytes:number} {
 if(!Array.isArray(cells)||cells.length>40||expectedCount!==undefined&&(!Number.isSafeInteger(expectedCount)||expectedCount!==cells.length))
  throw Error('잘못된 생략 카드 응답');
 let omitted=0,kept=0,omittedRgbaBytes=0;const seenSlots=new Set<number>(),seenReasons=new Set<string>();
 const validBox=(box:Box)=>!!box&&[box.x,box.y,box.width,box.height].every(value=>Number.isFinite(value)&&Math.abs(value)<=65536)&&box.width>0&&box.height>0;
 const identifier=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=160&&
  Array.from(value).every(character=>{const code=character.charCodeAt(0);return code>=32&&(code<127||code>159);});
 const unit=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
 for(const [index,cell] of cells.entries()){
  if(!cell||cell.slot!==index||seenSlots.has(cell.slot)||
   !cell.quality||typeof cell.quality.usable!=='boolean'||typeof cell.quality.reason!=='string'||!cell.quality.reason.length||
   cell.quality.reason.length>256||!Number.isFinite(cell.quality.sharpness)||cell.quality.sharpness<0||
   !(cell.art instanceof Uint8Array)||cell.art.length!==648||!(cell.feature instanceof Uint8Array)||cell.feature.length!==3240||
   !validBox(cell.content)||!validBox(cell.preview)||!unit(cell.alignment)||
   typeof cell.intact!=='boolean'||typeof cell.complete!=='boolean'||typeof cell.labelVisible!=='boolean'||
   !Array.isArray(cell.borderSides)||cell.borderSides.length!==4||!cell.borderSides.every(unit)||!identifier(cell.pixelKey)||
   Object.hasOwn(cell,'fieldRevision')&&!identifier(cell.fieldRevision)||
   Object.hasOwn(cell,'occlusionAdvisory')&&cell.occlusionAdvisory!==true||
   Object.hasOwn(cell,'preBorder')&&(!cell.preBorder||typeof cell.preBorder!=='object'||
    Object.keys(cell.preBorder).length!==2||!Object.hasOwn(cell.preBorder,'kind')||!Object.hasOwn(cell.preBorder,'reason')||
    !['usable','empty','clipped','name-hidden','tooltip','moving','invalid','uncertain'].includes(cell.preBorder.kind)||
    typeof cell.preBorder.reason!=='string'||cell.preBorder.reason.length>256))
   throw Error('잘못된 생략 카드 메타데이터');
  seenSlots.add(cell.slot);
  const repeated=!cell.quality.usable&&seenReasons.has(cell.quality.reason);
  if(!cell.quality.usable)seenReasons.add(cell.quality.reason);
  if(cell.cropState==='omitted-rejected'){
   const {originalWidth:w,originalHeight:h}=cell;
   if(!repeated||cell.bitmap||cell.pixels||cell.previewBitmap||!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||
    w!<1||h!<1||w!*h!*4>64*1024*1024)throw Error('잘못된 생략 카드 픽셀');
   omitted++;omittedRgbaBytes+=w!*h!*4;
  }else {
   if(cell.cropState!=='materialized'||cell.originalWidth!==undefined||cell.originalHeight!==undefined||
    (!!cell.bitmap===!!cell.pixels))throw Error('카드 전송 상태 누락');
   kept++;
  }
 }
 return {omitted,kept,omittedRgbaBytes};
}
export type AcquisitionTiming={freezeMs:number;roundTripMs:number;workerMs:number;detectMs:number;cropMs:number;materializeMs:number;
 profile?:AcquisitionProfile;
 detectorProfile?:DetectorProfile;
 preparedHashMs?:number;targetPaintMs?:number;inputBytes?:number;rasterReadbackMs?:number;rasterHashMs?:number;
 gridReadbacksSaved?:number;cropReadbacksSaved?:number;localPixelCrops?:number};
// These IDs identify processing uses (legacy: also an exact archive frame).
// Canonical pixels have a separate source ID, including when analysis is reused.
export type Acquisition={frameId:number;cells:Cell[];layout:Layout|null;timing?:AcquisitionTiming;
 pixelProof?:AcquisitionPixelProof;rasterReceipt?:MeasuredSourceRasterReceipt;
 /** Dev-only measured equality; never card identity or observation evidence. */
 experimentalExactReceipts?:readonly ExperimentalExactReceipt[];experimentalExactUnavailable?:number;experimentalExactUnsupported?:boolean;
 /** Development-only Worker assertion and delivery-time Canvas comparison. */
 experimentalCropProof?:PreparedCropDiagnostic};
export type PreparedAcquisition=Acquisition&{rasterReceipt:MeasuredSourceRasterReceipt};
export type RejectedTransportAcquisition=Omit<Acquisition,'cells'>&{cells:RejectedTransportCell[];
 rejectedTransport:{omitted:number;kept:number;omittedRgbaBytes:number}};
type FallbackDetector=Pick<Awaited<ReturnType<typeof createDetector>>,'detect'|'dispose'>;

/** One frozen frame in flight. No unbounded full-resolution frame queue.
 * localCropPixels opts only ordinary Canvas requests into local owned crops;
 * native/prepared requests retain their existing transport and receipt paths. */
export function createAcquisitionClient(signal:AbortSignal,options:{pixelTransport?:boolean;pixelProof?:boolean;measuredRasterReuse?:boolean;localCropPixels?:boolean;experimentalExactReceipts?:boolean;experimentalCropProof?:boolean;moveReuseProfile?:boolean;experimentalRejectedTransport?:boolean}={},
 platform:{detectorFactory?:()=>Promise<FallbackDetector>}={}) {
 if(options.moveReuseProfile!==undefined&&typeof options.moveReuseProfile!=='boolean')throw Error('Invalid move profile option');
 if(options.experimentalRejectedTransport!==undefined&&typeof options.experimentalRejectedTransport!=='boolean')throw Error('Invalid rejected transport option');
 if(options.experimentalRejectedTransport&&(!import.meta.env?.DEV||options.localCropPixels||options.pixelProof||options.pixelTransport||options.experimentalExactReceipts||options.experimentalCropProof||options.moveReuseProfile))throw Error('Unsupported rejected transport experiment');
 if(options.moveReuseProfile&&(!import.meta.env?.DEV||options.experimentalCropProof||options.experimentalExactReceipts||options.localCropPixels||options.pixelProof||options.pixelTransport))throw Error('Unsupported move profile input');
 if(options.measuredRasterReuse!==undefined&&typeof options.measuredRasterReuse!=='boolean')throw Error('Invalid measured raster reuse option');
 if(options.localCropPixels!==undefined&&typeof options.localCropPixels!=='boolean')throw Error('Invalid local crop pixels option');
 if(options.experimentalExactReceipts!==undefined&&typeof options.experimentalExactReceipts!=='boolean')throw Error('Invalid experimental receipt option');
 if(options.experimentalCropProof!==undefined&&typeof options.experimentalCropProof!=='boolean')throw Error('Invalid experimental crop proof option');
 if(options.experimentalExactReceipts&&(!import.meta.env?.DEV||options.localCropPixels))throw Error('Experimental receipts require a supported development capture');
 if(options.experimentalCropProof&&(!import.meta.env?.DEV||options.pixelTransport!==true||options.experimentalExactReceipts||options.localCropPixels))throw Error('Experimental crop proof requires development prepared pixel transport');
 const cropProofRequested=options.experimentalCropProof===true;
 const cropCanvasHasher=cropProofRequested?createPreparedCanvasHasher():undefined;
 const receiptBridge=options.experimentalExactReceipts?createExperimentalAcquisitionReceiptBridge():undefined;
 const measuredRasterReuse=options.measuredRasterReuse;
 const worker=typeof OffscreenCanvas==='undefined'||typeof createImageBitmap==='undefined' ? undefined :
  new Worker(new URL('./acquisition-worker.ts',import.meta.url),{type:'module'});
 if(options.moveReuseProfile&&!worker)throw Error('Move profile requires acquisition worker');
 let closed=false, nextId=0, freezing=false,preparedBusy=false;
 let obstructionCallback:((event:FrameObstructionProbeEvent)=>void)|undefined;
 let pending:{id:number;sentAt:number;freezeMs:number;target?:HTMLCanvasElement;expectedRaster?:ExpectedRasterReceipt;
  expectedSize?:{width:number;height:number};receiptRequested?:boolean;
  rejectedTransportRequested?:boolean;
  proofRequired?:boolean;preparedHashMs?:number;targetPaintMs?:number;inputBytes?:number;
  resolve:(result:Acquisition)=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let preparing:Promise<void>|undefined;
 let readyJob:{resolve:()=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let fallback:FallbackDetector|undefined;
 let recordingAttached=false;
 let recordingIssueCallback:((reason:string)=>void)|undefined;
 let recordingEndJob:{resolve:()=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 let preparedCancel:((reason:unknown)=>void)|undefined;
 function rejectRecordingEnd(error:unknown){if(recordingEndJob){const job=recordingEndJob;recordingEndJob=undefined;clearTimeout(job.timer);job.reject(error);}recordingIssueCallback=undefined;}
 function dispose(){closed=true;receiptBridge?.close();worker?.terminate();fallback?.dispose();fallback=undefined;const error=new DOMException('Stopped','AbortError');rejectRecordingEnd(error);preparedCancel?.(error);if(readyJob){clearTimeout(readyJob.timer);readyJob.reject(error);readyJob=undefined;}if(pending){clearTimeout(pending.timer);pending.reject(error);pending=undefined;}signal.removeEventListener('abort',dispose);}
 function failClosed(error:unknown){closed=true;receiptBridge?.close();worker?.terminate();fallback?.dispose();fallback=undefined;
  rejectRecordingEnd(error);
  preparedCancel?.(error);
  if(readyJob){clearTimeout(readyJob.timer);readyJob.reject(error);readyJob=undefined;}
  if(pending){clearTimeout(pending.timer);pending.reject(error);pending=undefined;}signal.removeEventListener('abort',dispose);}
 signal.addEventListener('abort',dispose,{once:true});
 if(signal.aborted)dispose();
 if(worker){
  worker.onerror=event=>failClosed(new Error(event.message||'카드 수집 Worker 오류'));
  worker.onmessage=async(event:MessageEvent<{id:number;obstructionProbe?:FrameObstructionProbeEvent;recordingIssue?:string;recordingEnded?:boolean;cells?:WireCell[];patches?:{box:Box;bitmap:ImageBitmap}[];layout?:Layout|null;
   timing?:Pick<AcquisitionTiming,'workerMs'|'detectMs'|'cropMs'|'rasterReadbackMs'|'rasterHashMs'|'gridReadbacksSaved'|'cropReadbacksSaved'|'localPixelCrops'|'profile'|'detectorProfile'>;
   pixelProof?:unknown;rasterReceipt?:unknown;experimentalExactReceipts?:unknown;experimentalCropProof?:unknown;ready?:boolean;error?:string}>)=>{
   if(event.data.obstructionProbe){try{obstructionCallback?.(event.data.obstructionProbe);}catch{/* Optional diagnostic never interrupts collection. */}return;}
   if(typeof event.data.recordingIssue==='string'){try{recordingIssueCallback?.(event.data.recordingIssue.slice(0,2000));}catch{/* Recording diagnostics never interrupt collection. */}return;}
   if(event.data.recordingEnded){if(recordingEndJob){const job=recordingEndJob;recordingEndJob=undefined;clearTimeout(job.timer);recordingIssueCallback=undefined;job.resolve();}return;}
   const {id,cells,patches,error}=event.data;
   const closeImages=()=>{if(Array.isArray(cells))for(const cell of cells){try{cell?.bitmap?.close();}catch{/* Late ownership cleanup. */}try{cell?.previewBitmap?.close();}catch{/* Late ownership cleanup. */}}
    if(Array.isArray(patches))for(const patch of patches)try{patch?.bitmap?.close();}catch{/* Late ownership cleanup. */}};
   if(event.data.ready){if(readyJob){const job=readyJob;readyJob=undefined;clearTimeout(job.timer);if(error)job.reject(new Error(error));else job.resolve();}return;}
   if(!pending||pending.id!==id){closeImages();return;}
   const job=pending;pending=undefined;clearTimeout(job.timer);
   if(error){closeImages();const failure=new Error(error);if(job.receiptRequested||job.rejectedTransportRequested)failClosed(failure);job.reject(failure);return;}
   const result:(Cell|RejectedTransportCell)[]=[];
   const receivedAt=performance.now();
   try {
    const rasterReceipt=job.expectedRaster?validateMeasuredSourceRasterReceipt(event.data.rasterReceipt,job.expectedRaster):undefined;
    if(!job.expectedRaster&&event.data.rasterReceipt!==undefined)throw Error('요청하지 않은 원본 래스터 영수증');
    const pixelProof=event.data.pixelProof===undefined?undefined:parseAcquisitionPixelProof(event.data.pixelProof);
    if(job.proofRequired&&!pixelProof)throw Error('요청한 수집 픽셀 증명 누락');
    if(job.expectedRaster&&pixelProof&&pixelProof.hash!==job.expectedRaster.hash)throw Error('수집 픽셀 증명 해시 불일치');
    if(!Array.isArray(cells)||cells.length>40)throw Error('잘못된 수집 카드 응답');
    if(job.rejectedTransportRequested&&event.data.layout&&!Array.isArray(event.data.layout.cells))throw Error('잘못된 생략 카드 레이아웃');
    const reduced=job.rejectedTransportRequested?validateRejectedTransport(cells!,event.data.layout?.cells?.length??0):undefined;
    if(job.target){
     const context=job.target.getContext('2d',{willReadFrequently:true})!;
     context.clearRect(0,0,job.target.width,job.target.height);
     for(const patch of patches??[])context.drawImage(patch.bitmap,patch.box.x,patch.box.y);
    }
    for(const {bitmap,pixels,previewBitmap,cropState,originalWidth,originalHeight,...cell} of cells!){
     if(job.rejectedTransportRequested&&cropState==='omitted-rejected'){
      result.push({...cell,cropState,image:null,originalWidth:originalWidth!,originalHeight:originalHeight!});continue;
     }else if(!job.rejectedTransportRequested&&(cropState!==undefined||originalWidth!==undefined||originalHeight!==undefined))
      throw Error('요청하지 않은 생략 카드');
     const raster=pixels??bitmap;
     if(!raster)throw new Error('카드 픽셀 데이터 누락');
     const image=document.createElement('canvas');image.width=raster.width;image.height=raster.height;
     const context=image.getContext('2d',{willReadFrequently:true})!;
     if(pixels)paintPixelRaster(context,pixels);
     else context.drawImage(bitmap!,0,0);
     const entry:Cell & {cropState?:'materialized'}={...cell,image,...(job.rejectedTransportRequested?{cropState:'materialized' as const}:{})};
     result.push(entry as Cell|RejectedTransportCell);
     if(previewBitmap){
      const previewImage=document.createElement('canvas');entry.previewImage=previewImage;
      previewImage.width=previewBitmap.width;previewImage.height=previewBitmap.height;
      previewImage.getContext('2d',{willReadFrequently:true})!.drawImage(previewBitmap,0,0);
     }
    }
    if(!receiptBridge&&event.data.experimentalExactReceipts!==undefined)throw Error('요청하지 않은 실험 영수증');
    let experimentalExactReceipts:readonly ExperimentalExactReceipt[]|undefined,experimentalExactUnavailable:number|undefined,experimentalExactUnsupported:boolean|undefined;
    if(job.receiptRequested&&receiptBridge){
     if(!Array.isArray(event.data.experimentalExactReceipts))throw Error('실험 영수증 누락');
     if(event.data.layout){
      if(!job.expectedSize)throw Error('실험 수집 크기 누락');
      const checked=receiptBridge.accept(id,event.data.layout,job.expectedSize.width,job.expectedSize.height,result.map(cell=>cell.slot),event.data.experimentalExactReceipts);
      experimentalExactReceipts=checked.edges;experimentalExactUnavailable=checked.unavailable;experimentalExactUnsupported=checked.unsupported;
     }else if(event.data.experimentalExactReceipts.length)throw Error('레이아웃 없는 실험 영수증');
     else experimentalExactReceipts=[];
    }
    let experimentalCropProof:PreparedCropDiagnostic|undefined;
    if(cropProofRequested&&job.expectedRaster){
     experimentalCropProof=await preparedCropDiagnostic(event.data.experimentalCropProof,rasterReceipt,result as Cell[],signal,cropCanvasHasher);
     signal.throwIfAborted();if(closed)throw Error('Acquisition closed');
    }
    job.resolve({frameId:id,cells:result as Cell[],layout:event.data.layout??null,...(pixelProof?{pixelProof}:{}),...(rasterReceipt?{rasterReceipt}:{}),
     ...(reduced?{rejectedTransport:reduced}:{}),
     ...(experimentalCropProof?{experimentalCropProof}:{}),
     ...(experimentalExactReceipts?{experimentalExactReceipts,experimentalExactUnavailable:experimentalExactUnavailable??0,experimentalExactUnsupported:experimentalExactUnsupported??false}:{}),
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
   }catch(error){result.forEach(c=>{if(c.image)c.image.width=0;if(c.previewImage)c.previewImage.width=0;});if(job.receiptRequested||job.rejectedTransportRequested)failClosed(error);job.reject(error);}
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
 async function acquire(frame:HTMLCanvasElement,layout?:Layout,nativeSource?:HTMLVideoElement|VideoFrame,time=0,recordOnly=false,phase:'input'|'recovery'='input',rejectedTransport=false):Promise<Acquisition>{
  signal.throwIfAborted();if(closed)throw new Error('카드 수집 종료');
  if(rejectedTransport&&(!import.meta.env?.DEV||!options.experimentalRejectedTransport||!worker||recordingAttached||recordOnly||phase!=='input'||!!nativeSource))
   throw Error('Unsupported rejected transport request');
  if(receiptBridge&&recordOnly)throw Error('실험 영수증은 기록 전용 프레임과 함께 사용할 수 없습니다.');
  if(nativeSource&&!worker)throw new Error('직접 프레임 수집을 지원하지 않습니다.');
  if(pending||freezing)throw new Error('동시 수집 요청');
  if(!worker){if(receiptBridge)throw Error('실험 영수증은 수집 Worker가 필요합니다.');freezing=true;try{if(!layout)await ready();signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');
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
    ...(rejectedTransport?{rejectedTransportRequested:true}:{}),
    ...(receiptBridge&&!recordOnly?{receiptRequested:true,expectedSize:{width:'displayWidth' in bitmap?bitmap.displayWidth:bitmap.width,height:'displayHeight' in bitmap?bitmap.displayHeight:bitmap.height}}:{}),
    proofRequired:options.pixelProof===true&&!recordOnly,resolve,reject,timer};
   try{worker.postMessage({id,bitmap,layout,time,recordOnly,phase,patches:!!nativeSource,pixelTransport:options.pixelTransport===true,
    ...(rejectedTransport?{experimentalRejectedTransport:true}:{}),
    ...(options.moveReuseProfile?{moveReuseProfile:true}:{}),
    ...(!nativeSource&&!recordOnly&&options.localCropPixels?{localCropPixels:true}:{}),
    ...(options.pixelProof?{pixelProof:true}:{}),...(receiptBridge&&!recordOnly?{experimentalExactReceipts:true}:{}),...(measuredRasterReuse===undefined?{}:{measuredRasterReuse})},[bitmap]);}
   catch(error){clearTimeout(timer);pending=undefined;bitmap.close();reject(error);}
  });
 }
 /** Consumes the one owned full RGBA raster. Neither route rereads a video or
  * converts a VideoFrame; the returned receipt measures the detector canvas. */
 async function detectPrepared(input:PreparedAcquisitionInput,target?:HTMLCanvasElement):Promise<PreparedAcquisition>{
  signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');
  if(receiptBridge&&!worker)throw Error('실험 영수증은 수집 Worker가 필요합니다.');
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
          ...(receiptBridge?{receiptRequested:true,expectedSize:{width:checked.width,height:checked.height}}:{}),
          proofRequired:options.pixelProof===true,resolve,reject,timer};
        try{worker.postMessage({kind:'prepared',id,prepared:{pixels,width:checked.width,height:checked.height,binding:checked.binding},
          pixelTransport:cropProofRequested||options.pixelTransport===true,...(options.pixelProof?{pixelProof:true}:{}),...(receiptBridge?{experimentalExactReceipts:true}:{}),
          ...(cropProofRequested?{experimentalCropProof:true}:{}),
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
      ...(cropProofRequested?{experimentalCropProof:{status:'unavailable' as const,reason:'prepared worker unavailable',elapsedMs:0}}:{}),
      ...(options.pixelProof?{pixelProof:parseAcquisitionPixelProof({hash:actualHash,sample:Array.from(actual.subarray(0,32))})}:{}),
      timing:{freezeMs,roundTripMs:finished-started,workerMs:0,detectMs:cropAt-detectAt,cropMs:finished-cropAt,materializeMs:0,
        preparedHashMs,targetPaintMs,inputBytes:pixels.byteLength,rasterReadbackMs,rasterHashMs}};
  })()]);}
  finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);if(preparedCancel===cancel)preparedCancel=undefined;
    freezing=false;preparedBusy=false;if(internal){internal.width=0;internal.height=0;}}
 }
 return {dispose,ready,supportsNative:!!worker&&typeof VideoFrame!=='undefined',
  ...(options.experimentalRejectedTransport?{detectAndAcquireReduced:(frame:HTMLCanvasElement,time=0)=>
    acquire(frame,undefined,undefined,time,false,'input',true) as unknown as Promise<RejectedTransportAcquisition>}:{}),
  ...(receiptBridge?{experimentalAcquire:(frame:HTMLCanvasElement,layout:Layout)=>acquire(frame,layout)}:{}),
  configureObstructionProbe:(callback?:((event:FrameObstructionProbeEvent)=>void),probeOptions:{hashRoi?:boolean}={})=>{
   if(probeOptions.hashRoi!==undefined&&typeof probeOptions.hashRoi!=='boolean')throw Error('Invalid ROI hash option');
   obstructionCallback=import.meta.env?.DEV?callback:undefined;
   if(!worker)return false;
   try{worker.postMessage({kind:'obstruction-probe',probeEnabled:!!obstructionCallback,probeHashRoi:!!obstructionCallback&&probeOptions.hashRoi===true});return !!obstructionCallback;}catch{obstructionCallback=undefined;return false;}
  },
  reserveFrameId:()=>{signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');if(pending||freezing)throw Error('동시 수집은 허용되지 않습니다.');return ++nextId;},
  startRecording:(port:MessagePort,onIssue?:(reason:string)=>void)=>{signal.throwIfAborted();if(closed)throw Error('카드 수집 종료');
    if(recordingAttached||recordingEndJob)throw Error('입력 기록이 이미 연결되었거나 종료 중입니다.');
    if(preparedBusy)throw Error('준비된 원본 수집 중에는 이전 기록 포트를 연결할 수 없습니다.');
    if(pending||freezing||readyJob)throw Error('카드 수집 또는 준비 중에는 기록 포트를 연결할 수 없습니다.');
    if(!worker)throw Error('무손실 입력 기록 Worker 미지원');
    // A failed transfer must not install a callback for an unattached port.
    // Worker replies are delivered asynchronously, after this assignment.
    worker.postMessage({kind:'record',port},[port]);recordingIssueCallback=onIssue;recordingAttached=true;},
  stopRecording:async()=>{if(recordingAttached){recordingAttached=false;await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>failClosed(Error('입력 기록 종료 응답 없음')),1000);
   recordingEndJob={resolve,reject,timer};
   try{worker!.postMessage({kind:'record-end'});}catch(error){failClosed(error);}
  });}},
  recordOnly:async(frame:HTMLCanvasElement,time:number):Promise<number|undefined>=>{if(recordingAttached)return (await acquire(frame,undefined,undefined,time,true)).frameId;},
  detectNative:(source:HTMLVideoElement|VideoFrame,target:HTMLCanvasElement,time=0)=>acquire(target,undefined,source,time),
  detectPrepared,
  detectAndAcquire:(frame:HTMLCanvasElement,time=0,phase:'input'|'recovery'='input')=>acquire(frame,undefined,undefined,time,false,phase),
  acquire:async(frame:HTMLCanvasElement,layout:Layout)=>(await acquire(frame,layout)).cells};
}
