import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanonicalCapture} from '../src/features/card-scanner/reproduction/canonical-capture';
import {preparedRecoveryPrefetch} from '../src/features/card-scanner/acquisition/prepared-recovery-prefetch';
import {createAcquisitionClient} from '../src/features/card-scanner/acquisition/acquisition-client';
import {pixelHash} from '../src/features/card-scanner/reproduction/recording-frame-integrity';

// The real capture controller, prefetch adapter and acquisition fallback are
// joined here. Storage and Canvas are byte-backed test doubles; no real IDB,
// GPU, screen capture, OCR or card identity is asserted by this integration.
type Stored={id:number;width:number;height:number;time:number;hash:string;pixels:Uint8ClampedArray<ArrayBuffer>};
class Canvas {
  private w=0;private h=0;pixels=new Uint8ClampedArray<ArrayBuffer>();
  set width(value:number){this.w=value;this.pixels=new Uint8ClampedArray(this.w*this.h*4);}get width(){return this.w;}
  set height(value:number){this.h=value;this.pixels=new Uint8ClampedArray(this.w*this.h*4);}get height(){return this.h;}
  getContext(){return {putImageData:(value:ImageData)=>{this.pixels=new Uint8ClampedArray(value.data);},
    getImageData:()=>({data:this.pixels.slice(),width:this.w,height:this.h}),clearRect:()=>this.pixels.fill(0),drawImage:()=>{}};}
}

async function withPlatform(run:()=>Promise<void>){
  const names=['OffscreenCanvas','createImageBitmap','document','ImageData'] as const;
  const previous=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const set=(name:string,value:unknown)=>Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  set('OffscreenCanvas',undefined);set('createImageBitmap',undefined);
  set('document',{createElement:()=>new Canvas()});
  set('ImageData',class {constructor(readonly data:Uint8ClampedArray,readonly width:number,readonly height:number){}});
  try{await run();}finally{for(const [name,descriptor]of Object.entries(previous))
    if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}
}

function fixture(options:{corrupt?:boolean;delayRead?:boolean;mutateAfterIssue?:boolean;metadata?:'id'|'time'|'width'|'height'|'hash'}={}){
  const parent=new AbortController(),stored=new Map<number,Stored>(),detected:number[]=[],consumed:number[]=[],originals:{pixels:Uint8Array<ArrayBuffer>;token:object;identity:{sourceFrameId:number;time:number;width:number;height:number;hash:string}}[]=[];
  let startRead:(()=>void)|undefined,releaseRead:(()=>void)|undefined;
  const started=new Promise<void>(resolve=>{startRead=resolve;});
  const readGate=new Promise<void>(resolve=>{releaseRead=resolve;});
  const port={onmessage:null as ((event:MessageEvent)=>void)|null,start(){},close(){},postMessage(input:unknown,transfer:Transferable[]=[]){
    const value=structuredClone(input,{transfer}) as {kind:string;id:number;width:number;height:number;time:number;pixels:ArrayBuffer};
    if(value.kind==='drain'){queueMicrotask(()=>port.onmessage?.({data:{kind:'drained'}} as MessageEvent));return;}
    if(value.kind!=='frame')return;
    void (async()=>{
      const pixels=new Uint8ClampedArray(value.pixels),hash=await pixelHash(new Uint8Array(pixels));
      const frame={id:value.id,width:value.width,height:value.height,time:value.time,hash,pixels};stored.set(value.id,frame);
      port.onmessage?.({data:{kind:'stored',id:value.id,width:value.width,height:value.height,time:value.time,hash}} as MessageEvent);
    })();
  }};
  const capture=createCanonicalCapture({takePort:()=>port as unknown as MessagePort,incomplete:()=>{},async readFrame(id,signal){
    startRead?.();if(options.delayRead)await readGate;signal.throwIfAborted();
    const entry=stored.get(id);if(!entry)throw Error('missing stored frame');
    const pixels=entry.pixels.slice();if(options.corrupt)pixels[0]^=1;
    return {...entry,pixels,...(options.metadata==='id'?{id:id+1}:{}),...(options.metadata==='time'?{time:entry.time+1}:{}),
      ...(options.metadata==='width'?{width:entry.width+1}:{}),...(options.metadata==='height'?{height:entry.height+1}:{}),
      ...(options.metadata==='hash'?{hash:'f'.repeat(64)}:{})};
  }},()=>{}, {ownedRgba:true,experimentalRestoredPixels:{maxFrames:4,lifetimeMs:10_000,maxWorkingBytes:128},
    canvasFactory:()=>new Canvas() as unknown as HTMLCanvasElement,byteLimit:128});
  const sources={submit:()=>undefined,retain:()=>{},take:async()=>{throw Error('unexpected prepared source');},release:()=>{},flush:async()=>{}};
  const upstream={async *[Symbol.asyncIterator](){for await(const frame of capture.frames(parent.signal)){
    const identity={sourceFrameId:frame.canonicalFrameId,time:frame.time,width:frame.element.width,height:frame.element.height,hash:frame.sourceHash!};
    originals.push({pixels:frame.rgba!,token:frame.restoredPixelCapability!,identity});
    if(options.mutateAfterIssue)frame.rgba![0]^=1;
    yield frame;
  }}};
  const recovery=preparedRecoveryPrefetch(upstream,sources,parent.signal,{elapsed:()=>1,
    canvasFactory:()=>new Canvas() as unknown as HTMLCanvasElement,
    consumeRestoredPixelCapability:async(token,identity,signal)=>{
      const result=await capture.consumeRestoredPixelCapability(token,identity,signal);if(result)consumed.push(identity.sourceFrameId);return result;
    }});
  const client=createAcquisitionClient(parent.signal,{pixelProof:true},{detectorFactory:async()=>({detect(frame){
    detected.push((frame as unknown as Canvas).pixels[0]);return null;},dispose(){}})});
  async function add(idValue:number,time:number){
    const pixels=Uint8Array.from([idValue,idValue+1,idValue+2,255,idValue+3,idValue+4,idValue+5,255]);
    const hash=await pixelHash(pixels),record=capture.reserve({width:2,height:1,time,elapsed:time})!;
    capture.submitPrepared(record.id,{pixels:pixels.buffer,hash});assert.equal(pixels.byteLength,0,'writer transfer takes ownership');
    assert.equal((await capture.stored(record.id)).hash,hash);return {record,hash};
  }
  return {parent,capture,recovery,client,originals,consumed,detected,add,started,releaseRead:()=>releaseRead?.()};
}

