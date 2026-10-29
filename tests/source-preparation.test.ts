import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourcePreparation} from '../src/features/card-scanner/source-preparation';
import {createSourcePreparationWorkerRuntime,type PreparationFrame,type SourcePreparationPlatform} from '../src/features/card-scanner/source-preparation-worker';
import {parsePreparedSource} from '../src/features/card-scanner/source-preparation-protocol';
import {prepareNativeStorage} from '../src/features/card-scanner/native-frame-storage';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';
import {createPreparedNativeAttestationInbox,parsePreparedNativeAttestation,verifyAttestedPreparedNative} from '../src/features/card-scanner/prepared-native-attestation';
import {restoreFrameStorage} from '../src/features/card-scanner/native-frame-storage';

const binding={sourceFrameId:17,captureTime:1.75};
function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function frame(change:Record<string,unknown>={},copy?:()=>Promise<void>){
 let closes=0,copies=0,allocations=0;
 const data=Uint8Array.from([16,80,160,235,70,190]);
 const value={tag:'frame',displayWidth:2,displayHeight:2,codedWidth:2,codedHeight:2,format:'I420',
  visibleRect:{x:0,y:0,width:2,height:2},rotation:0,flip:false,
  colorSpace:{toJSON:()=>({primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false})},
  allocationSize(){allocations++;return 6;},
  async copyTo(pixels:Uint8Array,options:VideoFrameCopyToOptions){copies++;await copy?.();pixels.set(data);return options.layout;},
  close(){closes++;},...change}as unknown as PreparationFrame;
 return {value,closes:()=>closes,copies:()=>copies,allocations:()=>allocations};
}
function bitmap(){let closes=0;return {value:{tag:'bitmap',width:2,height:2,close(){closes++;}},closes:()=>closes};}
function platform(change:Partial<SourcePreparationPlatform>={}){
 const draws:unknown[]=[],canvases:{width:number;height:number}[]=[],raw=Uint8ClampedArray.from({length:16},(_,i)=>i*13%256);
 const result:SourcePreparationPlatform={
  isFrame:(value):value is PreparationFrame=>!!value&&typeof value==='object'&&(value as {tag?:unknown}).tag==='frame',
  isBitmap:(value):value is never=>!!value&&typeof value==='object'&&(value as {tag?:unknown}).tag==='bitmap',
  createCanvas(width,height){const canvas={width,height,getContext(){return {
   drawImage(input:unknown){draws.push(input);},getImageData(){return {data:raw.slice()};}};}};canvases.push(canvas);return canvas;},...change};
 return {value:result,draws,canvases,raw};
}
function runtime(change:Partial<SourcePreparationPlatform>={}){
 const p=platform(change),messages:any[]=[],transfers:Transferable[][]=[];
 const runtime=createSourcePreparationWorkerRuntime({postMessage(value,transfer=[]){transfers.push(transfer);
  messages.push(structuredClone(value,{transfer}));}},p.value);
 return {...p,runtime,messages,transfers,async start(attestation?:unknown){await runtime.handle({kind:'init',...(attestation?{attestation}:{})});},
  run(input:unknown,id=1,attest?:boolean,mode?:'auto'|'canvas'){
   return runtime.handle({kind:'prepare',id,input,binding,...(attest===undefined?{}:{attest}),...(mode===undefined?{}:{mode})});}};
}

test('native runtime copies packed planes once, transfers independent native and generated RGBA, closes exact source',async()=>{
 const h=runtime(),source=frame();await h.start();await h.run(source.value);
 const response=h.messages.find(message=>message.kind==='prepared'),result=parsePreparedSource(response.result);
 assert.equal(source.copies(),1);assert.equal(source.allocations(),1);assert.equal(source.closes(),1);assert.equal(h.draws.length,0);
 assert.equal(result.mode,'native');assert.equal(result.outputBytes,22);assert.equal(result.reservationBytes,32);
 assert.deepEqual(result.binding,binding);assert.equal(await pixelHash(result.pixels),result.hash);
 assert.ok(result.storage.kind==='native');assert.notEqual(result.storage.pixels.buffer,result.pixels.buffer);
 assert.equal(h.transfers.at(-1)!.length,2);assert.ok(h.transfers.at(-1)!.every(buffer=>(buffer as ArrayBuffer).byteLength===0));
 assert.equal(h.runtime.stats.active,0);
});

test('known unsupported color and bitmap fallback draw SAME retained input once and produce identical independent bytes',async()=>{
 for(const source of [frame({format:'RGBA'}),bitmap()]){
  const h=runtime();await h.start();await h.run(source.value);
  const result=parsePreparedSource(h.messages.find(message=>message.kind==='prepared').result);
  assert.equal(result.mode,'rgba');assert.equal(h.draws.length,1);assert.equal(h.draws[0],source.value);
  assert.equal(source.closes(),1);assert.ok(result.storage.kind==='rgba');
  assert.deepEqual(result.pixels,new Uint8Array(h.raw));assert.deepEqual(new Uint8Array(result.storage.pixels),result.pixels);
  assert.notEqual(result.storage.pixels,result.pixels.buffer);assert.equal(await pixelHash(result.pixels),result.hash);
  assert.deepEqual(h.canvases.map(canvas=>[canvas.width,canvas.height]),[[0,0]]);
 }
});

