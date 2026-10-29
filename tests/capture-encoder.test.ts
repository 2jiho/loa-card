import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureEncoder } from "../src/features/card-scanner/capture-encoder.ts";
import type { SavedAcquisition } from '../src/features/card-scanner/saved-acquisition';
import { coveredSavedAcquisition } from '../src/features/card-scanner/saved-acquisition';
import {canFinishEndedCapture,canSkipCoveredOriginals,type CaptureCompletion} from '../src/features/card-scanner/auto-completion';
import {runRecoveryPipeline} from '../src/features/card-scanner/recovery-pipeline';

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
  const pngFrames:unknown[]=[];
  const encoder = createCaptureEncoder(frame => pngFrames.push(frame), assert.fail, worker, 1000,
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
  assert.deepEqual(pngFrames,[1,2].map(id=>({image:'data:image/png;base64,AAAA',time:id,elapsed:id*1000})),
    'raw source IDs do not become provenance on the existing PNG callback');
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
   else if(mode==='missing') {assert.deepEqual(requests,[2]);assert.deepEqual(skipped,[1]);assert.deepEqual(seen,[undefined]);}
   else {assert.deepEqual(requests,[1,2]);assert.deepEqual(skipped,[]);
    if(mode==='changed-size')assert.deepEqual(seen,[undefined,undefined]);
   }
  }
 } finally {Object.assign(globalThis,{document:oldDocument,ImageData:oldImageData});}
});

function receipt(id:string,order:number,review:string[]=[]):SavedAcquisition {
 return {width:1,height:1,layout:{scale:1} as SavedAcquisition['layout'],
  cells:[{quality:{usable:true,reason:'',sharpness:1}}] as SavedAcquisition['cells'],
  observations:[{order,frame:'source/1',stable:true,identity:{id,review} as NonNullable<SavedAcquisition['observations'][number]>['identity']}]};
}

async function replayHarness(run:(value:{encoder:ReturnType<typeof createCaptureEncoder>;requests:{read?:number;discard?:boolean}[];
 rasterizations:()=>number;terminated:()=>number;errors:string[];failRead:(id:number)=>void;mismatchRead:(id:number)=>void})=>Promise<void>) {
 const oldDocument=globalThis.document,oldImageData=globalThis.ImageData;
 let rasterizations=0,terminated=0,failingRead:number|undefined,mismatchingRead:number|undefined;
 const requests:{read?:number;discard?:boolean}[]=[],errors:string[]=[];
 Object.assign(globalThis,{document:{createElement:()=>({width:0,height:0,getContext:()=>({putImageData(){rasterizations++;}})})},
  ImageData:class {constructor(public data:Uint8ClampedArray,public width:number,public height:number){}}});
 const worker={onmessage:null as ((event:MessageEvent)=>void)|null,onerror:null,
  postMessage(message:unknown){const request=message as {id?:number;read?:number;discard?:boolean};requests.push(request);queueMicrotask(()=>{
   if(request.id)worker.onmessage!({data:{id:request.id,stored:true}} as MessageEvent);
   if(request.read)worker.onmessage!({data:request.read===failingRead?{error:'test read error'}:
    {id:request.read===mismatchingRead?request.read+1:request.read,raw:{width:1,height:1,time:request.read,pixels:new Uint8ClampedArray(4)}}} as MessageEvent);
   if(request.discard)worker.onmessage!({data:{done:true}} as MessageEvent);
  });},terminate(){terminated++;}};
 const encoder=createCaptureEncoder(()=>assert.fail('replay must not export PNGs'),message=>errors.push(message),worker,1000,async()=>({close(){}} as ImageBitmap));
 try {await run({encoder,requests,rasterizations:()=>rasterizations,terminated:()=>terminated,errors,
  failRead:id=>{failingRead=id;},mismatchRead:id=>{mismatchingRead=id;}});}
 finally {Object.assign(globalThis,{document:oldDocument,ImageData:oldImageData});}
}

