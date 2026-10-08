import {test} from 'node:test';import assert from 'node:assert/strict';
import {createAcquisitionClient} from '../src/features/card-scanner/acquisition-client';
import type {Layout} from '../src/features/card-scanner/detector';
test('acquisition transfers a frozen frame, resolves crops, closes returned bitmaps and cancels pending work',async()=>{
 const previous=Object.fromEntries(['Worker','OffscreenCanvas','createImageBitmap','document'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let inputClosed=0,outputClosed=0;
 class FakeWorker{
  static current:FakeWorker;onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;sent:any;terminated=false;
  constructor(){FakeWorker.current=this;}
  postMessage(message:unknown){this.sent=message;}
  terminate(){this.terminated=true;}
 }
 const set=(k:string,value:unknown)=>Object.defineProperty(globalThis,k,{value,writable:true,configurable:true});
 try{
  set('Worker',FakeWorker);set('OffscreenCanvas',class{});
  set('createImageBitmap',async()=>({width:100,height:100,close(){inputClosed++;}}));
  set('document',{createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){}})})});
  const control=new AbortController(),client=createAcquisitionClient(control.signal),worker=FakeWorker.current;
  const pending=client.acquire({} as HTMLCanvasElement,{} as Layout);await Promise.resolve();
  assert.equal(worker.sent.id,1);
  worker.onmessage!({data:{id:1,cells:[{slot:0,bitmap:{width:140,height:210,close(){outputClosed++;}}}]}});
  const cells=await pending;assert.equal(cells[0].image.width,140);assert.equal(outputClosed,1);
  const timed=client.detectAndAcquire({} as HTMLCanvasElement);await Promise.resolve();
  worker.onmessage!({data:{id:worker.sent.id,cells:[],timing:{workerMs:5,detectMs:2,cropMs:3}}});
  const snapshot=await timed;
  assert.equal(snapshot.timing?.workerMs,5);assert.ok(snapshot.timing!.freezeMs>=0);
  const canceled=client.acquire({} as HTMLCanvasElement,{} as Layout);await Promise.resolve();
  const rejected=assert.rejects(canceled,{name:'AbortError'});control.abort();await rejected;
  assert.equal(worker.terminated,true);
  worker.onmessage!({data:{id:999,cells:[{bitmap:{close(){outputClosed++;}}}]}});assert.equal(outputClosed,2,'late bitmaps close after cancellation');
  assert.equal(inputClosed,0); // transferred ownership belongs to the Worker
  client.dispose();
 }finally{for(const [k,descriptor] of Object.entries(previous))if(descriptor)Object.defineProperty(globalThis,k,descriptor);else Reflect.deleteProperty(globalThis,k);}
});
test('abort while freezing closes the untransferred bitmap',async()=>{
 const previous=Object.fromEntries(['Worker','OffscreenCanvas','createImageBitmap'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let finish!:(bitmap:unknown)=>void,closed=0;
 try{
  Object.defineProperty(globalThis,'Worker',{value:class{terminate(){}},configurable:true});
  Object.defineProperty(globalThis,'OffscreenCanvas',{value:class{},configurable:true});
  Object.defineProperty(globalThis,'createImageBitmap',{value:()=>new Promise(resolve=>{finish=resolve;}),configurable:true});
  const control=new AbortController(),client=createAcquisitionClient(control.signal);
  const pending=client.acquire({} as HTMLCanvasElement,{} as Layout),rejected=assert.rejects(pending,{name:'AbortError'});
  control.abort();finish({close(){closed++;}});await rejected;assert.equal(closed,1);
 }finally{for(const [k,descriptor] of Object.entries(previous))if(descriptor)Object.defineProperty(globalThis,k,descriptor);else Reflect.deleteProperty(globalThis,k);}
});

test('worker preparation is shared, canceled promptly, and forbids overlapping frame freezes',async()=>{
 const previous=Object.fromEntries(['Worker','OffscreenCanvas','createImageBitmap'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let worker:any,prepareCalls=0,finish!:(bitmap:unknown)=>void,closed=0;
 try {
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:class{
   onmessage:any;onerror:any;constructor(){worker=this;}terminate(){}
   postMessage(message:any){if(message.kind==='prepare')prepareCalls++;}
  }});
  Object.defineProperty(globalThis,'OffscreenCanvas',{configurable:true,value:class{}});
  Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,value:()=>new Promise(resolve=>{finish=resolve;})});
  const control=new AbortController(),client=createAcquisitionClient(control.signal);
  const a=client.ready(),b=client.ready();assert.equal(prepareCalls,1);
  worker.onmessage({data:{ready:true}});await Promise.all([a,b]);
  const pending=client.acquire({} as HTMLCanvasElement,{} as Layout);
  await assert.rejects(client.acquire({} as HTMLCanvasElement,{} as Layout),/동시 수집/);
  const rejected=assert.rejects(pending,{name:'AbortError'});control.abort();finish({close(){closed++;}});await rejected;
  assert.equal(closed,1);
  const nextControl=new AbortController(),next=createAcquisitionClient(nextControl.signal),ready=next.ready();
  const canceled=assert.rejects(ready,{name:'AbortError'});nextControl.abort();await canceled;
 }finally{for(const [k,descriptor] of Object.entries(previous))if(descriptor)Object.defineProperty(globalThis,k,descriptor);else Reflect.deleteProperty(globalThis,k);}
});