test('canvas selector draws the same supported frame once without reading native metadata, copying planes or converting',async()=>{
 let conversions=0;
 const h=runtime({native:async()=>{conversions++;throw Error('native converter must not run');}}),source=frame();
 Object.defineProperty(source.value,'colorSpace',{get(){throw Error('native descriptor must not be read');}});
 await h.start();await h.run(source.value,1,undefined,'canvas');
 const result=parsePreparedSource(h.messages.find(message=>message.kind==='prepared').result);
 assert.equal(result.mode,'rgba');assert.equal(result.fallbackReason,'canvas-requested');
 assert.equal(source.copies(),0);assert.equal(source.allocations(),0);assert.equal(conversions,0);assert.equal(source.closes(),1);
 assert.deepEqual(h.draws,[source.value]);assert.equal(result.outputBytes,32);assert.equal(result.reservationBytes,32);
 assert.ok(result.storage.kind==='rgba');assert.deepEqual(result.pixels,new Uint8Array(h.raw));
 assert.deepEqual(new Uint8Array(result.storage.pixels),result.pixels);assert.notEqual(result.storage.pixels,result.pixels.buffer);
 assert.equal(await pixelHash(result.pixels),result.hash);assert.equal(await pixelHash(new Uint8Array(result.storage.pixels)),result.hash);
 const original=result.pixels[0];new Uint8Array(result.storage.pixels)[0]^=255;assert.equal(result.pixels[0],original);
 assert.equal(h.transfers.at(-1)!.length,2);assert.ok(h.transfers.at(-1)!.every(buffer=>(buffer as ArrayBuffer).byteLength===0));
 assert.deepEqual(h.canvases.map(canvas=>[canvas.width,canvas.height]),[[0,0]]);
});

test('explicit auto keeps supported native preparation and its output schema unchanged',async()=>{
 const h=runtime(),source=frame();await h.start();await h.run(source.value,1,undefined,'auto');
 const result=parsePreparedSource(h.messages.find(message=>message.kind==='prepared').result);
 assert.equal(result.mode,'native');assert.equal(Object.hasOwn(result,'fallbackReason'),false);
 assert.equal(source.copies(),1);assert.equal(source.allocations(),1);assert.equal(source.closes(),1);assert.equal(h.draws.length,0);
});

test('alpha-frame and bitmap fallback hash the actual default Canvas RGBA readback and preserve independent storage bytes',async()=>{
 const raw=Uint8ClampedArray.from([0,0,0,0,8,16,24,128,11,22,33,64,55,66,77,255]);
 for(const source of [frame({format:'I420A'}),bitmap()]){
  const draws:unknown[]=[],contexts:unknown[]=[],reads:unknown[]=[];
  const h=runtime({createCanvas:(width,height)=>({width,height,getContext(type,options){contexts.push([type,options]);return {
   drawImage(input,x,y,w,h){draws.push([input,x,y,w,h]);},getImageData(x,y,w,h){reads.push([x,y,w,h]);return {data:raw.slice()};}};}})});
  await h.start();await h.run(source.value);
  const result=parsePreparedSource(h.messages.find(message=>message.kind==='prepared').result);
  assert.equal(result.mode,'rgba');assert.ok(result.fallbackReason);assert.notEqual(result.fallbackReason,'canvas-requested');
  assert.deepEqual(contexts,[['2d',{willReadFrequently:true}]]);assert.deepEqual(draws,[[source.value,0,0,2,2]]);
  assert.deepEqual(reads,[[0,0,2,2]]);assert.deepEqual(result.pixels,new Uint8Array(raw));assert.ok(result.storage.kind==='rgba');
  assert.deepEqual(new Uint8Array(result.storage.pixels),new Uint8Array(raw));assert.notEqual(result.storage.pixels,result.pixels.buffer);
  assert.equal(await pixelHash(result.pixels),result.hash);assert.equal(source.closes(),1);
 }
});

test('malformed runtime selectors fail closed before source work and close each rejected owned input once',async()=>{
 const h=runtime();await h.start();let id=0;
 for(const mode of [undefined,null,'','native','rgba','Canvas',false,0,{},[]]){
  const source=frame(),request={kind:'prepare',id:++id,input:source.value,binding,mode};
  await h.runtime.handle(request);await h.runtime.handle(request);
  assert.equal(source.closes(),1);assert.equal(source.copies(),0);assert.equal(source.allocations(),0);
 }
 assert.equal(h.draws.length,0);assert.equal(h.messages.some(message=>message.kind==='prepared'),false);
 assert.ok(h.messages.some(message=>message.error?.includes('selector')));
});

