import test from 'node:test';
import assert from 'node:assert/strict';
import {preparedRecoveryPrefetch,type RecoveryPreparationInput} from '../src/features/card-scanner/prepared-recovery-prefetch';
import type {PreparedAcquisitionInput} from '../src/features/card-scanner/source-raster-receipt';
import {withMediaLineage,type MediaDecodedFrame,type MediaLineageFact} from '../src/features/card-scanner/media-lineage';
import {mergeFrames} from '../src/features/card-scanner/merge-frames';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function until(predicate:()=>boolean){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw Error('Recovery prefetch fixture timeout');await tick();}}
class Canvas {
 width=0;height=0;tag=0;draws=0;
 getContext(){return {globalCompositeOperation:'source-over',drawImage:(source:{tag:number})=>{this.draws++;this.tag=source.tag;}};}
}
class Native {
 closed=0;clones:Native[]=[];
 constructor(readonly displayWidth:number,readonly displayHeight:number,readonly tag:number){}
 clone(){const clone=new Native(this.displayWidth,this.displayHeight,this.tag);this.clones.push(clone);return clone;}
 close(){this.closed++;}
}
function provider(options:{count?:number;native?:boolean;times?:number[];sizes?:number[];canonical?:boolean}={}){
 const count=options.count??3,borrowed=new Canvas(),natives:Native[]=[],originalRgba:Uint8Array<ArrayBuffer>[]=[],analyses:{tag:number}[]=[],
  counts={next:0,returned:0};
 let index=0,active:Native|undefined;
 const iterator:AsyncIterator<RecoveryPreparationInput&{analysis?:{tag:number};decoded?:{ordinal:number}}>= {
  async next(){
   counts.next++;active?.close();active=undefined;
   if(index>=count)return {done:true,value:undefined};
   const ordinal=index++,width=options.sizes?.[ordinal]??2;
   borrowed.width=width;borrowed.height=2;borrowed.tag=ordinal+1;
   const value:RecoveryPreparationInput&{analysis?:{tag:number};decoded?:{ordinal:number}}={element:borrowed as unknown as HTMLCanvasElement,
    time:options.times?.[ordinal]??ordinal*.04,percent:(ordinal+1)/count*100,decoded:{ordinal}};
   if(options.native){active=new Native(width,2,ordinal+1);natives.push(active);Object.assign(value,{nativeFrame:active as unknown as VideoFrame});}
   if(options.canonical){const rgba=new Uint8Array(width*2*4).fill(ordinal+1),analysis={tag:ordinal};originalRgba.push(rgba);analyses.push(analysis);
    Object.assign(value,{canonicalFrameId:ordinal+7,rgba,sourceHash:'a'.repeat(64),analysis});}
   return {done:false,value};
  },
  async return(){counts.returned++;active?.close();active=undefined;borrowed.width=borrowed.height=0;return {done:true,value:undefined};},
 };
 return {frames:{[Symbol.asyncIterator]:()=>iterator},counts,borrowed,natives,originalRgba,analyses};
}
function sourceScope(options:{automatic?:boolean;ephemeral?:boolean;readySecond?:boolean;releaseFailure?:boolean}={}){
 type Job={id:number;width:number;height:number;time:number;tag:number;owned?:Native;ready:ReturnType<typeof deferred<PreparedAcquisitionInput>>};
 const jobs:Job[]=[],retained:number[]=[],released:number[]=[],events:string[]=[],ready=deferred<void>();
 let id=options.ephemeral?316:0,readyCalls=0;
 const sources={
  submit(input:unknown,time:number,_elapsed:number,role:string){
   assert.equal(role,'recovery');const source=input as Native|Canvas;
   const owned=source instanceof Native?source.clone():undefined,width=owned?.displayWidth??(source as Canvas).width,height=owned?.displayHeight??(source as Canvas).height;
   const job:Job={id:++id,width,height,time,tag:source.tag,owned,ready:deferred<PreparedAcquisitionInput>()};jobs.push(job);events.push(`submit:${job.id}`);
   if(options.automatic)queueMicrotask(()=>complete(job));return job.id;
  },
  retain(value:number|undefined){assert.ok(value);retained.push(value!);},
  async take(value:number){events.push(`take:${value}`);const job=jobs.find(job=>job.id===value);assert.ok(job);return await job.ready.promise;},
  release(value:number|undefined){released.push(value!);if(options.releaseFailure)throw Error('release report failed');},
  async flush(){await Promise.all(jobs.map(job=>job.ready.promise));},
  isPersistent:()=>!options.ephemeral,
  async readyForRecovery(_width:number,_height:number,signal:AbortSignal){
   readyCalls++;events.push(`credit:${readyCalls}`);
   if(options.readySecond&&readyCalls===2)await Promise.race([ready.promise,new Promise<never>((_,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
   })]);
  },
 };
 function complete(job:Job){job.owned?.close();events.push(`prepared:${job.id}`);job.ready.resolve({pixels:new Uint8Array(job.width*job.height*4).fill(job.tag),
  width:job.width,height:job.height,binding:{sourceFrameId:job.id,captureTime:job.time}});}
 return {sources,jobs,retained,released,events,ready,complete:(index:number)=>complete(jobs[index]),
  reject:(index:number,error:unknown)=>{jobs[index].owned?.close();jobs[index].ready.reject(error);},get readyCalls(){return readyCalls;}};
}
function canvases(){const values:Canvas[]=[];return {values,factory:()=>{const canvas=new Canvas();values.push(canvas);return canvas as unknown as HTMLCanvasElement;}};}