test('native acquisition clones input ownership and closes metadata bitmaps on success or late cancellation',async()=>{
 const names=['Worker','OffscreenCanvas','createImageBitmap','document','VideoFrame'];
 const previous=Object.fromEntries(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let worker:any,frameClosed=0,patchClosed=0,previewClosed=0,clear=0;
 const drawn:unknown[][]=[];
 class Frame { constructor(readonly source:unknown){} close(){frameClosed++;} }
 try{
  for(const [name,value] of Object.entries({
   Worker:class{onmessage:any;onerror:any;sent:any;constructor(){worker=this;}postMessage(message:any){this.sent=message;}terminate(){}},
   OffscreenCanvas:class{},VideoFrame:Frame,createImageBitmap:()=>{throw new Error('native mode must not read the main canvas');},
   document:{createElement:()=>({width:0,height:0,getContext:()=>({drawImage(){}})})},
  }))Object.defineProperty(globalThis,name,{value,configurable:true});
  const control=new AbortController(),client=createAcquisitionClient(control.signal);
  assert.equal(client.supportsNative,true);
  const source={} as HTMLVideoElement,target={width:100,height:90,getContext:()=>({clearRect(){clear++;},drawImage(...args:unknown[]){drawn.push(args);}})} as unknown as HTMLCanvasElement;
  const pending=client.detectNative(source,target);
  assert.equal(worker.sent.bitmap.source,source);assert.equal(worker.sent.patches,true);
  const bitmap={close(){patchClosed++;}},box={x:11,y:20,width:4,height:5};
  const previewBitmap={width:144,height:214,close(){previewClosed++;}};
  worker.onmessage({data:{id:worker.sent.id,cells:[{slot:0,bitmap:{width:140,height:210,close(){}},previewBitmap}],patches:[{bitmap,box}],layout:{}}});
  const result=await pending;assert.equal(result.cells[0].previewImage?.width,144);assert.equal(previewClosed,1);assert.equal(clear,1);assert.deepEqual(drawn,[[bitmap,11,20]]);assert.equal(patchClosed,1);
  assert.equal(frameClosed,0,'transferred clone is owned by Worker');
  const canceled=client.detectNative(source,target),rejects=assert.rejects(canceled,{name:'AbortError'});control.abort();await rejects;
  worker.onmessage({data:{id:worker.sent.id,cells:[{bitmap:{close(){}},previewBitmap}],patches:[{bitmap,box}]}});
  assert.equal(previewClosed,2);assert.equal(patchClosed,2);assert.equal(clear,1,'late results never paint a canceled target');
 }finally{for(const [k,d] of Object.entries(previous))if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}
});

test('pixel transport reconstructs bytes, rejects malformed crops and ignores canceled results',async()=>{
 const names=['Worker','OffscreenCanvas','createImageBitmap','document','ImageData'];
 const previous=Object.fromEntries(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let worker:any,paints=0,last:any;
 try{
  for(const [name,value] of Object.entries({
   Worker:class{onmessage:any;onerror:any;sent:any;constructor(){worker=this;}postMessage(message:any){this.sent=message;}terminate(){}},
   OffscreenCanvas:class{},createImageBitmap:async()=>({width:10,height:10,close(){}}),
   ImageData:class{constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}},
   document:{createElement:()=>({width:0,height:0,getContext:()=>({putImageData(image:any){paints++;last=image;},drawImage(){throw new Error('unexpected bitmap conversion');}})})},
  }))Object.defineProperty(globalThis,name,{value,configurable:true});
  const control=new AbortController(),client=createAcquisitionClient(control.signal,{pixelTransport:true});
  const pending=client.acquire({} as HTMLCanvasElement,{} as Layout);await Promise.resolve();
  assert.equal(worker.sent.pixelTransport,true);
  const bytes=new Uint8ClampedArray([1,2,3,255,10,20,30,128]);
  worker.onmessage({data:{id:worker.sent.id,cells:[{slot:3,pixels:{width:2,height:1,data:bytes}}]}});
  const cells=await pending;assert.equal(cells[0].slot,3);assert.equal(cells[0].image.width,2);
  assert.equal(last.width,2);assert.equal(last.height,1);assert.deepEqual(last.data,bytes);
  assert.equal('pixels' in cells[0],false,'transferred buffers do not escape in retained card metadata');
  const malformed=client.acquire({} as HTMLCanvasElement,{} as Layout);await Promise.resolve();
  const malformedRejection=assert.rejects(malformed,/잘못된 카드 픽셀/);
  worker.onmessage({data:{id:worker.sent.id,cells:[{slot:0,pixels:{width:2,height:2,data:bytes}}]}});await malformedRejection;
  const canceled=client.acquire({} as HTMLCanvasElement,{} as Layout);await Promise.resolve();
  const rejection=assert.rejects(canceled,{name:'AbortError'});control.abort();await rejection;
  worker.onmessage({data:{id:worker.sent.id,cells:[{slot:0,pixels:{width:2,height:1,data:bytes}}]}});
  assert.equal(paints,1,'late canceled pixel data never paints a canvas');client.dispose();
 }finally{for(const [k,d] of Object.entries(previous))if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);}
});