test('forced Canvas errors close the retained frame once without native retry',async()=>{
 const context=(failure:string)=>({drawImage(){if(failure==='draw')throw Error('draw failed');},
  getImageData(){if(failure==='read')throw Error('read failed');return {data:new Uint8ClampedArray(failure==='size'?1:16)};}});
 for(const failure of ['context','draw','read','size','hash']as const){
  let conversions=0;
  const h=runtime({native:async()=>{conversions++;throw Error('native retry forbidden');},
   createCanvas:(width,height)=>({width,height,getContext:()=>failure==='context'?null:context(failure)}),
   ...(failure==='hash'?{hash:async()=>{throw Error('hash failed');}}:{})}),source=frame();
  await h.start();await h.run(source.value,1,undefined,'canvas');
  assert.equal(source.closes(),1);assert.equal(source.copies(),0);assert.equal(source.allocations(),0);assert.equal(conversions,0);
  assert.equal(h.messages.some(message=>message.kind==='prepared'),false);assert.equal(h.messages.at(-1).kind,'preparation-error');
 }
});

test('forced Canvas disposal joins active hashing, closes the same input once and suppresses late output',async()=>{
 const gate=deferred<string>(),h=runtime({hash:()=>gate.promise}),source=frame();await h.start();
 const work=h.run(source.value,1,undefined,'canvas');await Promise.resolve();assert.equal(h.runtime.stats.active,1);
 const disposal=h.runtime.handle({kind:'dispose'});await Promise.resolve();assert.equal(source.closes(),0);
 assert.equal(h.messages.some(message=>message.kind==='disposed'),false);
 gate.resolve(await pixelHash(new Uint8Array(h.raw)));await Promise.all([work,disposal]);
 assert.equal(source.closes(),1);assert.equal(source.copies(),0);assert.deepEqual(h.draws,[source.value]);
 assert.equal(h.messages.some(message=>message.kind==='prepared'),false);assert.equal(h.messages.at(-1).kind,'disposed');
 await h.runtime.handle({kind:'prepare',id:2,input:source.value,binding,mode:'canvas'});assert.equal(source.closes(),1);
});

test('runtime copy failure, wrong allocation/layout and getter errors fail without raw recapture',async()=>{
 for(const change of [{allocationSize:()=>7},{copyTo:async()=>[{offset:0,stride:4}]},
  {copyTo:async()=>{throw Error('copy rejected');}}, {colorSpace:{toJSON(){throw Error('getter rejected');}}}]){
  const h=runtime(),source=frame(change);await h.start();await h.run(source.value);
  assert.ok(h.messages.some(message=>message.kind==='preparation-error'));
  assert.equal(h.messages.some(message=>message.kind==='prepared'),false);assert.equal(h.draws.length,0);assert.equal(source.closes(),1);
 }
});

test('hash and raw raster failures remain failed inputs rather than guessed native fallback',async()=>{
 for(const change of [{hash:async()=>{throw Error('hash failed');}},{hash:async()=> 'invalid'},
  {createCanvas:()=>{throw Error('canvas failed');}}]as Partial<SourcePreparationPlatform>[]){
  const h=runtime(change),source=bitmap();await h.start();await h.run(source.value);
  assert.equal(source.closes(),1);assert.ok(h.messages.some(message=>message.kind==='preparation-error'));
  assert.equal(h.messages.some(message=>message.kind==='prepared'),false);
 }
 const h=runtime({native:async(meta,pixels)=>({...await prepareNativeStorage(meta,pixels),rgbaHash:'invalid'})}),source=frame();
 await h.start();await h.run(source.value);assert.ok(h.messages.some(message=>message.kind==='preparation-error'));
 assert.equal(source.closes(),1);assert.equal(h.draws.length,0);
});

test('runtime keeps active handle until hung copy settles; busy handles close immediately without queue',async()=>{
 const gate=deferred(),h=runtime(),first=frame({},()=>gate.promise),second=frame();await h.start();
 const work=h.run(first.value);await Promise.resolve();assert.equal(h.runtime.stats.active,1);
 await h.run(second.value,2);assert.equal(second.closes(),1);assert.equal(second.copies(),0);assert.equal(first.closes(),0);
 await h.run(first.value,3);assert.equal(first.closes(),0,'repeated same active object must not close the owner in-flight');
 gate.resolve();await work;assert.equal(first.closes(),1);assert.equal(h.messages.filter(message=>message.kind==='prepared').length,1);
});

test('cooperative runtime dispose joins ownership and prevents late prepared response',async()=>{
 const gate=deferred(),h=runtime(),source=frame({},()=>gate.promise);await h.start();
 const work=h.run(source.value);await Promise.resolve();const disposal=h.runtime.handle({kind:'dispose'});
 await Promise.resolve();assert.equal(source.closes(),0);assert.equal(h.messages.some(message=>message.kind==='disposed'),false);
 gate.resolve();await Promise.all([work,disposal]);assert.equal(source.closes(),1);
 assert.equal(h.messages.some(message=>message.kind==='prepared'),false);assert.equal(h.messages.at(-1).kind,'disposed');
});

