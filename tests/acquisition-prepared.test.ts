import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcquisitionClient} from '../src/features/card-scanner/acquisition-client';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const input=(id=7,time=3.25)=>({pixels:Uint8Array.from([10,20,30,255,50,60,70,255]),width:2,height:1,binding:{sourceFrameId:id,captureTime:time}});
async function until(predicate:()=>boolean){const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw Error('Prepared acquisition test timeout');await tick();}}
async function fixture(run:(h:any)=>Promise<void>,workerEnabled=true){
  const names=['Worker','OffscreenCanvas','createImageBitmap','document','ImageData','crypto','setTimeout','clearTimeout'],
    prior=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const canvases:any[]=[],workers:any[]=[],clients:ReturnType<typeof createAcquisitionClient>[]=[],requests:any[]=[];
  let bitmapCopies=0;
  class Canvas {
    private w=0;private h=0;pixels=new Uint8ClampedArray();puts=0;clears=0;draws=0;
    constructor(){canvases.push(this);}
    set width(value:number){this.w=value;this.pixels=new Uint8ClampedArray(this.w*this.h*4);}get width(){return this.w;}
    set height(value:number){this.h=value;this.pixels=new Uint8ClampedArray(this.w*this.h*4);}get height(){return this.h;}
    getContext(){return {putImageData:(value:any)=>{this.puts++;this.pixels=new Uint8ClampedArray(value.data);},
      getImageData:()=>({data:this.pixels.slice(),width:this.w,height:this.h}),
      clearRect:()=>{this.clears++;this.pixels.fill(0);},drawImage:()=>{this.draws++;}};}
  }
  class Worker {
    onmessage:any;onerror:any;terminated=false;
    constructor(){workers.push(this);}terminate(){this.terminated=true;}
    postMessage(value:any,transfer:any[]=[]){requests.push(value.kind==='prepared'?structuredClone(value,{transfer}):value);}
  }
  const set=(name:string,value:unknown)=>Object.defineProperty(globalThis,name,{configurable:true,value,writable:true});
  set('Worker',Worker);set('OffscreenCanvas',workerEnabled?class{}:undefined);
  set('createImageBitmap',async()=>{bitmapCopies++;return {width:2,height:1,close(){}};});
  set('ImageData',class{constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}});
  set('document',{createElement:()=>new Canvas()});
  const client=(options:any={},platform:any={})=>{const control=new AbortController(),value=createAcquisitionClient(control.signal,options,platform);clients.push(value);return {client:value,control};};
  const response=async(request:any)=>({id:request.id,cells:[],layout:null,
    rasterReceipt:{version:1,kind:'measured',...request.prepared.binding,acquisitionFrameId:request.id,
      width:request.prepared.width,height:request.prepared.height,hash:await pixelHash(request.prepared.pixels)},
    pixelProof:{hash:await pixelHash(request.prepared.pixels),sample:Array.from(request.prepared.pixels.subarray(0,32))},
    timing:{workerMs:1,detectMs:0,cropMs:0,rasterReadbackMs:0,rasterHashMs:0}});
  try{await run({client,workers,requests,canvases,Canvas,response,set,bitmapCopies:()=>bitmapCopies});}
  finally{clients.forEach(value=>value.dispose());for(const [name,descriptor]of Object.entries(prior))
    if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}
}

test('owned prepared input paints a full target, transfers exact pixels and binds measured response fields',async()=>{
  await fixture(async(h:any)=>{
    const {client}=h.client({pixelTransport:true,pixelProof:true}),source=input(),original=source.pixels.slice(),target=new h.Canvas();target.width=10;target.height=10;
    const pending=client.detectPrepared(source,target);assert.equal(source.pixels.byteLength,0,'caller ownership ends before the first await');
    const blocked=input(8);await assert.rejects(client.detectPrepared(blocked),/동시 수집/);assert.equal(blocked.pixels.byteLength,8);
    assert.throws(()=>client.reserveFrameId(),/동시 수집/);assert.throws(()=>client.startRecording({}as MessagePort),/준비된 원본/);
    await until(()=>h.requests.length===1);const request=h.requests[0];
    assert.equal(request.kind,'prepared');assert.equal(request.bitmap,undefined);assert.equal(request.pixelTransport,true);
    assert.deepEqual(request.prepared.pixels,original);assert.equal(h.bitmapCopies(),0);
    assert.deepEqual([target.width,target.height,target.puts,target.clears],[2,1,1,0]);assert.deepEqual(target.pixels,new Uint8ClampedArray(original));
    h.workers[0].onmessage({data:await h.response(request)});const result=await pending;
    assert.equal(result.frameId,1);assert.equal(result.rasterReceipt.sourceFrameId,7);assert.equal(result.rasterReceipt.captureTime,3.25);
    assert.equal(result.rasterReceipt.hash,await pixelHash(original));assert.ok(Object.isFrozen(result.rasterReceipt));
    assert.equal(result.pixelProof.hash,result.rasterReceipt.hash);assert.equal(result.timing.inputBytes,8);
    assert.ok(result.timing.preparedHashMs>=0);assert.ok(result.timing.targetPaintMs>=0);
    assert.equal(target.puts,1);assert.equal(target.clears,0,'prepared results never replace the full target with metadata patches');
  });
});