test('raw recovery preserves actual submitted IDs after the default 128 analysis sidecars are evicted',async()=>{
 await replayHarness(async({encoder,requests,errors})=>{
  const ids:number[]=[];
  for(let time=1;time<=130;time++) {
   const id=encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,time,time*1000)!;
   assert.ok(Number.isSafeInteger(id));ids.push(id);encoder.attachAnalysis(id,receipt(`card-${id}`,id));
  }
  const seen:{rawSourceFrameId:number;hasAnalysis:boolean}[]=[];
  for await(const frame of encoder.frames(new AbortController().signal))
   seen.push({rawSourceFrameId:frame.rawSourceFrameId,hasAnalysis:frame.analysis!==undefined});
  assert.deepEqual(requests.filter(request=>request.read).map(request=>request.read),ids);
  assert.deepEqual(seen.map(frame=>frame.rawSourceFrameId),ids,'the actual Worker request domain survives sidecar eviction');
  assert.deepEqual(seen.slice(0,2).map(frame=>frame.hasAnalysis),[false,false]);
  assert.ok(seen.slice(2).every(frame=>frame.hasAnalysis),'the production cache still retains its 128 newest sidecars');
  assert.deepEqual(errors,[]);
 });
});

test('a mismatched raw Worker response cannot yield a source-bound frame',async()=>{
 await replayHarness(async({encoder,requests,mismatchRead,errors,rasterizations})=>{
  const id=encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,1,1000)!;mismatchRead(id);
  await assert.rejects(async()=>{
   for await(const _frame of encoder.frames(new AbortController().signal))assert.fail('a mismatched reply must never be yielded');
  },/원본 픽셀 프레임 순서 또는 크기 오류/);
  assert.deepEqual(requests.filter(request=>request.read).map(request=>request.read),[id]);
  assert.equal(errors.length,1);assert.match(errors[0],/원본 픽셀 프레임 순서 또는 크기 오류/);
  assert.equal(rasterizations(),0);
 });
});

test('ready replay skips only independently covered originals before newer unconfirmed and missing receipts',async()=>{
 await replayHarness(async({encoder,requests,rasterizations,terminated,errors})=>{
  for(let id=1;id<=5;id++)encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,id,id*1000);
  encoder.attachAnalysis(1,receipt('known',10));
  encoder.attachAnalysis(2,receipt('changed',21));
  encoder.attachAnalysis(3,receipt('known',12,['이름 확인']));
  encoder.attachAnalysis(5,receipt('known',10));
  const confirmed=new Map([['known',12],['changed',20]]),skipped:number[]=[],seen:number[]=[];
  for await(const frame of encoder.frames(new AbortController().signal,{
   ready:()=>true,covered:analysis=>coveredSavedAcquisition(analysis,confirmed),skipped:count=>skipped.push(count),
  }))seen.push(frame.time);
  assert.deepEqual(seen,[2,3,4]);
  assert.deepEqual(requests.filter(r=>r.read).map(r=>r.read),[2,3,4]);
  assert.deepEqual(skipped,[1,1]);assert.equal(rasterizations(),3);
  assert.equal(terminated(),1);assert.deepEqual(errors,[]);
 });
});

test('covered original stays in replay until global latest-field and final-header readiness passes',async()=>{
 await replayHarness(async({encoder,requests,rasterizations})=>{
  encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,1,1000);encoder.attachAnalysis(1,receipt('known',10));
  encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,2,2000);
  const seen:number[]=[];
  for await(const frame of encoder.frames(new AbortController().signal,{
   ready:()=>false,covered:analysis=>coveredSavedAcquisition(analysis,new Map([['known',10]])),skipped:()=>assert.fail('not ready'),
  }))seen.push(frame.time);
  assert.deepEqual(seen,[1,2]);assert.equal(rasterizations(),2);
  assert.deepEqual(requests.filter(r=>r.read).map(r=>r.read),[1,2]);
 });
});

test('abort immediately after a covered skip cleans storage without reading the next original',async()=>{
 await replayHarness(async({encoder,requests,terminated,rasterizations})=>{
  const controller=new AbortController();
  encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,1,1000);encoder.attachAnalysis(1,receipt('known',10));
  encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,2,2000);
  await assert.rejects(async()=>{
   for await(const _frame of encoder.frames(controller.signal,{
    ready:()=>true,covered:analysis=>coveredSavedAcquisition(analysis,new Map([['known',10]])),skipped:()=>controller.abort(),
   }))assert.fail('aborted frames must not be yielded');
  },{name:'AbortError'});
  assert.equal(rasterizations(),0);assert.deepEqual(requests.filter(r=>r.read),[]);
  assert.equal(requests.filter(r=>r.discard).length,1);assert.equal(terminated(),1);
 });
});