test('malformed protocols and over-budget dimensions close rejected sources without retaining a queue',async()=>{
 const h=runtime();await h.start();
 for(const build of [(input:unknown)=>({kind:'prepare',id:1,input,binding:{...binding,extra:true}}),
  (input:unknown)=>({kind:'prepare',id:2,input,binding,extra:true}),(input:unknown)=>({kind:'dispose',input}),
  (input:unknown)=>input]){
  const source=frame();await h.runtime.handle(build(source.value));assert.equal(source.closes(),1);assert.equal(source.copies(),0);
 }
 const source=frame({displayWidth:8192,displayHeight:8192});await h.run(source.value,10);assert.equal(source.closes(),1);assert.equal(source.copies(),0);
});

test('close failure prevents a successful source receipt',async()=>{
 const h=runtime(),source=frame({close(){throw Error('native close failed');}});await h.start();await h.run(source.value);
 assert.equal(h.messages.some(message=>message.kind==='prepared'),false);assert.ok(h.messages.at(-1).error.includes('close failed'));
});

function workerHarness(options:{platform?:Partial<SourcePreparationPlatform>;ignoreInit?:boolean;ignoreDispose?:boolean;manual?:boolean}={}){
 let instance:any;const p=platform(options.platform);
 class FakeWorker{
  onmessage:any;onerror:any;onmessageerror:any;terminated=false;messages:any[]=[];
  runtime=createSourcePreparationWorkerRuntime({postMessage:(value,transfer=[])=>{const cloned=structuredClone(value,{transfer});
   queueMicrotask(()=>this.onmessage?.({data:cloned}));}},p.value);
  constructor(){instance=this;}
  postMessage(value:any,transfer?:Transferable[]){this.messages.push(value);
   if(value.kind==='init'&&options.ignoreInit||value.kind==='dispose'&&options.ignoreDispose||value.kind==='prepare'&&options.manual)return;
   void this.runtime.handle(value.kind==='init'&&value.attestation?structuredClone(value,{transfer}):value);}
  terminate(){this.terminated=true;}
 }
 return {create:()=>new FakeWorker(),get worker(){return instance;},platform:p};
}

test('client transfers one source, checks bound response, and exposes separate output ownership and reservation',async()=>{
 const h=workerHarness(),controller=new AbortController(),client=await createSourcePreparation(controller.signal,{createWorker:h.create});
 const source=frame(),result=await client.prepare(source.value as VideoFrame,binding);
 assert.equal(result.binding.sourceFrameId,17);assert.equal(client.stats.completed,1);assert.equal(client.stats.pendingBytes,0);
 assert.equal(client.stats.peakPendingBytes,32);assert.equal(source.closes(),1);
 assert.equal(client.stats.preparationMode,'auto');assert.equal(client.stats.lastCompletedMode,'native');
 assert.equal(Object.hasOwn(h.worker.messages.find((value:any)=>value.kind==='prepare'),'mode'),false);
 assert.deepEqual(h.worker.messages[0],{kind:'init'});
 await client.dispose();assert.equal(h.worker.terminated,true);assert.equal(client.stats.terminated,true);
});

test('client Canvas option selects the existing raster path and reports validated actual mode with unchanged reservations',async()=>{
 const h=workerHarness(),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create,mode:'canvas'}),source=frame();
 assert.equal(client.stats.preparationMode,'canvas');assert.equal(client.stats.lastCompletedMode,undefined);
 const result=await client.prepare(source.value as VideoFrame,binding);
 assert.equal(result.mode,'rgba');assert.equal(result.fallbackReason,'canvas-requested');assert.ok(result.storage.kind==='rgba');
 assert.deepEqual(result.pixels,new Uint8Array(h.platform.raw));assert.deepEqual(new Uint8Array(result.storage.pixels),result.pixels);
 assert.notEqual(result.pixels.buffer,result.storage.pixels);assert.deepEqual(h.platform.draws,[source.value]);
 assert.equal(source.copies(),0);assert.equal(source.allocations(),0);assert.equal(source.closes(),1);
 assert.equal(h.worker.messages.find((value:any)=>value.kind==='prepare').mode,'canvas');assert.deepEqual(h.worker.messages[0],{kind:'init'});
 assert.equal(client.stats.completed,1);assert.equal(client.stats.lastCompletedMode,'rgba');assert.equal(client.stats.pendingBytes,0);
 assert.equal(client.stats.peakPendingBytes,32);assert.equal(result.reservationBytes,32);assert.equal(result.outputBytes,32);
 await client.dispose();
});

test('client rejects malformed constructor selectors before Worker creation and consumes malformed request inputs once',async()=>{
 let created=0;
 for(const mode of [null,'','native','rgba','Canvas',false,0,{},[]])
  await assert.rejects(createSourcePreparation(new AbortController().signal,{mode:mode as never,
   createWorker:()=>{created++;throw Error('must not create');}}),/selector/);
 assert.equal(created,0);
 const h=workerHarness(),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create,mode:'canvas'}),source=frame();
 await assert.rejects(client.prepare(source.value as VideoFrame,binding,{mode:'native'} as never),/fields/);
 assert.equal(source.closes(),1);assert.equal(source.copies(),0);assert.equal(client.stats.lastCompletedMode,undefined);
 assert.equal(h.worker.messages.filter((value:any)=>value.kind==='prepare').length,0);await client.dispose();
});