test('explicit measured raster control reaches the worker without changing the actual raster receipt requirement',async()=>{
 await fixture(async(h:any)=>{
  const options={pixelTransport:true,measuredRasterReuse:false},one=h.client(options);options.measuredRasterReuse=true;
  const pending=one.client.detectPrepared(input());await until(()=>h.requests.length===1);
  const request=h.requests[0];assert.equal(request.measuredRasterReuse,false,'constructor captures the control setting');
  h.workers[0].onmessage({data:{...await h.response(request),timing:{workerMs:1,detectMs:0,cropMs:0,
   gridReadbacksSaved:0,cropReadbacksSaved:0}}});
  const value=await pending;assert.equal(value.rasterReceipt.hash,await pixelHash(request.prepared.pixels));
  assert.equal(value.timing.gridReadbacksSaved,0);assert.equal(value.timing.cropReadbacksSaved,0);
  const two=h.client(),next=two.client.detectPrepared(input(8));await until(()=>h.requests.length===2);
  assert.equal(Object.hasOwn(h.requests[1],'measuredRasterReuse'),false,'default remains an omitted option');
  h.workers[1].onmessage({data:{...await h.response(h.requests[1]),timing:{workerMs:1,detectMs:0,cropMs:0,
   gridReadbacksSaved:2,cropReadbacksSaved:41}}});
  const result=await next;assert.equal(result.timing.gridReadbacksSaved,undefined);assert.equal(result.timing.cropReadbacksSaved,undefined,
   'invalid optional diagnostics do not replace or reject valid actual pixel proof');
 });
});

test('malformed reuse configuration is rejected before a Worker or input lease is created',async()=>{
 await fixture(async(h:any)=>{assert.throws(()=>h.client({measuredRasterReuse:'off'}),/Invalid measured raster/);assert.equal(h.workers.length,0);});
});

test('fake or malformed receipts cannot resolve prepared acquisitions and rejected images are released',async()=>{
  await fixture(async(h:any)=>{
    const {client}=h.client(),worker=h.workers[0];let closes=0;
    const mutations=[(v:any)=>({...v,sourceFrameId:99}),(v:any)=>({...v,captureTime:8}),(v:any)=>({...v,acquisitionFrameId:v.acquisitionFrameId+1}),
      (v:any)=>({...v,width:1}),(v:any)=>({...v,height:2}),(v:any)=>({...v,hash:'0'.repeat(64)}),
      (v:any)=>({...v,kind:'analysis-reused'}),(v:any)=>({...v,extra:1}),()=>undefined];
    for(const mutate of mutations){const before=h.requests.length,pending=client.detectPrepared(input());
      const rejected=assert.rejects(pending);await until(()=>h.requests.length>before);
      const data=await h.response(h.requests.at(-1));data.rasterReceipt=mutate(data.rasterReceipt);
      data.cells=[{bitmap:{width:1,height:1,close(){closes++;}}}];worker.onmessage({data});await rejected;}
    assert.equal(closes,mutations.length);
    const before=h.requests.length,pending=client.detectPrepared(input()),rejected=assert.rejects(pending,/데이터|증명|sample|SHA/);
    await until(()=>h.requests.length>before);const data=await h.response(h.requests.at(-1));data.pixelProof.hash='invalid';worker.onmessage({data});await rejected;
  });
});

