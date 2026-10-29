import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanonicalCapture} from '../src/features/card-scanner/canonical-capture';
import {createPreparedLiveSource} from '../src/features/card-scanner/prepared-live-source';
import {preparedRecoveryPrefetch} from '../src/features/card-scanner/prepared-recovery-prefetch';
import {pixelHash} from '../src/features/card-scanner/recording-frame-integrity';
import type {PreparedSource,SourceBinding} from '../src/features/card-scanner/source-preparation';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(predicate:()=>boolean){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw Error('Combined recovery fixture timeout');await tick();}}
class Native {
 readonly displayWidth=1;readonly displayHeight=1;closed=0;clones:Native[]=[];
 constructor(readonly value:number){}
 clone(){const result=new Native(this.value);this.clones.push(result);return result;}
 close(){this.closed++;}
}
class Canvas {
 width=0;height=0;
 getContext(){throw Error('Native prefetch must not rasterize its size-only placeholder');}
}
type WireFrame={kind:'frame';id:number;width:number;height:number;time:number;role:string;canonical:true;pixels:ArrayBuffer};

/** Real canonical controller + real source ownership controller + real prefetch.
 * Only browser handles/preparation and the writer port are replaced. ACKs hash
 * the actual transferred raw bytes; no acquisition/model/IDB claim is made. */
function fixture(count:number){
 const parent=new AbortController(),frames:WireFrame[]=[],messages:{kind:string}[]=[],reported:string[]=[],incomplete:string[]=[],uses:unknown[]=[],
  originals:Native[]=[],owned:Native[]=[],canvases:Canvas[]=[];
 let returned=0,prepareCalls=0,portClosed=0;
 const port={onmessage:null as ((event:MessageEvent)=>void)|null,start(){},close(){portClosed++;},
  postMessage(value:unknown,transfers:Transferable[]=[]){
   const received=structuredClone(value,{transfer:transfers}) as WireFrame;messages.push(received);
   if(received.kind==='frame')frames.push(received);
   if((received as {kind:string}).kind==='drain')queueMicrotask(()=>port.onmessage?.({data:{kind:'drained'}} as MessageEvent));
  }};
 const capture=createCanonicalCapture({takePort:()=>port as unknown as MessagePort,incomplete:value=>incomplete.push(value),
  readFrame:async()=>{throw Error('This ownership test does not read pixel archives');}},value=>reported.push(value),{
  byteLimit:8,onUse:value=>uses.push(value),bitmapFactory:async()=>{throw Error('No bitmap recording fallback in this test');},
 });
 const preparer={async prepare(input:VideoFrame|ImageBitmap,binding:SourceBinding):Promise<PreparedSource>{
  const source=input as unknown as Native;owned.push(source);prepareCalls++;
  try{
   const pixels=new Uint8Array([source.value,source.value,source.value,255]),storage=pixels.slice(),hash=await pixelHash(pixels);
   return {binding,width:1,height:1,pixels,storage:{kind:'rgba',pixels:storage.buffer},hash,mode:'rgba',fallbackReason:'unit-owned-input',
    reservationBytes:8,outputBytes:8,timing:{copyMs:0,conversionHashMs:0,rasterMs:0,totalMs:0}};
  }finally{source.close();}
 }};
 const sources=createPreparedLiveSource(capture,preparer,parent.signal);
 const upstream={async *[Symbol.asyncIterator](){
  try{for(let index=0;index<count;index++){
   const input=new Native(index+1);originals.push(input);
   try{yield {element:{width:1,height:1} as HTMLCanvasElement,nativeFrame:input as unknown as VideoFrame,time:index*.04,percent:(index+1)/count*100};}
   finally{input.close();}
  }}finally{returned++;}
 }};
 const recovery=preparedRecoveryPrefetch(upstream,sources,parent.signal,{elapsed:()=>1000,canvasFactory:()=>{
  const canvas=new Canvas();canvases.push(canvas);return canvas as unknown as HTMLCanvasElement;
 }});
 const ack=async(index:number)=>{
  const frame=frames[index],hash=await pixelHash(new Uint8Array(frame.pixels));
  port.onmessage?.({data:{kind:'stored',id:frame.id,width:frame.width,height:frame.height,time:frame.time,hash}} as MessageEvent);
  return hash;
 };
 return {parent,capture,sources,recovery,frames,messages,reported,incomplete,uses,originals,owned,canvases,ack,
  sourceError(error:string){port.onmessage?.({data:{kind:'source-error',error}} as MessageEvent);},
  get returned(){return returned;},get prepareCalls(){return prepareCalls;},get portClosed(){return portClosed;},
  async finish(){await sources.finish();sources.dispose();await capture.finish();},
 };
}