test('Canvas client rejects a native result or an ambiguous raw fallback instead of reporting configured selection as actual',async()=>{
 const native=runtime(),raw=runtime();await native.start();await raw.start();await native.run(frame().value);await raw.run(bitmap().value);
 for(const template of [native.messages.find(message=>message.kind==='prepared').result,raw.messages.find(message=>message.kind==='prepared').result]){
  const h=workerHarness({manual:true}),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create,mode:'canvas'});
  const work=client.prepare(frame().value as VideoFrame,binding);
  h.worker.onmessage({data:{kind:'prepared',id:1,result:structuredClone(template)}});await assert.rejects(work,/selector mismatch/);
  assert.equal(client.stats.completed,0);assert.equal(client.stats.lastCompletedMode,undefined);assert.equal(h.worker.terminated,true);await client.dispose();
 }
});

test('client busy and invalid/budgeted sources are closed immediately and never posted',async()=>{
 const gate=deferred(),h=workerHarness(),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create}),
  first=frame({},()=>gate.promise),second=frame();
 const work=client.prepare(first.value as VideoFrame,binding);await assert.rejects(client.prepare(second.value as VideoFrame,binding),/busy/);
 assert.equal(second.closes(),1);assert.equal(second.copies(),0);assert.equal(client.stats.pending,1);
 gate.resolve();await work;
 const invalid=frame();await assert.rejects(client.prepare(invalid.value as VideoFrame,{...binding,sourceFrameId:0}));assert.equal(invalid.closes(),1);
 assert.equal(h.worker.messages.filter((message:any)=>message.kind==='prepare').length,1);await client.dispose();
 const bounded=workerHarness(),small=await createSourcePreparation(new AbortController().signal,{createWorker:bounded.create,maxPendingBytes:31}),source=frame();
 await assert.rejects(small.prepare(source.value as VideoFrame,binding),/reservation/);assert.equal(source.closes(),1);await small.dispose();
});

test('client timeout terminates transferred ownership and ignores late responses',async()=>{
 const h=workerHarness({manual:true}),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create,timeoutMs:10}),source=frame();
 const work=client.prepare(source.value as VideoFrame,binding);await assert.rejects(work,/timeout/);
 assert.equal(h.worker.terminated,true);assert.equal(client.stats.pendingBytes,0);
 h.worker.onmessage?.({data:{kind:'prepared',id:1,result:{}}});assert.equal(client.stats.completed,0);
 const later=frame();await assert.rejects(client.prepare(later.value as VideoFrame,binding),/closed/);assert.equal(later.closes(),1);await client.dispose();
});

test('abort rejects active job, kills worker, and cannot publish success later',async()=>{
 const h=workerHarness({manual:true}),controller=new AbortController(),client=await createSourcePreparation(controller.signal,{createWorker:h.create}),source=frame();
 const work=client.prepare(source.value as VideoFrame,binding);controller.abort(new DOMException('test abort','AbortError'));
 await assert.rejects(work,{name:'AbortError'});assert.equal(h.worker.terminated,true);assert.equal(client.stats.pending,0);await client.dispose();
});

test('dispose deadline kills hung ownership after bounded cooperative join',async()=>{
 const h=workerHarness({manual:true,ignoreDispose:true}),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create,disposeTimeoutMs:10}),source=frame();
 const rejected=assert.rejects(client.prepare(source.value as VideoFrame,binding),{name:'AbortError'});
 await client.dispose();await rejected;assert.equal(h.worker.terminated,true);assert.equal(client.stats.pendingBytes,0);
});

test('malformed identity, source binding and aliased output kill the client instead of returning a receipt',async()=>{
 const valid=runtime(),source=frame();await valid.start();await valid.run(source.value);
 const prepared=valid.messages.find(message=>message.kind==='prepared').result;
 for(const mutate of [(value:any)=>({...value,id:2}),
  (value:any)=>({...value,result:{...value.result,binding:{...binding,captureTime:2}}}),
  (value:any)=>({...value,result:{...value.result,storage:{kind:'rgba',pixels:value.result.pixels.buffer},mode:'rgba',fallbackReason:'test',outputBytes:32}})]){
  const h=workerHarness({manual:true}),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create}),input=frame();
  const work=client.prepare(input.value as VideoFrame,binding);h.worker.onmessage({data:mutate({kind:'prepared',id:1,result:structuredClone(prepared)})});
  await assert.rejects(work);assert.equal(h.worker.terminated,true);await client.dispose();
 }
});

test('readiness failure has no transferred input and rejects cleanly',async()=>{
 const h=workerHarness({ignoreInit:true});
 await assert.rejects(createSourcePreparation(new AbortController().signal,{createWorker:h.create,readyTimeoutMs:10}),/readiness timeout/);
 assert.equal(h.worker.terminated,true);
 const controller=new AbortController();controller.abort();let created=0;
 await assert.rejects(createSourcePreparation(controller.signal,{createWorker:()=>{created++;return h.create();}}),{name:'AbortError'});
 assert.equal(created,0);
});