test('decoder lineage stays with its native input across merged canonical snapshots and prefetch',async()=>{
 const signal=new AbortController().signal,decoded=provider({count:2,native:true,times:[0,.08]}),saved=provider({count:1,canonical:true,times:[.04]});
 const facts:MediaLineageFact[]=[],lineaged=withMediaLineage(decoded.frames,new Blob(['recorded-video']),signal,{role:'re-recorded-video',onFact:fact=>facts.push(fact)});
 const mixed:AsyncIterable<RecoveryPreparationInput&{lineage?:MediaDecodedFrame}>=mergeFrames(lineaged,saved.frames,signal);
 const s=sourceScope({automatic:true}),c=canvases(),frames=preparedRecoveryPrefetch(mixed,s.sources,signal,{elapsed:()=>100,canvasFactory:c.factory});
 const used:{time:number;ordinal:number|null;sourceId:string|null;canonical:boolean;tag:number}[]=[];
 for await(const frame of frames)used.push({time:frame.time,ordinal:frame.lineage?.ordinal??null,sourceId:frame.lineage?.sourceId??null,
  canonical:frame.canonicalFrameId!==undefined,tag:frame.preparedInput?.pixels[0]??frame.rgba![0]});
 assert.deepEqual(used.map(({time,ordinal,canonical,tag})=>({time,ordinal,canonical,tag})),[
  {time:0,ordinal:1,canonical:false,tag:1},{time:.04,ordinal:null,canonical:true,tag:1},{time:.08,ordinal:2,canonical:false,tag:2},
 ]);
 assert.equal(used[0].sourceId,used[2].sourceId);assert.equal(used[1].sourceId,null,'saved pixels never inherit the preceding decoder lineage');
 assert.equal(decoded.natives.length,2);
 for(const native of decoded.natives){assert.equal(native.closed,1);assert.equal(native.clones.length,1);assert.equal(native.clones[0].closed,1);}
 assert.equal(frames.stats.prepared,2);assert.equal(frames.stats.canonical,1);assert.equal(frames.stats.retainedBytes,0);
 assert.deepEqual(facts.map(fact=>fact.kind),['start','frame','frame','end']);
 const terminal=facts.at(-1)!;assert.equal(terminal.kind,'end');if(terminal.kind==='end'){assert.equal(terminal.frames,2);assert.equal(terminal.reason,'eof');}
});

