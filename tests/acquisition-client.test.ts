import {test} from 'node:test';import assert from 'node:assert/strict';
import {createAcquisitionClient} from '../src/features/card-scanner/acquisition-client';
import type {Layout} from '../src/features/card-scanner/detector';
import {entryParts,exactReplayFrames,fastCompress,packPixels,pixelHash} from '../src/features/card-scanner/exact-recording-codec';
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
  worker.onmessage!({data:{id:worker.sent.id,cells:[],timing:{workerMs:5,detectMs:2,cropMs:3,
    profile:{exact:10,moved:20,inspected:10,probeMs:0.5,shifted:1,moveCompared:20,moveMatched:20}}}});
  const snapshot=await timed;
  assert.equal(snapshot.frameId,2);
  assert.equal(snapshot.timing?.workerMs,5);assert.ok(snapshot.timing!.freezeMs>=0);
  assert.deepEqual(snapshot.timing?.profile,{exact:10,moved:20,inspected:10,probeMs:0.5,shifted:1,moveCompared:20,moveMatched:20});
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
  const result=await pending;assert.equal(result.frameId,worker.sent.id);assert.equal(result.cells[0].previewImage?.width,144);assert.equal(previewClosed,1);assert.equal(clear,1);assert.deepEqual(drawn,[[bitmap,11,20]]);assert.equal(patchClosed,1);
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

test('detector requests default to input and explicitly mark recovery without leaking phase into the next frame',async()=>{
 const names=['Worker','OffscreenCanvas','createImageBitmap'];
 const previous=Object.fromEntries(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 type Request={id:number;bitmap:ImageBitmap;time:number;recordOnly:boolean;phase:'input'|'recovery';layout?:Layout};
 const requests:Request[]=[],sources:unknown[]=[],transfers:unknown[][]=[];
 let worker:{onmessage:((event:{data:unknown})=>void)|null};
 let client:ReturnType<typeof createAcquisitionClient>|undefined;
 try {
  for(const [name,value] of Object.entries({
   Worker:class{onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;
    constructor(){worker=this;}
    postMessage(message:Request,transfer:unknown[]){requests.push(message);transfers.push(transfer);}
    terminate(){}},
   OffscreenCanvas:class{},createImageBitmap:async(source:unknown)=>{sources.push(source);return {width:100,height:90,close(){}};},
  }))Object.defineProperty(globalThis,name,{value,configurable:true});
  client=createAcquisitionClient(new AbortController().signal);
  const frames=[{}, {}, {}] as HTMLCanvasElement[];
  for(let index=0;index<frames.length;index++) {
   const pending=index===1?client.detectAndAcquire(frames[index],12.75,'recovery'):client.detectAndAcquire(frames[index],index===0?undefined:14.25);
   await Promise.resolve();
   const request=requests[index];
   assert.equal(request.phase,index===1?'recovery':'input');
   assert.equal(request.time,index===0?0:index===1?12.75:14.25);
   assert.equal(request.recordOnly,false);assert.equal(request.layout,undefined);
   assert.deepEqual(transfers[index],[request.bitmap]);
   worker!.onmessage!({data:{id:request.id,cells:[],layout:null}});
   const result=await pending;
   assert.equal(result.frameId,request.id);assert.equal(result.frameId,index+1);
   assert.deepEqual(result.cells,[]);
  }
  assert.deepEqual(sources,frames,'each recovery request freezes its own supplied source');
 } finally {
  client?.dispose();
  for(const [k,d] of Object.entries(previous))if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);
 }
});

test('cached recovery records its exact input only when recording is attached and does not request acquisition',async()=>{
 const names=['Worker','OffscreenCanvas','createImageBitmap'];
 const previous=Object.fromEntries(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 type Request={kind?:string;id?:number;bitmap?:ImageBitmap;time?:number;recordOnly?:boolean;port?:MessagePort};
 const requests:Request[]=[],sources:unknown[]=[],transfers:unknown[][]=[];
 let worker:{onmessage:((event:{data:unknown})=>void)|null};
 let client:ReturnType<typeof createAcquisitionClient>|undefined;
 try {
  for(const [name,value] of Object.entries({
   Worker:class{onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;
    constructor(){worker=this;}
    postMessage(message:Request,transfer:unknown[]=[]){requests.push(message);transfers.push(transfer);}
    terminate(){}},
   OffscreenCanvas:class{},createImageBitmap:async(source:unknown)=>{sources.push(source);return {width:100,height:90,close(){}};},
  }))Object.defineProperty(globalThis,name,{value,configurable:true});
  client=createAcquisitionClient(new AbortController().signal);
  const frame={} as HTMLCanvasElement;
  assert.equal(await client.recordOnly(frame,3.25),undefined);
  assert.equal(requests.length,0);assert.equal(sources.length,0);
  const port={} as MessagePort;client.startRecording(port);
  assert.deepEqual(requests[0],{kind:'record',port});assert.deepEqual(transfers[0],[port]);
  const recording=client.recordOnly(frame,7.5);await Promise.resolve();
  assert.equal(requests.length,2);assert.equal(requests[1].recordOnly,true,'worker bypasses detector/crop and tags this as recovery');
  assert.equal(requests[1].time,7.5);assert.deepEqual(sources,[frame]);
  assert.deepEqual(transfers[1],[requests[1].bitmap]);
  worker!.onmessage!({data:{id:requests[1].id,cells:[],layout:null}});assert.equal(await recording,requests[1].id);
  const stopping=client.stopRecording();
  assert.equal(requests[2].kind,'record-end');
  worker!.onmessage!({data:{recordingEnded:true}});await stopping;
  assert.equal(await client.recordOnly(frame,9.25),undefined);assert.equal(requests.length,3);assert.equal(sources.length,1);
 } finally {
  client?.dispose();
  for(const [k,d] of Object.entries(previous))if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);
 }
});