test('source close failure is fatal to the client instead of leaving uncertain worker ownership alive',async()=>{
 const h=workerHarness(),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create}),
  source=frame({close(){throw Error('close failed');}});
 await assert.rejects(client.prepare(source.value as VideoFrame,binding),/close failed/);
 assert.equal(h.worker.terminated,true);assert.equal(client.stats.completed,0);await client.dispose();
});

test('failed transfer closes only the still-owned input and can safely accept a later input',async()=>{
 const h=workerHarness(),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create}),
  post=h.worker.postMessage.bind(h.worker),first=frame();let fail=true;
 h.worker.postMessage=(value:any,transfer:any)=>{if(value.kind==='prepare'&&fail){fail=false;throw Error('transfer rejected');}post(value,transfer);};
 await assert.rejects(client.prepare(first.value as VideoFrame,binding),/transfer rejected/);assert.equal(first.closes(),1);
 assert.equal(client.stats.pendingBytes,0);const second=frame();await client.prepare(second.value as VideoFrame,{...binding,sourceFrameId:18});
 assert.equal(second.closes(),1);assert.equal(client.stats.completed,1);await client.dispose();
});

test('abort during worker creation is rechecked before any readiness wait',async()=>{
 const h=workerHarness(),controller=new AbortController();
 await assert.rejects(createSourcePreparation(controller.signal,{createWorker:()=>{
  controller.abort(new DOMException('creation aborted','AbortError'));return h.create();}}),{name:'AbortError'});
 assert.equal(h.worker.terminated,true);assert.equal(h.worker.messages.length,0);
});

const identity={version:1 as const,sessionId:'attestation-session',producerId:'preparation-worker'},ticket='00000000-0000-4000-8000-000000000001';
function privatePort(post?:(value:unknown)=>void){
 const tuples:unknown[]=[];let closed=0;
 const value={postMessage(tuple:unknown){post?.(tuple);tuples.push(structuredClone(tuple));},close(){closed++;}} as unknown as MessagePort;
 return {value,tuples,closed:()=>closed};
}

test('native attestation is issued only on the private capability after successful input cleanup',async()=>{
 const source=frame(),port=privatePort(value=>{assert.equal(source.closes(),1);assert.ok(Object.values(value as object).every(field=>typeof field==='string'||typeof field==='number'));});
 const h=runtime({isAttestationPort:(value):value is MessagePort=>value===port.value,randomUUID:()=>ticket});
 await h.start({...identity,port:port.value});assert.deepEqual(h.messages[0],{kind:'ready',attestation:identity});
 await h.run(source.value,1,true);assert.equal(port.tuples.length,1);
 const tuple=parsePreparedNativeAttestation(port.tuples[0]),response=h.messages.find(value=>value.kind==='prepared'),result=parsePreparedSource(response.result);
 assert.equal(tuple.ticketId,ticket);assert.equal(tuple.requestId,1);assert.equal(tuple.sourceFrameId,binding.sourceFrameId);
 assert.equal(tuple.captureTime,binding.captureTime);assert.equal(tuple.generatedRgbaSha256,result.hash);
 assert.equal(tuple.nativeByteLength,6);assert.equal(tuple.rgbaByteLength,16);assert.equal(tuple.width,2);assert.equal(tuple.height,2);
 assert.ok(result.storage.kind==='native');assert.equal(result.storage.ticketId,ticket);assert.equal(source.copies(),1);
 assert.deepEqual(Object.keys(result.storage).sort(),['descriptor','kind','pixels','ticketId']);
 await h.runtime.handle({kind:'dispose'});assert.equal(port.closed(),1);
});

test('default and false requests keep old output keys and raw fallback never receives a native ticket',async()=>{
 const port=privatePort(),h=runtime({isAttestationPort:(value):value is MessagePort=>value===port.value,randomUUID:()=>ticket});
 await h.start({...identity,port:port.value});
 await h.run(frame().value,1);await h.run(frame().value,2,false);await h.run(bitmap().value,3,true);await h.run(frame({format:'RGBA'}).value,4,true);
 const forced=frame();await h.run(forced.value,5,true,'canvas');assert.equal(forced.copies(),0);assert.equal(forced.closes(),1);
 const results=h.messages.filter(value=>value.kind==='prepared').map(value=>parsePreparedSource(value.result));
 assert.equal(results.length,5);assert.equal(port.tuples.length,0);
 for(const result of results)assert.equal(Object.hasOwn(result.storage,'ticketId'),false);
 assert.deepEqual(Object.keys(results[0].storage).sort(),['descriptor','kind','pixels']);
 assert.deepEqual(results.map(value=>value.mode),['native','native','rgba','rgba','rgba']);assert.equal(results[4].fallbackReason,'canvas-requested');
 await h.runtime.handle({kind:'dispose'});
});

