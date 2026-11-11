import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';

type Sample={name:string;width:number;height:number;box:{x:number;y:number;width:number;height:number};rgba:string};
const samples=JSON.parse(readFileSync(new URL('./fixtures/border-integrity-samples.json',import.meta.url),'utf8')) as Sample[];
class Canvas {
 private w:number;private h:number;data:Uint8ClampedArray;
 constructor(width:number,height:number){this.w=width;this.h=height;this.data=new Uint8ClampedArray(width*height*4);}
 get width(){return this.w;}set width(value:number){this.w=value;this.data=new Uint8ClampedArray(value*this.h*4);}
 get height(){return this.h;}set height(value:number){this.h=value;this.data=new Uint8ClampedArray(value*this.w*4);}
 getContext(){return {globalCompositeOperation:'copy',getImageData:(x:number,y:number,width:number,height:number)=>{
  const data=new Uint8ClampedArray(width*height*4);
  for(let row=0;row<height;row++)for(let col=0;col<width;col++)if(x+col>=0&&y+row>=0&&x+col<this.w&&y+row<this.h){
   const at=((y+row)*this.w+x+col)*4;data.set(this.data.subarray(at,at+4),(row*width+col)*4);
  }
  return {width,height,data};
 },putImageData:(image:{data:Uint8ClampedArray;width:number;height:number},x:number,y:number)=>{
  for(let row=0;row<image.height;row++)for(let col=0;col<image.width;col++){
   const to=((y+row)*this.w+x+col)*4,from=(row*image.width+col)*4;this.data.set(image.data.subarray(from,from+4),to);
  }
 },drawImage:(source:Canvas,...values:number[])=>{
  const [sx,sy,sw,sh,dx,dy,dw,dh]=values.length===2?[0,0,source.width,source.height,...values,source.width,source.height]:values;
  for(let y=Math.max(0,Math.ceil(dy));y<Math.min(this.h,Math.ceil(dy+dh));y++)for(let x=Math.max(0,Math.ceil(dx));x<Math.min(this.w,Math.ceil(dx+dw));x++){
   const px=Math.floor(sx+(x-dx+.5)*sw/dw),py=Math.floor(sy+(y-dy+.5)*sh/dh);
   if(px>=0&&py>=0&&px<source.width&&py<source.height){const from=(py*source.width+px)*4,to=(y*this.w+x)*4;this.data.set(source.data.subarray(from,from+4),to);}
  }
 }};}
 transferToImageBitmap(){return {width:this.w,height:this.h,data:this.data.slice(),close(){}};}
}
async function worker(dev:boolean,run:(send:(data:unknown)=>Promise<void>,replies:any[])=>Promise<void>,stallCrop=false){
 const names=['self','OffscreenCanvas','ImageData','crypto'],prior=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 const replies:any[]=[],nativeCrypto=globalThis.crypto;let digests=0;
 const scope=Object.assign(Object.create(globalThis),{onmessage:null as any,postMessage(value:any,options?:{transfer:unknown[]}){
  const transfer=options?.transfer??[];replies.push(structuredClone(value,{transfer:transfer.filter((v):v is ArrayBuffer=>v instanceof ArrayBuffer)}));
 }});
 Object.defineProperty(globalThis,'self',{configurable:true,value:scope});Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:Canvas});
 Object.defineProperty(globalThis,'ImageData',{configurable:true,value:class{constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}}});
 if(stallCrop)Object.defineProperty(globalThis,'crypto',{configurable:true,value:{randomUUID:()=>nativeCrypto.randomUUID(),subtle:{digest:(...args:Parameters<SubtleCrypto['digest']>)=>{
   digests++;return digests===2?new Promise<ArrayBuffer>(()=>{}):nativeCrypto.subtle.digest(...args);
 }}}});
 try{
  const out=await build({entryPoints:['src/features/card-scanner/acquisition/acquisition-worker.ts'],bundle:true,write:false,format:'esm',platform:'node',
    define:{'import.meta.env':JSON.stringify({DEV:dev,BASE_URL:'/'})},logLevel:'silent'});
  await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].contents).toString('base64')}#${nativeCrypto.randomUUID()}`);
  await run(data=>scope.onmessage({data}),replies);
 }finally{for(const [name,descriptor]of Object.entries(prior))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}
}
function payload(sample:Sample,id:number,options:Record<string,unknown>={}){
 const pixels=new Uint8Array(Buffer.from(sample.rgba,'base64'));
 return {kind:'prepared',id,prepared:{width:sample.width,height:sample.height,pixels,binding:{sourceFrameId:id+10,captureTime:1.25}},
  layout:{cells:[sample.box],scale:1,area:{x:0,y:0,width:sample.width,height:sample.height}},pixelTransport:true,...options};
}

test('actual DEV prepared Worker returns bounded crop evidence for its actual transferred normal and tooltip pixels',async()=>{
 await worker(true,async(send,replies)=>{
  let id=0;for(const sample of [samples[0],samples.find(x=>x.name.includes('하이비 집행관')&&x.name.includes('툴팁'))!]){
   const input=payload(sample,++id,{experimentalCropProof:true});await send(input);const result=replies.at(-1);
   assert.equal(result.error,undefined);assert.equal(result.cells.length,1);const proof=result.experimentalCropProof;
   assert.equal(proof.frameCheck,'match');assert.equal(proof.checked,1);assert.equal(proof.crops[0].slot,0);
   assert.deepEqual(proof.frame,result.rasterReceipt);assert.equal(proof.crops[0].sha256,await pixelHash(new Uint8Array(result.cells[0].pixels.data)));
   assert.deepEqual(proof.crops[0].content,result.cells[0].content);assert.equal(proof.timedOut,false);assert.equal(proof.hashBusy,false);
  }
 });
});

test('Worker keeps baseline requests unchanged and refuses proof outside supported DEV prepared transport',async()=>{
 const sample=samples[0];await worker(true,async(send,replies)=>{
  await send(payload(sample,1));assert.equal(replies.at(-1).error,undefined);assert.equal(replies.at(-1).experimentalCropProof,undefined);
  await send(payload(sample,2,{experimentalCropProof:'true'}));assert.match(replies.at(-1).error,/옵션/);
  await send(payload(sample,3,{experimentalCropProof:true,pixelTransport:false}));assert.match(replies.at(-1).error,/개발 실험/);
 });
 await worker(false,async(send,replies)=>{
  await send(payload(sample,1,{experimentalCropProof:true}));assert.match(replies.at(-1).error,/개발 실험/);
 });
});

test('a stalled Worker crop digest times out without dropping pixels and blocks another digest until settled',async()=>{
 const sample=samples[0];await worker(true,async(send,replies)=>{
  const start=performance.now();await send(payload(sample,1,{experimentalCropProof:true}));const first=replies.at(-1),elapsed=performance.now()-start;
  assert.equal(first.error,undefined);assert.equal(first.cells.length,1);assert.equal(first.experimentalCropProof.checked,0);
  assert.equal(first.experimentalCropProof.timedOut,true);assert.equal(first.experimentalCropProof.hashFailed,1);assert.ok(elapsed<5000);
  await send(payload(sample,2,{experimentalCropProof:true}));const second=replies.at(-1);
  assert.equal(second.error,undefined);assert.equal(second.cells.length,1);assert.equal(second.experimentalCropProof.hashBusy,true);
  assert.equal(second.experimentalCropProof.checked,0);assert.equal(second.experimentalCropProof.bytesHashed,0);
 },true);
});