test('a read failure after a covered skip is reported and never presented as completed replay',async()=>{
 await replayHarness(async({encoder,requests,terminated,errors,failRead})=>{
  encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,1,1000);encoder.attachAnalysis(1,receipt('known',10));
  encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,2,2000);failRead(2);
  await assert.rejects(async()=>{
   for await(const _frame of encoder.frames(new AbortController().signal,{
    ready:()=>true,covered:analysis=>coveredSavedAcquisition(analysis,new Map([['known',10]])),skipped:()=>{},
   }))assert.fail('failed frames must not be yielded');
  },/test read error/);
  assert.deepEqual(requests.filter(r=>r.read).map(r=>r.read),[2]);
  assert.equal(errors.length,1);assert.match(errors[0],/test read error/);assert.ok(terminated()>=1);
 });
});

test('parallel coverage skips an old exact original but still reads a later unknown change and revokes completion',async()=>{
 await replayHarness(async({encoder,requests,rasterizations})=>{
  for(let id=1;id<=3;id++)encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,id,id*1000);
  encoder.attachAnalysis(1,receipt('known',10));
  // Frame 2 has no receipt and can contain a newer count. Frame 3 was once
  // covered, but must remain available after that newer identity invalidates it.
  encoder.attachAnalysis(3,receipt('known',10));
  const state:CaptureCompletion&{inputClosed:boolean;headerVerified:boolean;metadataSettled:boolean;tailFresh:boolean;dropped:number;pending:number;unresolved:number}={
   expected:1,finalExpected:1,cards:[{id:'known',name:'known',awakening:0,extraCopies:2,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
   latest:new Map([['known',10]]),confirmedNames:new Map([['known',10]]),confirmed:new Map([['known',10]]),
   inputSettled:false,inputClosed:true,headerAvailable:true,headerVerified:true,metadataSettled:true,tailFresh:true,dropped:0,pending:80,unresolved:1,
  };
  const skipped:number[]=[],seen:number[]=[];
  for await(const frame of encoder.frames(new AbortController().signal,{
   ready:()=>canSkipCoveredOriginals(state),covered:analysis=>coveredSavedAcquisition(analysis,state.confirmed),skipped:count=>skipped.push(count),
  })) {
   seen.push(frame.time);
   if(frame.time===2){state.latest=new Map([['known',20]]);state.confirmedNames=new Map([['known',20]]);}
  }
  assert.deepEqual(skipped,[1]);assert.deepEqual(seen,[2,3]);
  assert.deepEqual(requests.filter(request=>request.read).map(request=>request.read),[2,3]);
  assert.equal(rasterizations(),2);assert.equal(state.cards[0].extraCopies,2,'old display values are not a new field proof');
  assert.equal(canFinishEndedCapture({...state,pending:0,inputSettled:true}),false,'unknown newer fields must still be re-read');
 });
});

test('exhausting covered originals still joins a running reader before checking latest completion',{timeout:1000},async()=>{
 await replayHarness(async({encoder,requests})=>{
  encoder.submit({displayWidth:1,displayHeight:1} as VideoFrame,1,1000);encoder.attachAnalysis(1,receipt('known',10));
  const state:CaptureCompletion&{inputClosed:boolean;headerVerified:boolean;metadataSettled:boolean;tailFresh:boolean;dropped:number;pending:number;unresolved:number}={
   expected:1,finalExpected:1,cards:[{id:'known',name:'known',awakening:0,extraCopies:2,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1}],
   latest:new Map([['known',10]]),confirmedNames:new Map([['known',10]]),confirmed:new Map([['known',10]]),
   inputSettled:false,inputClosed:true,headerAvailable:true,headerVerified:true,metadataSettled:true,tailFresh:true,dropped:0,pending:1,unresolved:0,
  };
  let release!:()=>void,started!:()=>void,settled=false;
  const active=new Promise<void>(resolve=>{release=resolve;}),begun=new Promise<void>(resolve=>{started=resolve;});
  const inputs=encoder.frames(new AbortController().signal,{
   ready:()=>canSkipCoveredOriginals(state),covered:value=>coveredSavedAcquisition(value,state.confirmed),skipped:()=>{},
  });
  const running=runRecoveryPipeline(inputs,new AbortController().signal,{
   lanes:1,pending:()=>state.pending,collect:async()=>assert.fail('all originals are individually covered'),
   consume:async()=>{state.pending--;started();await active;state.latest=new Map([['known',20]]);state.confirmedNames=new Map([['known',20]]);return true;},
  }).then(()=>{settled=true;});
  await begun;for(let n=0;n<20;n++)await Promise.resolve();
  assert.equal(settled,false,'ending originals must not cancel or detach accepted work');
  assert.deepEqual(requests.filter(request=>request.read),[]);
  release();await running;
  assert.equal(canFinishEndedCapture({...state,inputSettled:true}),false,'a joined newer failure must still revoke the old field proof');
 });
});