test('without a configured capability true requests close owned inputs before copy in both client and runtime',async()=>{
 const h=runtime(),input=frame();await h.start();await h.run(input.value,1,true);
 assert.equal(input.closes(),1);assert.equal(input.copies(),0);assert.equal(h.messages.some(value=>value.kind==='prepared'),false);
 const w=workerHarness(),client=await createSourcePreparation(new AbortController().signal,{createWorker:w.create}),owned=frame();
 await assert.rejects(client.prepare(owned.value as VideoFrame,binding,{attest:true}),/capability unavailable/);
 assert.equal(owned.closes(),1);assert.equal(w.worker.messages.filter((value:any)=>value.kind==='prepare').length,0);await client.dispose();
});

test('private capability init is strict, cannot be replaced by a second init, and releases rejected ports',async()=>{
 const first=privatePort(),second=privatePort(),h=runtime({isAttestationPort:(value):value is MessagePort=>value===first.value||value===second.value,randomUUID:()=>ticket});
 await h.start({...identity,port:first.value});await h.start({...identity,producerId:'replacement',port:second.value});
 assert.equal(second.closed(),1);assert.equal(first.closed(),0);await h.run(frame().value,1,true);
 assert.equal(parsePreparedNativeAttestation(first.tuples[0]).producerId,identity.producerId);assert.equal(second.tuples.length,0);
 await h.runtime.handle({kind:'dispose'});assert.equal(first.closed(),1);
 for(const change of [{version:2},{sessionId:'space forbidden'},{producerId:''},{producerId:'x'.repeat(129)}]){
  const rejected=privatePort(),r=runtime({isAttestationPort:(value):value is MessagePort=>value===rejected.value});
  await r.start({...identity,...change,port:rejected.value});assert.equal(rejected.closed(),1);
  assert.equal(r.messages.some(value=>value.kind==='ready'),false);
 }
});

test('copy, hash, alias, ticket and cleanup errors issue no private tuple and never recapture raw pixels',async()=>{
 for(const failure of ['copy','hash','alias','ticket','cleanup'] as const){
  const port=privatePort(),h=runtime({isAttestationPort:(value):value is MessagePort=>value===port.value,
   randomUUID:()=>failure==='ticket'?'not-uuid':ticket,
   ...(failure==='hash'?{native:async()=>{throw Error('native hash failure');}}:{}),
   ...(failure==='alias'?{native:async(meta,pixels)=>({...await prepareNativeStorage(meta,pixels),pixels})}:{}),
  });
  const source=frame(failure==='copy'?{copyTo:async()=>{throw Error('copy failure');}}:failure==='cleanup'?{close(){throw Error('close failure');}}:{});
  await h.start({...identity,port:port.value});await h.run(source.value,1,true);
  assert.equal(port.tuples.length,0);assert.equal(h.messages.some(value=>value.kind==='prepared'),false);assert.equal(h.draws.length,0);
  await h.runtime.handle({kind:'dispose'});
 }
});

test('dispose joins active copy and suppresses attestation; private post failures cannot return a usable ticket',async()=>{
 const gate=deferred(),port=privatePort(),h=runtime({isAttestationPort:(value):value is MessagePort=>value===port.value,randomUUID:()=>ticket}),source=frame({},()=>gate.promise);
 await h.start({...identity,port:port.value});const work=h.run(source.value,1,true);await Promise.resolve();
 const disposal=h.runtime.handle({kind:'dispose'});gate.resolve();await Promise.all([work,disposal]);
 assert.equal(port.tuples.length,0);assert.equal(source.closes(),1);assert.equal(port.closed(),1);
 const failedPort=privatePort(()=>{throw Error('private post failed');}),failed=runtime({isAttestationPort:(value):value is MessagePort=>value===failedPort.value,randomUUID:()=>ticket});
 await failed.start({...identity,port:failedPort.value});await failed.run(frame().value,1,true);
 assert.equal(failed.messages.some(value=>value.kind==='prepared'),false);assert.equal(failed.messages.at(-1).fatal,true);assert.equal(failedPort.closed(),1);
});

test('main reply failure after issuance leaves only a bounded orphan tuple and no successful prepared result',async()=>{
 const p=platform(),port=privatePort(),messages:any[]=[],input=frame();
 const worker=createSourcePreparationWorkerRuntime({postMessage(value:any){if(value.kind==='prepared')throw Error('main reply failed');messages.push(value);}},
  {...p.value,isAttestationPort:(value):value is MessagePort=>value===port.value,randomUUID:()=>ticket});
 await worker.handle({kind:'init',attestation:{...identity,port:port.value}});await worker.handle({kind:'prepare',id:1,input:input.value,binding,attest:true});
 assert.equal(input.closes(),1);assert.equal(port.tuples.length,1);assert.equal(messages.at(-1).kind,'preparation-error');assert.equal(messages.at(-1).fatal,true);
 assert.equal(port.closed(),1);assert.equal(messages.some(value=>value.kind==='prepared'),false);
});