test('N+1 preparation overlaps serial consumption of N without advancing or acquiring N+2',async()=>{
 const p=provider({native:true}),s=sourceScope(),c=canvases(),frames=preparedRecoveryPrefetch(p.frames,s.sources,new AbortController().signal,{elapsed:()=>100,canvasFactory:c.factory});
 const firstPromise=frames.next();await until(()=>s.jobs.length===1);assert.equal(p.counts.next,1);s.complete(0);
 const first=(await firstPromise).value!;await until(()=>s.jobs.length===2);
 assert.equal(first.preparedSourceId,1);assert.equal(first.preparedInput?.pixels[0],1);assert.equal(p.counts.next,2);
 assert.equal(p.natives[0].closed,1,'only upstream advancement closes the borrowed native');assert.equal(p.natives[0].clones[0].closed,1);
 assert.deepEqual([first.element.width,first.element.height],[2,2]);s.complete(1);await tick();
 assert.equal(frames.stats.prepared,2,'the next preparation completed while N was still owned by the consumer');assert.equal(p.counts.next,2);
 assert.equal(first.preparedInput?.pixels[0],1);assert.equal((first as any).nativeFrame,undefined);
 const second=(await frames.next()).value!;assert.equal(first.element.width,0);await until(()=>s.jobs.length===3);
 assert.equal(second.preparedSourceId,2);assert.equal(second.preparedInput?.pixels[0],2);s.complete(2);
 const third=(await frames.next()).value!;assert.equal(third.preparedSourceId,3);assert.equal((await frames.next()).done,true);
 assert.equal(p.counts.returned,1);assert.deepEqual(s.retained,[1,2,3]);assert.deepEqual(s.released,[1,2,3]);
 assert.equal(frames.stats.retainedBytes,0);assert.equal(frames.stats.pendingReads,0);assert.ok(frames.stats.peakRetainedFrames<=2);
 for(const canvas of c.values)assert.deepEqual([canvas.width,canvas.height],[0,0]);
});

test('fallback snapshots the actual borrowed Canvas synchronously and owns distinct immutable geometry',async()=>{
 const p=provider({native:false,sizes:[2,3]}),s=sourceScope({automatic:true}),c=canvases(),frames=preparedRecoveryPrefetch(p.frames,s.sources,new AbortController().signal,{elapsed:()=>10,canvasFactory:c.factory});
 const first=(await frames.next()).value!;await until(()=>s.jobs.length===2);
 assert.equal(first.element.width,2);assert.equal((first.element as unknown as Canvas).tag,1);assert.equal(p.borrowed.tag,2);
 assert.equal(first.preparedInput!.pixels[0],1);assert.equal(first.width,2);assert.equal(first.height,2);
 assert.equal((first.element as unknown as Canvas).draws,1);assert.equal(p.counts.next,2);
 const second=(await frames.next()).value!;assert.equal(second.width,3);assert.equal(second.element.width,3);assert.notEqual(first.element,second.element);
 assert.equal(second.preparedInput!.pixels[0],2);assert.equal(first.element.width,0);await frames.return();assert.equal(p.counts.returned,1);
});

test('canonical source keeps ID, hash, mutable analysis reference and owned RGBA without another reservation',async()=>{
 const p=provider({count:2,canonical:true}),s=sourceScope({automatic:true}),c=canvases(),frames=preparedRecoveryPrefetch(p.frames,s.sources,new AbortController().signal,{elapsed:()=>10,canvasFactory:c.factory});
 const first=(await frames.next()).value!;await until(()=>p.counts.next===2);
 assert.equal(first.canonicalFrameId,7);assert.equal(first.preparedSourceId,7);assert.equal(first.sourceHash,'a'.repeat(64));assert.equal(first.analysis,p.analyses[0]);
 assert.deepEqual(Array.from(first.rgba!),new Array(16).fill(1));assert.equal(p.originalRgba[0].byteLength,0,'ownership moves before the source pool advances');
 p.analyses[0].tag=9;assert.equal(first.analysis!.tag,9);assert.equal(first.preparedInput,undefined);
 assert.equal(s.jobs.length,0);assert.equal(s.readyCalls,0);assert.equal((first.element as unknown as Canvas).draws,0);
 const second=(await frames.next()).value!;assert.equal(second.canonicalFrameId,8);assert.equal(second.rgba![0],2);await frames.return();
 assert.equal(frames.stats.canonical,2);assert.equal(frames.stats.prepared,0);assert.equal(frames.stats.retainedBytes,0);
});