test('prepared requests reject legacy recording ambiguity before taking ownership and expose legacy opt-in pixel proofs',async()=>{
  await fixture(async(h:any)=>{
    const {client}=h.client({pixelProof:true});client.startRecording({}as MessagePort);
    const source=input();await assert.rejects(client.detectPrepared(source),/이전 기록 포트/);assert.equal(source.pixels.byteLength,8);
    assert.equal(h.requests.filter((value:any)=>value.kind==='prepared').length,0);
    const stopped=client.stopRecording();h.workers[0].onmessage({data:{recordingEnded:true}});await stopped;
    const pending=client.detectAndAcquire({}as HTMLCanvasElement);await tick();
    const request=h.requests.at(-1);assert.equal(request.pixelProof,true);
    h.workers[0].onmessage({data:{id:request.id,cells:[],pixelProof:{hash:'a'.repeat(64),sample:[1,2,3]}}});
    const result=await pending;assert.equal(result.pixelProof.hash,'a'.repeat(64));assert.deepEqual(result.pixelProof.sample,[1,2,3]);
  });
});

test('abort and timeout release pending requests, discard late images and never paint late patches',async()=>{
  await fixture(async(h:any)=>{
    const {client,control}=h.client(),target=new h.Canvas(),pending=client.detectPrepared(input(),target);
    await until(()=>h.requests.length===1);const request=h.requests[0],rejected=assert.rejects(pending,{name:'AbortError'});
    control.abort();await rejected;assert.equal(h.workers[0].terminated,true);let closed=0;
    const data=await h.response(request);data.patches=[{box:{x:0,y:0},bitmap:{close(){closed++;}}}];h.workers[0].onmessage({data});
    assert.equal(closed,1);assert.equal(target.puts,1);assert.equal(target.clears,0);assert.equal(target.draws,0);
  });
  await fixture(async(h:any)=>{
    const timers:(()=>void)[]=[];h.set('setTimeout',(callback:()=>void,ms:number)=>{assert.equal(ms,20_000);timers.push(callback);return 0;});
    const {client}=h.client(),pending=client.detectPrepared(input()),rejected=assert.rejects(pending,/시간 초과/);
    await until(()=>h.requests.length===1);timers[0]();await rejected;assert.equal(h.workers[0].terminated,true);
    const next=input();await assert.rejects(client.detectPrepared(next),/수집 종료/);assert.equal(next.pixels.byteLength,8);
  });
});

test('manual dispose cancels a stalled input hash before posting and late hash completion cannot revive acquisition',async()=>{
  await fixture(async(h:any)=>{
    let release!:(value:ArrayBuffer)=>void;
    h.set('crypto',{subtle:{digest:()=>new Promise(resolve=>{release=resolve;})}});
    const {client}=h.client(),source=input(),pending=client.detectPrepared(source),rejected=assert.rejects(pending,{name:'AbortError'});
    assert.equal(source.pixels.byteLength,0);client.dispose();await rejected;
    release(new Uint8Array(32).buffer);await tick();assert.equal(h.requests.length,0);
  });
});

test('no-Worker fallback measures the same full prepared canvas and abort disposes a late detector',async()=>{
  await fixture(async(h:any)=>{
    let disposed=0,detected=0;const {client}=h.client({pixelProof:true},{detectorFactory:async()=>({
      detect(frame:any){detected++;assert.deepEqual(frame.pixels,new Uint8ClampedArray(input().pixels));return null;},dispose(){disposed++;}})});
    const source=input(),expected=source.pixels.slice(),result=await client.detectPrepared(source);
    assert.equal(source.pixels.byteLength,0);assert.equal(result.rasterReceipt.hash,await pixelHash(expected));assert.equal(result.rasterReceipt.acquisitionFrameId,1);
    assert.equal(result.pixelProof.hash,result.rasterReceipt.hash);assert.equal(result.timing.inputBytes,8);
    assert.ok(result.timing.rasterReadbackMs>=0);assert.ok(result.timing.rasterHashMs>=0);assert.equal(detected,1);assert.equal(h.bitmapCopies(),0);
    assert.equal(h.canvases.at(-1).width,0,'only the internal fallback full raster is released after crop materialization');client.dispose();assert.equal(disposed,1);
  },false);
  await fixture(async(h:any)=>{
    let finish!:(value:unknown)=>void,disposed=0;
    const {client,control}=h.client({}, {detectorFactory:()=>new Promise(resolve=>{finish=resolve;})}),pending=client.detectPrepared(input());
    await until(()=>!!finish);const rejected=assert.rejects(pending,{name:'AbortError'});control.abort();await rejected;
    finish({detect:()=>null,dispose(){disposed++;}});await tick();assert.equal(disposed,1);
  },false);
});
