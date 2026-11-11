import {createDetector} from '../src/features/card-scanner/acquisition/detector';
import type {DetectorPlatform,Layout} from '../src/features/card-scanner/acquisition/detector';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';
type Instance=Awaited<ReturnType<typeof createDetector>>;
type DetectorEvent=Record<string,unknown>;
type Slot={detector:Instance;events:DetectorEvent[]};
let slots:Slot[]=[];
const workCanvas=new OffscreenCanvas(1,1),ctx=workCanvas.getContext('2d',{willReadFrequently:true})!;
function verdict(layout:Layout|null){return layout?JSON.parse(JSON.stringify(layout)):null;}
async function setup(){
 const base=new URL(import.meta.env.BASE_URL,self.location.href).href;
 await import(/* @vite-ignore */ `${base}ocr/opencv.js`);
 const cv=await (self as unknown as {cv:Promise<DetectorPlatform['cv']>}).cv;
 const platform:DetectorPlatform={cv,canvas:()=>new OffscreenCanvas(1,1),anchor:async name=>{
  const response=await fetch(`${base}scanner/${name}`);if(!response.ok)throw Error('Missing anchor');
  const image=await createImageBitmap(await response.blob());
  try {const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d',{willReadFrequently:true})!;
   context.drawImage(image,0,0);return cv.matFromImageData(context.getImageData(0,0,image.width,image.height));
  } finally {image.close();}
 }};
 for(const reuse of [false,true,false,true]){
  const events:DetectorEvent[]=[];const detector=await createDetector(platform,reuse,event=>events.push(event));
  slots.push({detector,events});
 }
}
function run(slot:Slot,global:boolean){
 slot.events.length=0;
 // Reset only tracking: independent source/cache pixels are retained. The
 // zero-sized frame exits before detection or raster access.
 if(global)slot.detector.detect({width:0,height:0} as OffscreenCanvas);
 const start=performance.now(),layout=slot.detector.detect(workCanvas),elapsedMs=performance.now()-start;
 return {layout:verdict(layout),elapsedMs,stages:slot.events.slice()};
}
self.onmessage=async(event:MessageEvent<{kind:'setup'|'frame'|'dispose';id:number;bitmap?:ImageBitmap}>)=>{
 const {kind,id,bitmap}=event.data;
 try {
  if(kind==='setup'){await setup();self.postMessage({id,ready:true});return;}
  if(kind==='dispose'){slots.forEach(slot=>slot.detector.dispose());slots=[];self.postMessage({id,disposed:true});return;}
  if(!bitmap||slots.length!==4)throw Error('Worker not ready');
  if(workCanvas.width!==bitmap.width)workCanvas.width=bitmap.width;
  if(workCanvas.height!==bitmap.height)workCanvas.height=bitmap.height;
  ctx.globalCompositeOperation='copy';ctx.drawImage(bitmap,0,0);bitmap.close();
  const pixels=ctx.getImageData(0,0,workCanvas.width,workCanvas.height).data;
  const rasterSha256=await pixelHash(new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength));
  // Each paired call reads this exact worker canvas. First pair is a changing
  // frame, second pair repeats it; other detectors preserve tracking sequence.
  const global=[run(slots[0],true),run(slots[1],true),run(slots[0],true),run(slots[1],true)];
  const tracked=[run(slots[2],false),run(slots[3],false)];
  self.postMessage({id,width:workCanvas.width,height:workCanvas.height,rasterSha256,global,tracked});
 }catch(error){bitmap?.close();self.postMessage({id,error:String(error)});}
};