test('normal prefetch return cancels the real credit waiter without canceling its pending physical prefix',async()=>{
 const h=fixture(3),first=(await h.recovery.next()).value!;
 await until(()=>h.capture.stats.waitingForCapacity);
 assert.equal(h.capture.captured,1);assert.equal(h.prepareCalls,1);assert.equal(h.originals.length,2);
 assert.equal(h.originals[1].clones.length,0,'next borrowed native is not cloned before actual writer credits');
 assert.equal(h.capture.stats.pendingBytes,8);assert.equal(h.sources.stats.failed,false);
 await h.recovery.return();
 assert.equal(h.parent.signal.aborted,false);assert.equal(h.returned,1);assert.equal(first.element.width,0);
 assert.equal(h.capture.stats.waitingForCapacity,false);assert.equal(h.capture.stats.error,'');assert.equal(h.capture.stats.pending,1);
 assert.equal(h.capture.captured,1,'the canceled wait reserved no orphan physical ID');assert.equal(h.prepareCalls,1);
 assert.equal(h.sources.stats.failed,false);assert.equal(h.sources.stats.persistenceFailed,false);assert.equal(h.sources.stats.pendingBytes,0);
 assert.deepEqual(h.messages.filter(value=>value.kind==='gap'),[]);assert.deepEqual(h.reported,[]);assert.deepEqual(h.incomplete,[]);
 assert.equal(h.originals[0].closed,1);assert.equal(h.originals[1].closed,1);assert.equal(h.owned[0].closed,1);
 const hash=await h.ack(0),stored=await h.capture.stored(1);
 assert.equal(stored.hash,hash);assert.equal(stored.time,0);assert.equal(h.capture.stats.storedFrames,1);
 assert.deepEqual(Array.from(new Uint8Array(h.frames[0].pixels)),[1,1,1,255]);assert.deepEqual(h.uses,[]);
 await h.finish();assert.equal(h.portClosed,1);assert.equal(h.capture.stats.pendingBytes,0);assert.equal(h.capture.stats.error,'');
});

test('real stored ACKs unblock second and third preparations without dropping inputs or widening either cap',async()=>{
 const h=fixture(3),first=(await h.recovery.next()).value!;await until(()=>h.capture.stats.waitingForCapacity);
 assert.equal(h.frames.length,1);assert.equal(h.capture.captured,1);assert.equal(h.prepareCalls,1);
 await h.ack(0);await until(()=>h.prepareCalls===2&&h.frames.length===2);
 assert.equal(first.element.width,1,'N remains owned while N+1 prepares');assert.equal(h.recovery.stats.prepared,2);
 const second=(await h.recovery.next()).value!;await until(()=>h.capture.stats.waitingForCapacity);
 assert.equal(first.element.width,0);assert.equal(h.capture.captured,2);assert.equal(h.prepareCalls,2);
 assert.equal(h.originals[2].clones.length,0);await h.ack(1);await until(()=>h.prepareCalls===3&&h.frames.length===3);
 const third=(await h.recovery.next()).value!;
 assert.deepEqual([first.preparedSourceId,second.preparedSourceId,third.preparedSourceId],[1,2,3]);
 assert.deepEqual([first.time,second.time,third.time],[0,.04,.08]);
 assert.deepEqual([first.preparedInput!.pixels[0],second.preparedInput!.pixels[0],third.preparedInput!.pixels[0]],[1,2,3]);
 await h.ack(2);assert.equal((await h.recovery.next()).done,true);
 assert.equal(h.capture.stats.storedFrames,3);assert.equal(h.capture.stats.pending,0);assert.equal(h.capture.stats.pendingBytes,0);
 assert.equal(h.capture.stats.peakPendingBytes,8);assert.equal(h.capture.stats.capacityWaits,2);assert.equal(h.capture.stats.error,'');
 assert.ok(h.sources.stats.peakJobs<=4);assert.ok(h.sources.stats.peakPendingBytes<=128*1024*1024);
 assert.equal(h.recovery.stats.peakRetainedFrames,2);assert.equal(h.recovery.stats.retainedBytes,0);
 assert.equal(h.sources.stats.persistenceFailed,false);assert.equal(h.sources.stats.failed,false);assert.equal(h.returned,1);
 assert.deepEqual(h.frames.map(frame=>frame.id),[1,2,3]);assert.ok(h.frames.every(frame=>frame.canonical&&frame.role==='recovery'));
 assert.ok(h.originals.every(frame=>frame.closed===1));assert.ok(h.owned.every(frame=>frame.closed===1));assert.ok(h.canvases.every(canvas=>canvas.width===0&&canvas.height===0));
 assert.deepEqual(h.reported,[]);assert.deepEqual(h.incomplete,[]);await h.finish();assert.equal(h.portClosed,1);
});

test('a real writer failure during its credit wait becomes explicit unrecorded preparation while preserving the accepted prefix',async()=>{
 const h=fixture(2),first=(await h.recovery.next()).value!;await until(()=>h.capture.stats.waitingForCapacity);
 h.sourceError('unit disk quota');await until(()=>h.prepareCalls===2);
 const second=(await h.recovery.next()).value!;
 assert.equal(first.preparedSourceId,1);assert.equal(second.preparedSourceId,2);assert.equal(second.preparedInput!.binding.captureTime,.04);
 assert.equal(second.preparedInput!.pixels[0],2);assert.equal(h.sources.isPersistent(first.preparedSourceId),true);assert.equal(h.sources.isPersistent(second.preparedSourceId),false);
 assert.equal(h.capture.captured,1);assert.equal(h.frames.length,1);assert.equal(h.sources.stats.ephemeralSources,1);assert.equal(h.sources.stats.unpersistedPrepared,1);
 assert.equal(h.sources.stats.failed,false);assert.equal(h.sources.stats.persistenceFailed,true);assert.equal(h.capture.stats.waitingForCapacity,false);
 await h.ack(0);assert.equal((await h.capture.stored(1)).time,0,'late valid ACK still identifies the accepted physical prefix');
 assert.equal((await h.recovery.next()).done,true);assert.deepEqual(h.uses,[],'the preparation adapter invents no acquisition/file-use events');
 assert.equal(h.capture.stats.storedFrames,1);assert.match(h.capture.stats.error,/unit disk quota/);assert.equal(h.reported.length,1);
 assert.ok(h.originals.every(frame=>frame.closed===1));assert.ok(h.owned.every(frame=>frame.closed===1));assert.equal(h.recovery.stats.retainedBytes,0);
 await h.finish();assert.equal(h.portClosed,1);
});
