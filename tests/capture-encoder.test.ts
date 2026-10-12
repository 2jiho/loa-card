import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureEncoder } from "../src/features/card-scanner/capture-encoder.ts";
import type { SavedAcquisition } from '../src/features/card-scanner/saved-acquisition';

test('discard cancels unfinished copies and waits for raw-frame cleanup without PNG encoding',async()=>{
 const requests:unknown[]=[],copies:((bitmap:ImageBitmap)=>void)[]=[];
 let closed=0,terminated=0;
 const worker={onmessage:null as ((event:MessageEvent)=>void)|null,onerror:null,
  postMessage(message:unknown){requests.push(message);},terminate(){terminated++;}};
 const encoder=createCaptureEncoder(()=>assert.fail('discard must not export PNGs'),assert.fail,worker,1000,
  ()=>new Promise(resolve=>copies.push(resolve)));
 const source={videoWidth:1,videoHeight:1} as HTMLVideoElement;
 encoder.submit(source,1,1);
 const done=encoder.discard();
 assert.equal(encoder.active,false);
 assert.deepEqual(requests,[{discard:true}]);
 assert.equal(encoder.finish(),done,'finally must reuse discard, never start PNG flush');
 assert.equal(encoder.discard(),done);
 encoder.submit(source,2,2);assert.equal(copies.length,1);
 copies[0]({close(){closed++;}} as ImageBitmap);
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(closed,1);assert.equal(terminated,0,'wait for worker storage cleanup');
 worker.onmessage!({data:{done:true}} as MessageEvent);
 await done;assert.equal(terminated,1);assert.deepEqual(requests,[{discard:true}]);
});

test('discard never replaces a PNG export already requested by finish',async()=>{
 const requests:unknown[]=[];
 const worker={onmessage:null as ((event:MessageEvent)=>void)|null,onerror:null,
  postMessage(message:unknown){requests.push(message);},terminate(){}};
 const encoder=createCaptureEncoder(()=>{},assert.fail,worker,1000,undefined);
 const done=encoder.finish();assert.equal(encoder.discard(),done);
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.deepEqual(requests,[{finish:true}]);
 worker.onmessage!({data:{done:true}} as MessageEvent);await done;
});
test("live snapshots never read main-thread pixels and flush only after ordered bitmap transfers", async () => {
  const copies: ((bitmap: ImageBitmap) => void)[] = [];
  const requests: { id?: number; width?: number; height?: number; time?: number; finish?: boolean; bitmap?: ImageBitmap }[] = [];
  const worker = { onmessage: null as ((event: MessageEvent) => void) | null, onerror: null, terminated: false,
    postMessage(message: unknown) { requests.push(message as typeof requests[number]); },
    terminate() { this.terminated = true; } };
  const encoder = createCaptureEncoder(() => {}, assert.fail, worker, 1000,
    () => new Promise(resolve => copies.push(resolve)));
  const mutableSource = { videoWidth: 1, videoHeight: 1, getContext() { assert.fail("main thread pixel read"); } };
  const source = mutableSource as unknown as HTMLVideoElement;
  encoder.submit(source, 1, 1000); encoder.submit(source, 2, 2000);
  mutableSource.videoWidth = 4; // Metadata must describe the captured image, not later resize.
  const finishing = encoder.finish();
  assert.equal(copies.length, 2); assert.equal(requests.length, 0);
  copies[1]({ close() {} } as ImageBitmap); await Promise.resolve();
  assert.equal(requests.length, 0);
  copies[0]({ close() {} } as ImageBitmap);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.deepEqual(requests.map(request => request.id ?? "finish"), [1, 2, "finish"]);
  assert.deepEqual(requests.slice(0, 2).map(request => request.width), [1, 1]);
  for (const id of [1, 2]) {
    worker.onmessage!({ data: { id, stored: true } } as MessageEvent);
    worker.onmessage!({ data: { id, frame: { image: "data:image/png;base64,AAAA", time: id, elapsed: id * 1000 } } } as MessageEvent);
  }
  worker.onmessage!({ data: { done: true } } as MessageEvent);
  await finishing; assert.equal(worker.terminated, true);
});

test('original replay keeps exact receipt IDs and stops only when completion and all remaining receipts agree',async()=>{
 const oldDocument=globalThis.document,oldImageData=globalThis.ImageData;
 Object.assign(globalThis,{document:{createElement:()=>({width:0,height:0,getContext:()=>({putImageData(){}})})},
  ImageData:class {constructor(public data:Uint8ClampedArray,public width:number,public height:number){}}});
 try {
  for(const mode of ['complete','not-ready','missing','changed-size']) {
   const requests:number[]=[],seen:(SavedAcquisition|undefined)[]=[],skipped:number[]=[];
   const worker={onmessage:null as ((event:MessageEvent)=>void)|null,onerror:null,
    postMessage(message:unknown){const request=message as {id?:number;read?:number;discard?:boolean};queueMicrotask(()=>{
     if(request.id)worker.onmessage!({data:{id:request.id,stored:true}} as MessageEvent);
     if(request.read){requests.push(request.read);worker.onmessage!({data:{id:request.read,raw:{width:1,height:1,time:request.read,pixels:new Uint8ClampedArray(4)}}} as MessageEvent);}
     if(request.discard)worker.onmessage!({data:{done:true}} as MessageEvent);
    });},terminate(){}};
   const encoder=createCaptureEncoder(()=>assert.fail('not PNG'),assert.fail,worker,1000,async()=>({close(){}} as ImageBitmap));
   const first=encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,1,1000)!;
   const second=encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,2,2000)!;
   const a={width:mode==='changed-size'?2:1,height:1,layout:null,cells:[],observations:[]} as SavedAcquisition;
   encoder.attachAnalysis(first,a);
   if(mode!=='missing')encoder.attachAnalysis(second,{...a});
   for await(const frame of encoder.frames(new AbortController().signal,{
    ready:()=>mode==='complete'||mode==='missing',covered:value=>!!value,skipped:count=>skipped.push(count),
   }))seen.push(frame.analysis);
   if(mode==='complete'){assert.deepEqual(requests,[]);assert.deepEqual(skipped,[2]);}
   else {assert.deepEqual(requests,[1,2]);assert.deepEqual(skipped,[]);
    if(mode==='missing'){assert.equal(seen[0],a);assert.equal(seen[1],undefined);}
    if(mode==='changed-size')assert.deepEqual(seen,[undefined,undefined]);
   }
  }
 } finally {Object.assign(globalThis,{document:oldDocument,ImageData:oldImageData});}
});