test('one large next frame waits for the current owner instead of dropping input or widening its byte cap',async()=>{
 const p=provider({count:2,native:true}),s=sourceScope({automatic:true}),c=canvases(),frames=preparedRecoveryPrefetch(p.frames,s.sources,new AbortController().signal,
  {elapsed:()=>10,canvasFactory:c.factory,maxRetainedBytes:32});
 const first=(await frames.next()).value!;await until(()=>p.counts.next===2&&frames.stats.serializedForBudget===1);
 assert.equal(s.jobs.length,1);assert.equal(p.natives[1].clones.length,0,'borrow remains with the stopped decoder while budget is occupied');
 assert.equal(first.element.width,2);assert.equal(frames.stats.retainedBytes,32);
 const second=(await frames.next()).value!;assert.equal(second.preparedSourceId,2);assert.equal(second.preparedInput!.pixels[0],2);
 assert.equal(first.element.width,0);assert.equal((await frames.next()).done,true);assert.equal(frames.stats.peakRetainedFrames,1);
 assert.equal(frames.stats.peakRetainedBytes,32);assert.equal(frames.stats.retainedBytes,0);
});

test('writer backpressure precedes the next source clone and normal return cancels only that local wait',async()=>{
 const parent=new AbortController(),p=provider({native:true}),s=sourceScope({automatic:true,readySecond:true}),c=canvases(),frames=preparedRecoveryPrefetch(p.frames,s.sources,parent.signal,{elapsed:()=>10,canvasFactory:c.factory});
 await frames.next();await until(()=>s.readyCalls===2);assert.equal(s.jobs.length,1);assert.equal(p.natives[1].clones.length,0);
 await frames.return();assert.equal(parent.signal.aborted,false);assert.equal(p.counts.returned,1);assert.equal(p.natives[1].closed,1);
 assert.equal(s.jobs.length,1);assert.deepEqual(s.released,[1]);assert.equal(frames.stats.retainedBytes,0);
});

test('early return joins an already reserved next preparation and keeps that physical backup without a consumer',async()=>{
 const p=provider({native:true}),s=sourceScope(),c=canvases(),frames=preparedRecoveryPrefetch(p.frames,s.sources,new AbortController().signal,{elapsed:()=>10,canvasFactory:c.factory});
 const starting=frames.next();await until(()=>s.jobs.length===1);s.complete(0);await starting;await until(()=>s.jobs.length===2);
 let settled=false;const returning=frames.return().then(()=>{settled=true;});await tick();assert.equal(settled,false,'reserved source preparation is joined, never abandoned');
 s.complete(1);await returning;assert.equal(s.jobs.length,2);assert.equal(p.counts.returned,1);
 assert.equal(s.jobs[1].owned!.closed,1);assert.ok(s.released.includes(2));assert.equal(frames.stats.retainedBytes,0);
});

test('a real prefetched preparation failure is observed even if the consumer returns early',async()=>{
 const p=provider({native:true}),s=sourceScope(),c=canvases(),frames=preparedRecoveryPrefetch(p.frames,s.sources,new AbortController().signal,{elapsed:()=>10,canvasFactory:c.factory});
 const starting=frames.next();await until(()=>s.jobs.length===1);s.complete(0);await starting;await until(()=>s.jobs.length===2);
 s.reject(1,Error('future source SHA failure'));await tick();await assert.rejects(frames.return(),/future source SHA failure/);
 assert.equal(p.counts.returned,1);assert.equal(frames.stats.retainedBytes,0);assert.ok(s.released.includes(2));
});

