import { createCardAcquirer } from './card-acquisition';
import { createDetector } from './detector';
import type { Layout, DetectorPlatform } from './detector';
import { metadataRegions } from './metadata-regions';
import { readPixelRaster } from './pixel-raster';
const acquire=createCardAcquirer((w,h)=>new OffscreenCanvas(w,h),true);
const frame=new OffscreenCanvas(1,1);
const context=frame.getContext('2d',{willReadFrequently:true})!;
let detector:ReturnType<typeof createDetector>|undefined;
let recording:MessagePort|undefined,credits=3,inFlightBytes=0,peakInFlightBytes=0;
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
  }},true);
 })();
}
self.onmessage=async(event:MessageEvent<{kind?:'prepare'|'record'|'record-end';port?:MessagePort;time?:number;recordOnly?:boolean;id:number;bitmap:ImageBitmap|VideoFrame;layout?:Layout;patches?:boolean;pixelTransport?:boolean}>)=>{
 const {id,bitmap}=event.data;
 if(event.data.kind==='record'){
  recording=event.data.port;credits=3;inFlightBytes=peakInFlightBytes=0;
  if(recording){recording.onmessage=e=>{credits=Math.min(3,credits+1);inFlightBytes=Math.max(0,inFlightBytes-(e.data.bytes??0));};recording.start();}return;
 }
 if(event.data.kind==='record-end'){recording?.postMessage({kind:'end',peakInFlightBytes});recording?.close();recording=undefined;self.postMessage({recordingEnded:true});return;}
 if(event.data.kind==='prepare') {
  try{await prepare();self.postMessage({ready:true});}
  catch(error){self.postMessage({ready:true,error:String(error)});}
  return;
 }
 const transfers:ImageBitmap[]=[];
 const pixelTransfers:ArrayBuffer[]=[];
 try {
  const started=performance.now();
  const width='displayWidth' in bitmap?bitmap.displayWidth:bitmap.width;
  const height='displayHeight' in bitmap?bitmap.displayHeight:bitmap.height;
  if(frame.width!==width||frame.height!==height){frame.width=width;frame.height=height;}
  context.drawImage(bitmap,0,0);
  // Record the exact detector input before quality filtering. Never wait for disk/encoding.
  if(recording){
   if(credits>0&&width*height*4<=32*1024*1024&&inFlightBytes+width*height*4<=64*1024*1024){
    const before=performance.now(),pixels=context.getImageData(0,0,width,height);credits--;inFlightBytes+=pixels.data.byteLength;peakInFlightBytes=Math.max(peakInFlightBytes,inFlightBytes);
    recording.postMessage({kind:'frame',id,time:event.data.time??0,phase:event.data.recordOnly?'recovery':'input',width,height,pixels:pixels.data.buffer,readbackMs:performance.now()-before},[pixels.data.buffer]);
   }else recording.postMessage({kind:'gap',id,time:event.data.time??0});
  }
  if(event.data.recordOnly){self.postMessage({id,cells:[],layout:null});return;}
  const detectStarted=performance.now();
  const layout=event.data.layout??(await prepare()).detect(frame);
  const cropStarted=performance.now();
  const cells=(layout?acquire(frame,layout):[]).map(({image,...cell})=>{
   const pixels=event.data.pixelTransport?readPixelRaster(image):undefined;
   const raster=pixels?undefined:image.transferToImageBitmap();
   if(raster)transfers.push(raster);
   if(pixels){pixelTransfers.push(pixels.data.buffer);image.width=0;}
   let previewBitmap:ImageBitmap|undefined;
   if(event.data.patches){
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
  const finished=performance.now();
  self.postMessage({id,cells,layout,patches,timing:{workerMs:finished-started,detectMs:cropStarted-detectStarted,cropMs:finished-cropStarted}}, {transfer:[...transfers,...pixelTransfers]});
 }catch(error){for(const raster of transfers)raster.close();self.postMessage({id,error:String(error)});}
 finally{bitmap.close();}
};