test('frame IDs follow worker requests across prepared client reuse and recording-only recovery inputs',async()=>{
 const names=['Worker','OffscreenCanvas','createImageBitmap'];
 const previous=Object.fromEntries(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 type Request={kind?:string;id?:number;time?:number;recordOnly?:boolean};
 const requests:Request[]=[];
 let worker:{onmessage:((event:{data:unknown})=>void)|null};
 let client:ReturnType<typeof createAcquisitionClient>|undefined;
 try {
  for(const [name,value] of Object.entries({
   Worker:class{onmessage:((event:{data:unknown})=>void)|null=null;onerror:unknown;
    constructor(){worker=this;}
    postMessage(message:Request){requests.push(message);}
    terminate(){}},
   OffscreenCanvas:class{},createImageBitmap:async()=>({width:100,height:90,close(){}}),
  }))Object.defineProperty(globalThis,name,{value,configurable:true});
  client=createAcquisitionClient(new AbortController().signal);
  const frame={} as HTMLCanvasElement;
  const preparation=client.ready();
  assert.deepEqual(requests.at(-1),{kind:'prepare'});
  worker!.onmessage!({data:{ready:true}});await preparation;
  const respond=async(pending:Promise<{frameId:number}|number|undefined>,expectedId:number)=>{
   await Promise.resolve();
   const request=requests.at(-1)!;assert.equal(request.id,expectedId);
   worker!.onmessage!({data:{id:expectedId-1,cells:[],layout:null}});
   let finished=false;void pending.then(()=>{finished=true;});await Promise.resolve();
   assert.equal(finished,false,'a previous response cannot resolve this input or give it another frame ID');
   worker!.onmessage!({data:{id:request.id,cells:[],layout:null}});
   const result=await pending;assert.equal(typeof result==='object'?result.frameId:result,expectedId);
  };
  await respond(client.detectAndAcquire(frame,8),1);
  client.startRecording({} as MessagePort);
  await respond(client.recordOnly(frame,4),2);
  assert.equal(requests.at(-1)!.recordOnly,true);
  assert.equal(requests.at(-1)!.time,4,'older recovery capture time does not determine the recording ID');
  await respond(client.detectAndAcquire(frame,9),3);
  const stopping=client.stopRecording();
  assert.equal(requests.at(-1)!.kind,'record-end');
  worker!.onmessage!({data:{recordingEnded:true}});await stopping;
  assert.equal(await client.recordOnly(frame,10),undefined,'unattached inputs do not consume frame IDs');
  await client.ready();
  client.startRecording({} as MessagePort);
  await respond(client.detectAndAcquire(frame,0),4);
  assert.equal(requests.filter(request=>request.kind==='prepare').length,1);
  assert.deepEqual(requests.filter(request=>request.id!==undefined).map(request=>request.id),[1,2,3,4]);
 } finally {
  client?.dispose();
  for(const [k,d] of Object.entries(previous))if(d)Object.defineProperty(globalThis,k,d);else Reflect.deleteProperty(globalThis,k);
 }
});

test('cached canonical uses reserve monotone acquisition IDs without copying pixels or attaching a recorder',async()=>{
 const names=['Worker','OffscreenCanvas','createImageBitmap','document','ImageData'];
 const previous=Object.fromEntries(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const requests:any[]=[];let worker:any,copies=0,client:ReturnType<typeof createAcquisitionClient>|undefined;
 try{
  for(const [name,value]of Object.entries({
   Worker:class{onmessage:any;onerror:any;constructor(){worker=this;}postMessage(message:any){requests.push(message);}terminate(){}},
   OffscreenCanvas:class{},createImageBitmap:async()=>{copies++;return {width:1,height:1,close(){}};},
   document:{createElement:()=>({width:0,height:0,getContext:()=>({putImageData(){}})})},
   ImageData:class{constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}},
  }))Object.defineProperty(globalThis,name,{configurable:true,value});
  client=createAcquisitionClient(new AbortController().signal);
  const frame={} as HTMLCanvasElement,first=client.detectAndAcquire(frame,10);await Promise.resolve();
  assert.equal(requests[0].id,1);worker.onmessage({data:{id:1,cells:[],layout:null}});
  const firstId=(await first).frameId;
  assert.equal(await client.recordOnly(frame,10),undefined,'legacy recordOnly remains a no-op when detached');
  const before={requests:requests.length,copies},cachedId=client.reserveFrameId();
  assert.equal(cachedId,2);assert.deepEqual({requests:requests.length,copies},before,'a cached analysis consumes only a processing identity');
  const third=client.detectAndAcquire(frame,11);await Promise.resolve();
  assert.equal(requests.at(-1).id,3);worker.onmessage({data:{id:3,cells:[],layout:null}});
  const thirdId=(await third).frameId;
  assert.deepEqual([firstId,cachedId,thirdId],[1,2,3]);assert.equal(copies,2);assert.equal(requests.length,2);
  assert.equal(await client.recordOnly(frame,11),undefined);assert.equal(requests.length,2);

  // The same IDs must also remain valid when one physical source is reused by
  // cached recovery and all processing uses are replayed from the new format.
  const parts:BlobPart[]=[];
  for(const [id,time]of [[1,10],[2,11]]){
   const pixels=new Uint8Array([id,2,3,255]),hash=await pixelHash(pixels);
   parts.push(...entryParts({kind:'frame',id,time,width:1,height:1,key:true,hash,canonical:true,codec:'lz4',xor:true},fastCompress(packPixels(pixels,undefined,true))));
  }
  const uses=[{sourceFrameId:1,acquisitionFrameId:firstId,phase:'input',captureTime:10},
   {sourceFrameId:1,acquisitionFrameId:cachedId,phase:'recovery',captureTime:10},
   {sourceFrameId:2,acquisitionFrameId:thirdId,phase:'input',captureTime:11}];
  for(const [index,value]of uses.entries())parts.push(...entryParts({kind:'event',seq:index+1,time:index,type:'canonical-source-use',value}));
  const replayed=[];for await(const input of exactReplayFrames(new Blob(parts),new AbortController().signal))replayed.push(input.provenance);
  assert.deepEqual(replayed.map(value=>value?.frameId),[1,2,3]);
  assert.deepEqual(replayed.map(value=>value?.sourceFrameId),[1,1,2]);
  assert.deepEqual(replayed.map(value=>value?.phase),['input','recovery','input']);
 }finally{
  client?.dispose();
  for(const [key,value]of Object.entries(previous))if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
 }
});

test('reserved acquisition IDs reject freezing, pending, closed and aborted clients without consuming the next identity',async()=>{
 const names=['Worker','OffscreenCanvas','createImageBitmap'];
 const previous=Object.fromEntries(names.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 let worker:any,finish!:(value:unknown)=>void,client:ReturnType<typeof createAcquisitionClient>|undefined,closedClient:ReturnType<typeof createAcquisitionClient>|undefined;
 const requests:any[]=[];
 try{
  for(const [name,value]of Object.entries({
   Worker:class{onmessage:any;onerror:any;constructor(){worker=this;}postMessage(message:any){requests.push(message);}terminate(){}},
   OffscreenCanvas:class{},createImageBitmap:()=>new Promise(resolve=>{finish=resolve;}),
  }))Object.defineProperty(globalThis,name,{configurable:true,value});
  const control=new AbortController();client=createAcquisitionClient(control.signal);
  const acquisition=client.detectAndAcquire({} as HTMLCanvasElement);
  assert.throws(()=>client!.reserveFrameId(),/동시 수집/);assert.equal(requests.length,0);
  finish({width:1,height:1,close(){}});await Promise.resolve();
  assert.equal(requests[0].id,1);assert.throws(()=>client!.reserveFrameId(),/동시 수집/);
  worker.onmessage({data:{id:1,cells:[],layout:null}});await acquisition;
  assert.equal(client.reserveFrameId(),2,'failed reservations do not skip processing identities');
  control.abort();assert.throws(()=>client!.reserveFrameId(),{name:'AbortError'});
  closedClient=createAcquisitionClient(new AbortController().signal);closedClient.dispose();
  assert.throws(()=>closedClient!.reserveFrameId(),/수집 종료/);
  assert.equal(requests.length,1,'neither reservations nor rejected reservations post a pixel request');
 }finally{
  client?.dispose();closedClient?.dispose();
  for(const [key,value]of Object.entries(previous))if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);
 }
});
