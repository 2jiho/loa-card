import { createCardAcquirer,createExperimentalReceiptAcquirer,createMeasuredMoveAcquirer } from './card-acquisition';
import { createDetector } from './detector';
import type { Layout, DetectorPlatform } from './detector';
import { metadataRegions } from './metadata-regions';
import { readPixelRaster } from './pixel-raster';
import {pixelHash} from '../reproduction/recording-frame-integrity';
import {acquisitionProfile} from './acquisition-profile';
import {recordDetectorStage,type DetectorProfile} from './detector-profile';
import {parsePreparedAcquisitionInput,parseMeasuredSourceRasterReceipt} from './source-raster-receipt';
import type {PreparedAcquisitionInput} from './source-raster-receipt';
import {createPreparedCropProver,type PreparedCropProof} from './prepared-crop-proof';
const acquire=createCardAcquirer((w,h)=>new OffscreenCanvas(w,h),true);
let measuredAcquire:ReturnType<typeof createMeasuredMoveAcquirer<OffscreenCanvas>>|undefined;
let moveProfiling:boolean|undefined;
// One outstanding experimental hash per Worker, including timed-out hashes.
// Allocate the diagnostic only after an explicit development request.
let cropProver:ReturnType<typeof createPreparedCropProver>|undefined;
// Development diagnostics only: never used to resolve names or completion.
let receiptAcquirer:ReturnType<typeof createExperimentalReceiptAcquirer<OffscreenCanvas>>|undefined;
const frame=new OffscreenCanvas(1,1);
const context=frame.getContext('2d',{willReadFrequently:true})!;
let detector:ReturnType<typeof createDetector>|undefined;
let recording:MessagePort|undefined,credits=3,inFlightBytes=0,peakInFlightBytes=0;
let recordingIssueReported=false;
function reportRecordingIssue(){
 if(recordingIssueReported)return;recordingIssueReported=true;
 try{self.postMessage({recordingIssue:'입력 프레임 기록 채널 전송 실패'});}catch{/* Diagnostics must not interrupt acquisition. */}
}
let acquiring=false;
let detectorWork:DetectorProfile={};
// DEV-only, best-effort experiment. One ROI and one analysis may be in
// flight; worker errors, missed samples and diagnostics never affect capture.
let obstructionWorker:Worker|undefined,obstructionBusy=false,obstructionLast=-Infinity;
let obstructionGeneration=0,obstructionHashRoi=false;
function configureObstructionProbe(enabled:boolean,hashRoi:boolean){
 obstructionGeneration++;obstructionWorker?.terminate();obstructionWorker=undefined;obstructionBusy=false;obstructionLast=-Infinity;
 obstructionHashRoi=enabled&&hashRoi;
 if(!import.meta.env?.DEV||!enabled)return;
 const generation=obstructionGeneration;
 try{
  const worker=new Worker(new URL('./frame-obstruction-worker.ts',import.meta.url),{type:'module'});obstructionWorker=worker;
  worker.onmessage=e=>{if(generation!==obstructionGeneration)return;obstructionBusy=false;self.postMessage({obstructionProbe:{kind:'result',...e.data}});};
  worker.onerror=event=>{if(generation!==obstructionGeneration)return;obstructionBusy=false;worker.terminate();obstructionWorker=undefined;
    self.postMessage({obstructionProbe:{kind:'error',reason:String(event.message||'worker-error').slice(0,300)}});};
 }catch(error){self.postMessage({obstructionProbe:{kind:'error',reason:String(error).slice(0,300)}});}
}
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
self.onmessage=async(event:MessageEvent<{kind?:'prepare'|'record'|'record-end'|'prepared'|'obstruction-probe';probeEnabled?:boolean;probeHashRoi?:boolean;port?:MessagePort;time?:number;recordOnly?:boolean;phase?:'input'|'recovery';id:number;bitmap?:ImageBitmap|VideoFrame;prepared?:PreparedAcquisitionInput;layout?:Layout;patches?:boolean;pixelTransport?:boolean;pixelProof?:boolean;measuredRasterReuse?:boolean;localCropPixels?:boolean;experimentalExactReceipts?:boolean;experimentalCropProof?:boolean;moveReuseProfile?:boolean;experimentalRejectedTransport?:boolean}>)=>{
 const {id,bitmap}=event.data;
 if(event.data.kind==='obstruction-probe'){configureObstructionProbe(event.data.probeEnabled===true,event.data.probeHashRoi===true);return;}
 if(event.data.kind==='record'){
  if(acquiring){event.data.port?.close();self.postMessage({id,error:'수집 중에는 이전 기록 포트를 연결할 수 없습니다.'});return;}
  recording=event.data.port;credits=3;inFlightBytes=peakInFlightBytes=0;recordingIssueReported=false;
  if(recording){recording.onmessage=e=>{credits=Math.min(3,credits+1);inFlightBytes=Math.max(0,inFlightBytes-(e.data.bytes??0));};recording.start();}return;
 }
 if(event.data.kind==='record-end'){
  try{recording?.postMessage({kind:'end',peakInFlightBytes});}catch{reportRecordingIssue();}
  finally{try{recording?.close();}catch{/* Ignore cleanup failure. */}recording=undefined;self.postMessage({recordingEnded:true});}return;
 }
 if(event.data.kind==='prepare') {
  try{await prepare();self.postMessage({ready:true});}
  catch(error){self.postMessage({ready:true,error:String(error)});}
  return;
 }
 if(acquiring){bitmap?.close();self.postMessage({id,error:'동시 수집 요청'});return;}
 acquiring=true;
 const transfers:ImageBitmap[]=[];
 const pixelTransfers:ArrayBuffer[]=[];
 const temporaryCanvases:OffscreenCanvas[]=[];
 let forwarded=false;
 try {
  const started=performance.now();
  if(event.data.moveReuseProfile!==undefined&&typeof event.data.moveReuseProfile!=='boolean')throw Error('Invalid move profile option');
  const requestedMove=event.data.moveReuseProfile===true;
  if(requestedMove&&(!import.meta.env?.DEV||event.data.kind==='prepared'||event.data.recordOnly||recording||event.data.localCropPixels||event.data.experimentalExactReceipts))throw Error('Unsupported move profile input');
  if(moveProfiling!==undefined&&moveProfiling!==requestedMove)throw Error('Move profile cannot change during an acquisition session');
  moveProfiling=requestedMove;
  const cardAcquirer=requestedMove?(measuredAcquire??=createMeasuredMoveAcquirer((w,h)=>new OffscreenCanvas(w,h))):acquire;
  if(event.data.experimentalExactReceipts!==undefined&&typeof event.data.experimentalExactReceipts!=='boolean')throw Error('잘못된 실험 영수증 옵션');
  const receiptExperiment=import.meta.env?.DEV&&event.data.experimentalExactReceipts===true;
  if(event.data.experimentalExactReceipts&&!receiptExperiment)throw Error('실험 영수증은 개발 환경에서만 사용할 수 있습니다.');
  if(receiptExperiment&&event.data.localCropPixels)throw Error('실험 영수증과 로컬 카드 픽셀은 함께 사용할 수 없습니다.');
  if(!receiptExperiment&&receiptAcquirer){receiptAcquirer.close();receiptAcquirer=undefined;}
  if(event.data.measuredRasterReuse!==undefined&&typeof event.data.measuredRasterReuse!=='boolean')
    throw Error('잘못된 측정 픽셀 재사용 옵션');
  if(event.data.localCropPixels!==undefined&&typeof event.data.localCropPixels!=='boolean')
    throw Error('잘못된 로컬 카드 픽셀 옵션');
  if(event.data.experimentalCropProof!==undefined&&typeof event.data.experimentalCropProof!=='boolean')
    throw Error('잘못된 실험 크롭 검증 옵션');
  if(event.data.experimentalRejectedTransport!==undefined&&typeof event.data.experimentalRejectedTransport!=='boolean')
    throw Error('Invalid rejected transport option');
  const rejectedTransport=event.data.experimentalRejectedTransport===true;
  if(rejectedTransport&&(!import.meta.env?.DEV||event.data.kind==='prepared'||event.data.recordOnly||event.data.phase==='recovery'||
    !!recording||event.data.patches||event.data.pixelTransport||event.data.pixelProof||event.data.localCropPixels||receiptExperiment||
    event.data.experimentalCropProof||event.data.moveReuseProfile))throw Error('Unsupported rejected transport input');
  const prepared=event.data.kind==='prepared'?parsePreparedAcquisitionInput(event.data.prepared):undefined;
  const cropProofExperiment=event.data.experimentalCropProof===true;
  if(cropProofExperiment&&(!import.meta.env?.DEV||!prepared||event.data.pixelTransport!==true||receiptExperiment))
    throw Error('크롭 검증은 준비된 픽셀 수집 개발 실험에서만 사용할 수 있습니다.');
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
    }catch{try{recording.postMessage({kind:'gap',id,time:event.data.time??0});}catch{reportRecordingIssue();}}
   }else try{recording.postMessage({kind:'gap',id,time:event.data.time??0});}catch{reportRecordingIssue();}
  }
  if(event.data.recordOnly){self.postMessage({id,cells:[],layout:null});return;}
  const detectStarted=performance.now();
  detectorWork={};
  const layout=event.data.layout??(await prepare()).detect(frame);
  const cropStarted=performance.now();
  const reuse=!receiptExperiment&&!event.data.localCropPixels&&proofPixels&&event.data.measuredRasterReuse!==false?{
    measuredRaster:{width,height,data:proofPixels},ownCardPixels:!!event.data.pixelTransport,
  }:undefined;
  const experimentResult=receiptExperiment&&layout?(receiptAcquirer??=createExperimentalReceiptAcquirer((w,h)=>new OffscreenCanvas(w,h))).acquire(id,frame,layout):undefined;
  const rawCells=experimentResult?.cells??(layout?(event.data.localCropPixels?cardAcquirer.localPixels(frame,layout):cardAcquirer(frame,layout,reuse)):[]);
  if(rejectedTransport)for(const cell of rawCells)if(cell.image)temporaryCanvases.push(cell.image);
  let omitted=new Set<number>();
  if(rejectedTransport){
   // Only the DEV bundle can load this planning module. Planning happens
   // before any ownership transfer; missing pixels/aliases fail the request.
   const {planRejectedRasterTransport}=await import('./rejected-raster-plan');
   const plan=planRejectedRasterTransport(rawCells.map(cell=>{
    if(!cell.image)throw Error('Rejected transport requires canvas crops');
    return {slot:cell.slot,quality:cell.quality,raster:cell.image,metadata:null};
   }),{preserveAll:false});
   omitted=new Set(plan.filter(cell=>cell.kind==='omitted-rejected').map(cell=>cell.slot));
  }
  const cells=rawCells.map(({image,ownedPixels,...cell})=>{
   if(omitted.has(cell.slot)){
    if(!image)throw Error('Rejected transport crop missing');
    const originalWidth=image.width,originalHeight=image.height;image.width=0;image.height=0;
    return {...cell,cropState:'omitted-rejected' as const,originalWidth,originalHeight};
   }
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
   return {...cell,bitmap:raster,pixels,previewBitmap,...(rejectedTransport?{cropState:'materialized' as const}:{})};
  });
  if(obstructionWorker&&!layout&&event.data.phase!=='recovery'){
   try{self.postMessage({obstructionProbe:{kind:'skipped',id,time:prepared?.binding.captureTime??event.data.time??0,reason:'no-layout'}});}catch{/* Diagnostic failure cannot stop acquisition. */}
  }
  if(obstructionWorker&&layout&&event.data.phase!=='recovery'){
   const time=prepared?.binding.captureTime??event.data.time??0,now=performance.now();
   const skip=(reason:string)=>{try{self.postMessage({obstructionProbe:{kind:'skipped',id,time,reason}});}catch{/* Diagnostic failure cannot stop acquisition. */}};
   if(obstructionBusy)skip('busy');
   else if(now-obstructionLast<750)skip('cadence');
   else try{
    const boxes=layout.cells;
    if(boxes.length!==cells.length||boxes.length<2||boxes.length>40||boxes.some(b=>![b.x,b.y,b.width,b.height].every(Number.isSafeInteger)||b.x<0||b.y<0||b.x+b.width>width||b.y+b.height>height))skip('unsupported-geometry');
    else{
     const left=Math.min(...boxes.map(b=>b.x)),top=Math.min(...boxes.map(b=>b.y));
     const right=Math.max(...boxes.map(b=>b.x+b.width)),bottom=Math.max(...boxes.map(b=>b.y+b.height));
     const roiWidth=right-left,roiHeight=bottom-top,bytes=roiWidth*roiHeight*4;
     if(bytes>8*1024*1024)skip('roi-limit');
     else{
      const start=performance.now(),pixels=context.getImageData(left,top,roiWidth,roiHeight).data,readbackMs=performance.now()-start;
      const probeCells=boxes.map((box,index)=>({x:box.x-left,y:box.y-top,width:box.width,height:box.height,intact:cells[index].intact&&cells[index].complete}));
      obstructionBusy=true;obstructionLast=now;
      obstructionWorker.postMessage({id,pixels,width:roiWidth,height:roiHeight,cells:probeCells,time,roi:{x:left,y:top,width:roiWidth,height:roiHeight},readbackMs,readbackBytes:bytes,hashRoi:obstructionHashRoi},[pixels.buffer]);
      try{self.postMessage({obstructionProbe:{kind:'submitted',id,time,roi:{x:left,y:top,width:roiWidth,height:roiHeight},readbackMs,readbackBytes:bytes,hashRequested:obstructionHashRoi}});}catch{/* Do not release the in-flight credit. */}
     }
    }
   }catch(error){obstructionBusy=false;skip(`capture-error:${String(error).slice(0,200)}`);}
  }
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
  // Worker-local, bounded diagnostic only. The emitted pixels below are the
  // exact arrays compared here; a main-thread canvas/OCR call is separate.
  let experimentalCropProof:PreparedCropProof|undefined;
  if(cropProofExperiment&&rasterReceipt&&proofPixels){
    try{experimentalCropProof=await (cropProver??=createPreparedCropProver()).measure(rasterReceipt,proofPixels,cells);}
    catch{
      // Optional diagnostics must not reject real captured card pixels. An
      // unexpected failure reports no usable proof, rather than claiming a
      // clean frame or interrupting the normal acquisition response.
      experimentalCropProof={version:1,scope:'prepared-worker-crop',frame:rasterReceipt,total:cells.length,checked:0,
        unsupported:0,mismatch:0,overBudget:0,hashFailed:cells.length,bytesHashed:0,frameCheck:'failed',frameBytesHashed:0,
        timedOut:false,hashBusy:false,crops:[]};
    }
  }
  const reuseStats=layout?(receiptExperiment?receiptAcquirer?.stats():cardAcquirer.stats()):undefined;
  self.postMessage({id,cells,layout,patches,pixelProof,...(rasterReceipt?{rasterReceipt}:{}),
    ...(experimentalCropProof?{experimentalCropProof}:{}),
    ...(receiptExperiment?{experimentalExactReceipts:experimentResult?.receipts??[]}:{}),
    timing:{workerMs:performance.now()-started,detectMs:cropStarted-detectStarted,cropMs:cropFinished-cropStarted,
      ...(Object.keys(detectorWork).length?{detectorProfile:detectorWork}:{}),
      ...(reuseStats?{profile:acquisitionProfile(reuseStats)}:{}),
      ...(reuse?{gridReadbacksSaved:reuseStats?.gridReadbacksSaved??0,cropReadbacksSaved:reuseStats?.cropReadbacksSaved??0}:{}),
      ...(event.data.localCropPixels?{localPixelCrops:reuseStats?.localPixelCrops??0}:{}),
      ...(proofPixels?{rasterReadbackMs,rasterHashMs}:{})}}, {transfer:[...transfers,...pixelTransfers]});
 }catch(error){receiptAcquirer?.close();receiptAcquirer=undefined;for(const raster of transfers)raster.close();self.postMessage({id,error:String(error)});}
 finally{for(const canvas of temporaryCanvases){canvas.width=0;canvas.height=0;}acquiring=false;if(!forwarded)bitmap?.close();}
};