test('canonical stored pixels cross the one-use prefetch and measured acquisition path in input time order',async()=>{
 await withPlatform(async()=>{
  const h=fixture(),first=await h.add(10,2),second=await h.add(20,1),seen:number[]=[];
  try{
   for await(const frame of h.recovery){
    const source=h.originals.find(value=>value.identity.sourceFrameId===frame.canonicalFrameId)!;
    assert.equal(source.pixels.byteLength,0,'prefetch consumes and detaches the exact restored source');
    assert.equal(await h.capture.verifyRestoredPixelCapability(source.token,source.identity,h.parent.signal),false,'consumed token cannot be reused');
    assert.equal(Object.hasOwn(frame,'restoredPixelCapability'),false,'opaque owner token is not forwarded');
    const expected=frame.rgba!.slice(),pending=h.client.detectPrepared({pixels:frame.rgba!,width:frame.width,height:frame.height,
      binding:{sourceFrameId:frame.preparedSourceId,captureTime:frame.time}});
    assert.equal(frame.rgba!.byteLength,0,'acquisition takes prefetch buffer before awaiting');
    const result=await pending;
    assert.deepEqual(result.rasterReceipt,{version:1,kind:'measured',sourceFrameId:frame.canonicalFrameId,
      captureTime:frame.time,acquisitionFrameId:result.frameId,width:2,height:1,hash:await pixelHash(expected)});
    assert.throws(()=>h.capture.use(frame.canonicalFrameId,result.frameId,'recovery',frame.time+1,result.rasterReceipt),/원본 사용 근거/,
      'a different capture time cannot join the measured raster');
    h.capture.use(frame.canonicalFrameId,result.frameId,'recovery',frame.time,result.rasterReceipt);
    seen.push(frame.canonicalFrameId);
   }
   assert.deepEqual(seen,[second.record.id,first.record.id]);assert.deepEqual(h.consumed,seen);
   assert.deepEqual(h.detected,[20,10]);assert.equal(h.capture.stats.measuredRasterUses,2);
   assert.equal(h.capture.stats.unverifiedRasterUses,0);assert.equal(h.recovery.stats.retainedBytes,0);
  }finally{h.client.dispose();await h.capture.discard();}
 });
});

test('a changed restored pixel is rejected before prefetch yields or acquisition runs',async()=>{
 await withPlatform(async()=>{
  const h=fixture({corrupt:true});await h.add(10,1);
  try{await assert.rejects(h.recovery.next(),/SHA mismatch/);assert.deepEqual(h.detected,[]);assert.deepEqual(h.consumed,[]);}
  finally{h.client.dispose();await h.capture.discard();}
 });
});

test('a modified issued raster cannot be handed through prefetch even with the original metadata',async()=>{
 await withPlatform(async()=>{
  const h=fixture({mutateAfterIssue:true});await h.add(10,1);
  try{await assert.rejects(h.recovery.next(),/restored pixel transfer/i);assert.deepEqual(h.detected,[]);assert.deepEqual(h.consumed,[]);}
  finally{h.client.dispose();await h.capture.discard();}
 });
});

for(const metadata of ['id','time','width','height','hash'] as const)test(`stored ${metadata} mismatch cannot reach acquisition`,async()=>{
 await withPlatform(async()=>{
  const h=fixture({metadata});await h.add(10,1);
  try{await assert.rejects(h.recovery.next(),/공통|RGBA/);assert.deepEqual(h.detected,[]);assert.deepEqual(h.consumed,[]);}
  finally{h.client.dispose();await h.capture.discard();}
 });
});

test('cancellation during restored storage read yields no acquired frame or measured receipt',async()=>{
 await withPlatform(async()=>{
  const h=fixture({delayRead:true});await h.add(10,1);
  try{
   const pending=h.recovery.next(),rejected=assert.rejects(pending,{name:'AbortError'});
   await h.started;h.parent.abort();h.releaseRead();await rejected;
   assert.deepEqual(h.detected,[]);assert.deepEqual(h.consumed,[]);assert.equal(h.capture.stats.measuredRasterUses,0);
  }finally{h.releaseRead();h.client.dispose();await h.capture.discard();}
 });
});
