import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcquisitionClient} from '../src/features/card-scanner/acquisition-client';
import type {Layout} from '../src/features/card-scanner/detector';

test('local crop opt-in forwards only normal requests and materializes mixed output with cancellation cleanup',async()=>{
 const names=['Worker','OffscreenCanvas','createImageBitmap','document','ImageData','VideoFrame'];
 const prior=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 let painted=0,drawn=0,closed=0;const canvases:{width:number;height:number}[]=[];
 class FakeWorker{static current:FakeWorker;onmessage:any;onerror:any;sent:any;constructor(){FakeWorker.current=this;}postMessage(message:any){this.sent=message;}terminate(){}}
 try{
  for(const [name,value]of Object.entries({
   Worker:FakeWorker,
   OffscreenCanvas:class{},VideoFrame:class{close(){}},createImageBitmap:async()=>({width:8,height:8,close(){}}),
   ImageData:class{constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}},
   document:{createElement:()=>{const canvas={width:0,height:0,getContext:()=>({putImageData(){painted++;},drawImage(){drawn++;},clearRect(){}})};canvases.push(canvas);return canvas;}},
  }))Object.defineProperty(globalThis,name,{value,configurable:true});
  assert.throws(()=>createAcquisitionClient(new AbortController().signal,{localCropPixels:1 as unknown as boolean}),/local crop pixels/);
  const control=new AbortController(),client=createAcquisitionClient(control.signal,{localCropPixels:true}),worker=FakeWorker.current;
  const pending=client.detectAndAcquire({} as HTMLCanvasElement);await Promise.resolve();
  assert.equal(worker.sent.localCropPixels,true);assert.equal(worker.sent.pixelTransport,false);
  assert.equal(worker.sent.pixelProof,undefined);assert.equal(worker.sent.measuredRasterReuse,undefined);
  const bytes=new Uint8ClampedArray([1,2,3,255]);
  worker.onmessage({data:{id:worker.sent.id,cells:[{slot:0,pixels:{width:1,height:1,data:bytes}},
    {slot:1,bitmap:{width:2,height:3,close(){closed++;}}}],timing:{localPixelCrops:1}}});
  const result=await pending;assert.equal(painted,1);assert.equal(drawn,1);assert.equal(closed,1);
  assert.deepEqual(result.cells.map(cell=>[cell.image.width,cell.image.height]),[[1,1],[2,3]]);
  assert.equal(result.timing?.localPixelCrops,1);assert.equal(result.pixelProof,undefined);assert.equal(result.rasterReceipt,undefined);
  assert.ok(result.cells.every(cell=>!('pixels' in cell)&&!('ownedPixels' in cell)));
  const native=client.detectNative({} as HTMLVideoElement,{getContext:()=>({clearRect(){},drawImage(){}})} as unknown as HTMLCanvasElement);
  assert.equal(worker.sent.localCropPixels,undefined,'native requests keep their existing path');
  worker.onmessage({data:{id:worker.sent.id,cells:[]}});await native;
  const canceled=client.detectAndAcquire({} as HTMLCanvasElement);await Promise.resolve();
  const rejection=assert.rejects(canceled,{name:'AbortError'});control.abort();await rejection;
  worker.onmessage({data:{id:worker.sent.id,cells:[{pixels:{width:1,height:1,data:bytes}},
    {bitmap:{width:2,height:3,close(){closed++;}}}]}});
  assert.equal(painted,1);assert.equal(drawn,1);assert.equal(closed,2);assert.equal(canvases.length,2);
  client.dispose();
 }finally{for(const[name,descriptor]of Object.entries(prior))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}
});

test('default acquisition does not request local pixels',async()=>{
 const names=['Worker','OffscreenCanvas','createImageBitmap'],prior=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
 class FakeWorker{static current:FakeWorker;onmessage:any;onerror:any;sent:any;constructor(){FakeWorker.current=this;}postMessage(message:any){this.sent=message;}terminate(){}}
 try{
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:FakeWorker});
  Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:class{}});
  Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,value:async()=>({close(){}})});
  const control=new AbortController(),client=createAcquisitionClient(control.signal),worker=FakeWorker.current,pending=client.acquire({} as HTMLCanvasElement,{} as Layout);
  await Promise.resolve();assert.equal(worker.sent.localCropPixels,undefined);
  worker.onmessage({data:{id:worker.sent.id,cells:[]}});await pending;client.dispose();
 }finally{for(const[name,descriptor]of Object.entries(prior))if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}
});