test('negative sample PTS, oversized pixels, native geometry mismatch and malformed canonical bytes fail without clamping or reservations',async()=>{
 for(const mode of ['negative','oversize','geometry','canonical']as const){
  const p=provider({count:1,native:mode==='geometry',canonical:mode==='canonical',times:mode==='negative'?[-.01]:undefined}),s=sourceScope(),c=canvases();
  if(mode==='geometry')p.borrowed.width=9;
  const raw=p.frames[Symbol.asyncIterator](),frames={async *[Symbol.asyncIterator](){const value=await raw.next();if(value.done)return;
   if(mode==='geometry')Object.assign(value.value,{element:{width:3,height:2}});if(mode==='canonical')Object.assign(value.value,{rgba:new Uint8Array(15)});
   try{yield value.value;}finally{await raw.return?.();}}};
  const input=preparedRecoveryPrefetch(frames,s.sources,new AbortController().signal,{elapsed:()=>10,canvasFactory:c.factory,maxRetainedBytes:mode==='oversize'?31:128});
  await assert.rejects(input.next());assert.equal(s.jobs.length,0);assert.equal(input.stats.retainedBytes,0);assert.equal(p.counts.returned,1);
 }
});

test('duplicate PTS keeps original order and ephemeral IDs remain process-local output identities',async()=>{
 const p=provider({count:2,native:true,times:[0,0]}),s=sourceScope({automatic:true,ephemeral:true}),c=canvases(),frames=preparedRecoveryPrefetch(p.frames,s.sources,new AbortController().signal,{elapsed:()=>10,canvasFactory:c.factory});
 const output=[];for await(const frame of frames)output.push({id:frame.preparedSourceId,time:frame.time,physical:s.sources.isPersistent(),captureTime:frame.preparedInput!.binding.captureTime});
 assert.deepEqual(output,[{id:317,time:0,physical:false,captureTime:0},{id:318,time:0,physical:false,captureTime:0}]);assert.equal(p.counts.returned,1);
});

test('parked decoder next is joined through parent abort rather than abandoned by a normal return',async()=>{
 const parent=new AbortController(),gate=deferred<IteratorResult<RecoveryPreparationInput>>(),s=sourceScope({automatic:true}),c=canvases(),borrowed=new Native(2,2,1);
 let next=0,returned=0;
 const upstream={ [Symbol.asyncIterator](){return {
  async next(){next++;if(next===1)return {done:false,value:{element:{width:2,height:2} as HTMLCanvasElement,nativeFrame:borrowed as unknown as VideoFrame,time:0,percent:0}};
   borrowed.close();parent.signal.addEventListener('abort',()=>gate.reject(parent.signal.reason),{once:true});return await gate.promise;},
  async return(){returned++;return {done:true,value:undefined};},
 };}};
 const frames=preparedRecoveryPrefetch(upstream,s.sources,parent.signal,{elapsed:()=>10,canvasFactory:c.factory});await frames.next();await until(()=>next===2);
 let settled=false;const returning=frames.return().then(()=>{settled=true;});await tick();assert.equal(settled,false);
 parent.abort(Error('parent stopped decoder'));await returning;assert.equal(returned,1);assert.equal(borrowed.closed,1);assert.equal(frames.stats.retainedBytes,0);
});

test('cleanup reporting failure still releases placeholders and joins the upstream iterator once',async()=>{
 const p=provider({count:1,native:true}),s=sourceScope({automatic:true,releaseFailure:true}),c=canvases(),frames=preparedRecoveryPrefetch(p.frames,s.sources,new AbortController().signal,{elapsed:()=>10,canvasFactory:c.factory});
 const first=(await frames.next()).value!;await assert.rejects(frames.return(),/release report failed/);
 assert.equal(first.element.width,0);assert.equal(p.counts.returned,1);assert.equal(frames.stats.retainedBytes,0);
});

test('an already prepared placeholder cannot be accidentally resubmitted as new source pixels',async()=>{
 const s=sourceScope({automatic:true}),c=canvases();let returned=0;
 const upstream={async *[Symbol.asyncIterator](){try{yield {element:{width:2,height:2} as HTMLCanvasElement,time:0,percent:0,preparedSourceId:9};}finally{returned++;}}};
 const frames=preparedRecoveryPrefetch(upstream,s.sources,new AbortController().signal,{elapsed:()=>10,canvasFactory:c.factory});
 await assert.rejects(frames.next(),/already prepared/);assert.equal(s.jobs.length,0);assert.equal(returned,1);assert.equal(frames.stats.retainedBytes,0);
});