test('ticket parsing is shape-only, native-only and strictly UUID; it grants no verifier authority',async()=>{
 const h=runtime();await h.start();await h.run(frame().value);const original=h.messages.find(value=>value.kind==='prepared').result;
 const shape=parsePreparedSource({...original,storage:{...original.storage,ticketId:ticket}});assert.ok(shape.storage.kind==='native');
 assert.equal(shape.storage.ticketId,ticket);
 for(const ticketId of ['',undefined,0,'00000000-0000-0000-8000-000000000001',ticket.toUpperCase()+'x'])
  assert.throws(()=>parsePreparedSource({...original,storage:{...original.storage,ticketId}}));
 const raw=runtime();await raw.start();await raw.run(bitmap().value);const result=raw.messages.find(value=>value.kind==='prepared').result;
 assert.throws(()=>parsePreparedSource({...result,storage:{...result.storage,ticketId:ticket}}));
});

test('configured real private port connects actual source preparation to one-shot verification and exact full-RGBA restore',async()=>{
 const channel=new MessageChannel(),inbox=createPreparedNativeAttestationInbox(channel.port1,identity),h=workerHarness();
 const client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create,
  attestation:{port:channel.port2,sessionId:identity.sessionId,producerId:identity.producerId}});
 try{
  const ordinary=await client.prepare(frame().value as VideoFrame,binding);assert.equal(Object.hasOwn(ordinary.storage,'ticketId'),false);
  const source=frame(),result=await client.prepare(source.value as VideoFrame,binding,{attest:true});
  assert.ok(result.storage.kind==='native');assert.ok(result.storage.ticketId);assert.equal(source.closes(),1);
  const expected=result.pixels.slice(),authorized=await inbox.take(result.storage.ticketId,binding,2,2);
  const verified=await verifyAttestedPreparedNative(authorized,{descriptor:result.storage.descriptor,pixels:result.storage.pixels});
  assert.equal(result.storage.pixels.byteLength,0,'verifier consumes the returned native buffer');
  const restored=await restoreFrameStorage(verified.storage,2,2,verified.pixels,verified.hash);
  assert.deepEqual(restored,expected);assert.equal(await pixelHash(restored),result.hash);
  await assert.rejects(verifyAttestedPreparedNative(authorized,{descriptor:verified.storage.descriptor,pixels:verified.pixels}));
 }finally{await client.dispose();inbox.dispose();channel.port2.close();}
});

test('client rejects fake, used, malformed and aborted bootstrap capabilities before creating a worker',async()=>{
 let created=0;const options={createWorker:()=>{created++;throw Error('must not create');}};
 await assert.rejects(createSourcePreparation(new AbortController().signal,{...options,
  attestation:{port:{postMessage(){},close(){}} as MessagePort,sessionId:identity.sessionId,producerId:identity.producerId}}),/MessagePort/);
 for(const reason of ['identity','used','abort'] as const){
  const channel=new MessageChannel(),originalClose=channel.port2.close.bind(channel.port2);let closed=0;
  channel.port2.close=()=>{closed++;originalClose();};
  if(reason==='used')channel.port2.onmessage=()=>{};
  const signal=reason==='abort'?AbortSignal.abort(Error('already stopped')):new AbortController().signal;
  try{await assert.rejects(createSourcePreparation(signal,{...options,attestation:{port:channel.port2,
    sessionId:reason==='identity'?'invalid identity':identity.sessionId,producerId:identity.producerId}}));assert.equal(closed,1);}
  finally{channel.port1.close();originalClose();}
 }
 assert.equal(created,0);
});

test('configured handshake must echo the exact identity version before any source can transfer',async()=>{
 for(const changed of [{version:2},{sessionId:'other-session'},{producerId:'other-producer'}]){
  const channel=new MessageChannel();let worker:any,terminated=0;
  try{await assert.rejects(createSourcePreparation(new AbortController().signal,{attestation:{port:channel.port2,
    sessionId:identity.sessionId,producerId:identity.producerId},createWorker:()=>worker={onmessage:null,onerror:null,onmessageerror:null,
    postMessage(value:any,transfer:Transferable[]){const received=structuredClone(value,{transfer});received.attestation.port.close();
      queueMicrotask(()=>worker.onmessage?.({data:{kind:'ready',attestation:{...identity,...changed}}}));},terminate(){terminated++;}}}));
    assert.equal(terminated,1);
  }finally{channel.port1.close();channel.port2.close();}
 }
});

test('client rejects native response tickets that do not match explicit request presence',async()=>{
 const native=runtime();await native.start();await native.run(frame().value);const template=native.messages.find(value=>value.kind==='prepared').result;
 for(const attest of [true,false]){
  const channel=new MessageChannel(),h=workerHarness({manual:true}),client=await createSourcePreparation(new AbortController().signal,{createWorker:h.create,
   attestation:{port:channel.port2,sessionId:identity.sessionId,producerId:identity.producerId}});
  try{
   const owned=frame(),work=client.prepare(owned.value as VideoFrame,binding,{attest}),result=structuredClone(template);
   if(!attest)result.storage.ticketId=ticket;
   h.worker.onmessage({data:{kind:'prepared',id:1,result}});await assert.rejects(work,/requested ticket mismatch/);
   assert.equal(client.stats.completed,0);assert.equal(h.worker.terminated,true);
  }finally{await h.worker.runtime.handle({kind:'dispose'});await client.dispose();channel.port1.close();channel.port2.close();}
 }
});
