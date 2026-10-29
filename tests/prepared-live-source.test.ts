import {test} from 'node:test';import assert from 'node:assert/strict';
import {createPreparedLiveSource} from '../src/features/card-scanner/prepared-live-source';
import type {PreparedSource,SourceBinding} from '../src/features/card-scanner/source-preparation';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('attested live source forwards requested tickets only while a physical writer can consume them',async()=>{
 const requests:{attest?:boolean}[]=[],submitted:any[]=[],closed:number[]=[],controller=new AbortController();
 const descriptor={format:'I420' as const,codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,visibleRect:{x:0,y:0,width:2,height:2},rotation:0,flip:false,
  colorSpace:{primaries:'smpte170m',transfer:'smpte170m',matrix:'smpte170m',fullRange:false}};
 const capture={captured:0,stats:{error:''},reserve(value:any){this.captured++;return {...value,id:this.captured};},
  submitPrepared(id:number,payload:any){submitted.push({id,payload});},rejectReserved(){},cancel(){}};
 const preparer={async prepare(owned:VideoFrame|ImageBitmap,binding:SourceBinding,request?:{attest?:boolean}):Promise<PreparedSource>{
  requests.push(request!);owned.close();return {binding,width:2,height:2,pixels:new Uint8Array(16),
   storage:{kind:'native',descriptor,pixels:new Uint8Array(6),...(request?.attest?{ticketId:'98a0b3bb-a302-415b-aa05-cdf86d403c22'}:{})},
   hash:'a'.repeat(64),mode:'native',reservationBytes:32,outputBytes:22,timing:{copyMs:0,conversionHashMs:0,rasterMs:0,totalMs:0}};
 }};
 const source=createPreparedLiveSource(capture,preparer,controller.signal,{attestNative:true});
 const input=(id:number)=>({displayWidth:2,displayHeight:2,clone(){return {displayWidth:2,displayHeight:2,close(){closed.push(id);}};}}) as unknown as VideoFrame;
 const first=source.submit(input(1),9,1)!;source.retain(first);await source.take(first);
 assert.deepEqual(requests,[{attest:true}]);assert.equal(submitted[0].payload.native.ticketId,'98a0b3bb-a302-415b-aa05-cdf86d403c22');
 capture.stats.error='quota';const second=source.submit(input(2),3,2)!;source.retain(second);await source.take(second);
 assert.deepEqual(requests,[{attest:true},{attest:false}]);assert.equal(submitted.length,1);
 assert.equal(source.isPersistent(second),false);assert.equal(source.stats.ephemeralSources,1);assert.deepEqual(closed,[1,2]);await source.finish();source.dispose();
});

test('live source rejects a missing requested native ticket before handing off storage',async()=>{
 const descriptor={format:'I420' as const,codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,visibleRect:{x:0,y:0,width:2,height:2},rotation:0,flip:false,
  colorSpace:{primaries:'smpte170m',transfer:'smpte170m',matrix:'smpte170m',fullRange:false}};
 let sent=0,canceled=0;
 const capture={captured:1,stats:{error:''},reserve:(value:any)=>({...value,id:1}),submitPrepared(){sent++;},rejectReserved(){},cancel(){canceled++;}};
 const source=createPreparedLiveSource(capture,{async prepare(owned,binding){owned.close();return {binding,width:2,height:2,pixels:new Uint8Array(16),
  storage:{kind:'native',descriptor,pixels:new Uint8Array(6)},hash:'a'.repeat(64),mode:'native',reservationBytes:32,outputBytes:22,
  timing:{copyMs:0,conversionHashMs:0,rasterMs:0,totalMs:0}};}},new AbortController().signal,{attestNative:true,
  snapshot:()=>({displayWidth:2,displayHeight:2,close(){}}) as unknown as VideoFrame});
 const id=source.submit({width:2,height:2} as HTMLCanvasElement,0,0)!;
 source.retain(id);await assert.rejects(source.take(id),/ticket request mismatch/);await assert.rejects(source.flush(),/ticket request mismatch/);
 source.dispose();assert.equal(sent,0);assert.equal(canceled,1);
});
function scope(options:{hold?:boolean;maxFrames?:number}={}){
 let sequence=0,canceled=0,closed=0;const sent:number[]=[],prepared:number[]=[],rejected:number[]=[],waiters:(()=>void)[]=[];
 const capture={reserve:(value:{width:number;height:number;time:number;elapsed:number;role?:'input'|'backup'|'recovery'})=>({...value,role:value.role??'backup',id:++sequence}),
  submitPrepared:(id:number)=>{sent.push(id);},rejectReserved:(id:number)=>{rejected.push(id);},cancel:()=>{canceled++;},get captured(){return sequence;},stats:{error:''}};
 const input=()=>({displayWidth:2,displayHeight:2,close(){closed++;},clone(){return input();}}) as unknown as VideoFrame;
 const preparer={async prepare(owned:VideoFrame|ImageBitmap,binding:SourceBinding):Promise<PreparedSource>{
  prepared.push(binding.sourceFrameId);if(options.hold)await new Promise<void>(resolve=>waiters.push(resolve));owned.close();
  return {binding,width:2,height:2,pixels:new Uint8Array(16).fill(binding.sourceFrameId),storage:{kind:'rgba',pixels:new ArrayBuffer(16)},
   hash:'a'.repeat(64),mode:'rgba',fallbackReason:'test',reservationBytes:32,outputBytes:32,timing:{copyMs:0,conversionHashMs:0,rasterMs:0,totalMs:0}};
 }};
 const controller=new AbortController(),source=createPreparedLiveSource(capture,preparer,controller.signal,{maxFrames:options.maxFrames});
 return {source,controller,input,sent,prepared,rejected,waiters,get canceled(){return canceled;},get closed(){return closed;}};
}
test('a replaced recognition lease still persists its source but releases full RGBA without blocking another use',async()=>{
 const s=scope({hold:true}),first=s.source.submit(s.input(),3,1)!,second=s.source.submit(s.input(),1,2)!;
 s.source.retain(first);s.source.retain(second);s.source.release(first);await tick();assert.deepEqual(s.prepared,[first]);
 s.waiters.shift()!();await tick();assert.deepEqual(s.sent,[first]);assert.deepEqual(s.prepared,[first,second]);
 const taken=s.source.take(second);s.waiters.shift()!();const pixels=await taken;
 assert.equal(pixels.binding.captureTime,1);assert.equal(pixels.pixels[0],second);assert.deepEqual(s.sent,[first,second]);
 assert.equal(s.source.stats.pendingBytes,0);assert.equal(s.closed,2);await s.source.finish();s.source.dispose();assert.equal(s.canceled,0);
});
test('end joins reserved preparation before the canonical producer can end',async()=>{
 const s=scope({hold:true});s.source.submit(s.input(),0,0);await tick();let finished=false;
 const ending=s.source.finish().then(()=>{finished=true;});await tick();assert.equal(finished,false);
 s.waiters.shift()!();await ending;assert.deepEqual(s.sent,[1]);assert.equal(s.closed,1);s.source.dispose();assert.equal(s.canceled,0);
});

test('finite recovery waits for canonical credits before owning or preparing another source',async()=>{
 const parent=new AbortController();let resolve!:()=>void,calls=0,prepared=0;
 const capture={reserve(){assert.fail('readiness must not reserve');},submitPrepared(){assert.fail();},rejectReserved(){},cancel(){},captured:0,stats:{error:''},
  async waitForRecoveryCapacity(bytes:number,signal:AbortSignal){calls++;assert.equal(bytes,32);assert.equal(signal,parent.signal);await new Promise<void>(yes=>{resolve=yes;});}};
 const source=createPreparedLiveSource(capture,{async prepare(){prepared++;throw Error('must not prepare');}},parent.signal);
 let ready=false;const waiting=source.readyForRecovery(2,2).then(()=>{ready=true;});await tick();assert.equal(ready,false);
 assert.equal(calls,1);assert.equal(prepared,0);assert.equal(source.stats.pendingBytes,0);resolve();await waiting;assert.equal(ready,true);
 await source.finish();source.dispose();
});

test('recovery-local cancellation releases a credit wait without cancelling the source or its recording',async()=>{
 const parent=new AbortController(),local=new AbortController();let canceled=0;
 const capture={reserve(){assert.fail();},submitPrepared(){assert.fail();},rejectReserved(){},cancel(){canceled++;},captured:0,stats:{error:''},
  async waitForRecoveryCapacity(_bytes:number,signal:AbortSignal){await new Promise<void>((_yes,no)=>signal.addEventListener('abort',()=>no(signal.reason),{once:true}));}};
 const source=createPreparedLiveSource(capture,{async prepare(){throw Error('must not prepare');}},parent.signal);
 const reason=Error('stop only finite prefetch'),waiting=assert.rejects(source.readyForRecovery(2,2,local.signal),error=>error===reason);
 local.abort(reason);await waiting;assert.equal(parent.signal.aborted,false);assert.equal(source.stats.failed,false);assert.equal(canceled,0);
 await source.finish();source.dispose();
});

test('a known recording failure bypasses recovery credits but still validates size and cancellation',async()=>{
 const parent=new AbortController();let calls=0;
 const capture={reserve(){assert.fail();},submitPrepared(){assert.fail();},rejectReserved(){},cancel(){},captured:0,stats:{error:'writer capacity exceeded'},
  async waitForRecoveryCapacity(){calls++;assert.fail('failed recording cannot release credits');}};
 const source=createPreparedLiveSource(capture,{async prepare(){throw Error('must not prepare');}},parent.signal,{maxBytes:32});
 await source.readyForRecovery(2,2);assert.equal(calls,0);await assert.rejects(source.readyForRecovery(3,2),/byte limit/);
 const local=AbortSignal.abort(Error('closed recovery'));await assert.rejects(source.readyForRecovery(2,2,local),/closed recovery/);
 await source.finish();source.dispose();await assert.rejects(source.readyForRecovery(2,2),/closed/);
});
test('pending source count and bytes are bounded and failure releases queued owned handles',async()=>{
 const s=scope({hold:true,maxFrames:2});s.source.submit(s.input(),0,0);s.source.submit(s.input(),1,1);await tick();
 assert.equal(s.source.submit(s.input(),2,2),undefined);assert.equal(s.source.stats.peakJobs,2);assert.equal(s.source.stats.peakPendingBytes,64);
 await tick();assert.equal(s.closed,1,'queued clone released while active owner remains with preparer');
 s.waiters.shift()!();await tick();assert.equal(s.closed,2);assert.deepEqual(s.sent,[]);await assert.rejects(s.source.flush());s.source.dispose();
});
test('abort before a slow bitmap snapshot resolves closes that snapshot exactly once',async()=>{
 let finish!:(value:ImageBitmap)=>void,closed=0,canceled=0;
 const capture={reserve:(value:any)=>({...value,id:1}),submitPrepared(){assert.fail('must not submit');},rejectReserved(){},cancel(){canceled++;},captured:1,stats:{error:''}};
 const source=createPreparedLiveSource(capture,{prepare:async()=>{throw Error('must not prepare');}},new AbortController().signal,
  {snapshot:()=>new Promise(resolve=>{finish=resolve;})});
 source.submit({width:2,height:2} as HTMLCanvasElement,0,0);source.dispose();finish({close(){closed++;}} as ImageBitmap);await tick();
 assert.equal(closed,1);assert.equal(canceled,1);assert.equal(source.stats.pendingBytes,0);
});
test('normal finish/dispose releases an unused retained RGBA without invalidating the completed recording',async()=>{
 const s=scope();const id=s.source.submit(s.input(),0,0)!;s.source.retain(id);await s.source.flush();assert.equal(s.source.stats.pendingBytes,32);
 await s.source.finish();s.source.dispose();assert.equal(s.source.stats.pendingBytes,0);assert.equal(s.canceled,0);assert.equal(s.closed,1);
});
test('snapshot deadline unblocks finish and a late bitmap is released',async()=>{
 let resolve!:(input:ImageBitmap)=>void,closed=0;
 const capture={reserve:(value:any)=>({...value,id:1}),submitPrepared(){assert.fail();},rejectReserved(){throw Error('report failure');},cancel(){throw Error('report failure');},captured:1,stats:{error:''}};
 const source=createPreparedLiveSource(capture,{prepare:async()=>{throw Error('must not prepare');}},new AbortController().signal,
  {snapshot:()=>new Promise(yes=>{resolve=yes;}),snapshotTimeoutMs:5});
 const id=source.submit({width:2,height:2} as HTMLCanvasElement,0,0)!;source.retain(id);const taken=assert.rejects(source.take(id),/snapshot timeout/);
 await assert.rejects(source.finish(),/snapshot timeout/);await taken;assert.equal(source.stats.pendingBytes,0);
 resolve({close(){closed++;}} as ImageBitmap);await tick();assert.equal(closed,1);source.dispose();
});

function recordingScope(options:{held?:boolean;reserveFailure?:'recording'|'silent';submitFailure?:'throw'|'status';badPreparation?:boolean;preparationFailure?:string}={}){
 let captured=0,reserveCalls=0,canceled=0,closed=0;const sent:number[]=[],rejected:number[]=[],waiters:(()=>void)[]=[],bindings:SourceBinding[]=[];
 const recording={error:''};
 const capture={
  reserve(value:{width:number;height:number;time:number;elapsed:number;role?:'input'|'backup'|'recovery'}){
   reserveCalls++;
   if(options.reserveFailure){if(options.reserveFailure==='recording')recording.error='Canonical frame index capacity exceeded';return;}
   return {...value,role:value.role??'backup',id:++captured};
  },
  submitPrepared(id:number){
   if(options.submitFailure){recording.error='NEW synchronous validation/transfer failure';if(options.submitFailure==='throw')throw Error(recording.error);return;}
   sent.push(id);
  },
  rejectReserved(id:number){rejected.push(id);},cancel(){canceled++;},get captured(){return captured;},get stats(){return recording;},
 };
 const input=()=>({displayWidth:2,displayHeight:2,close(){closed++;},clone(){return input();}}) as unknown as VideoFrame;
 const preparer={async prepare(owned:VideoFrame|ImageBitmap,binding:SourceBinding):Promise<PreparedSource>{
  bindings.push(binding);if(options.held)await new Promise<void>(resolve=>waiters.push(resolve));owned.close();if(options.preparationFailure)throw Error(options.preparationFailure);
  return {binding,width:2,height:2,pixels:new Uint8Array(options.badPreparation?15:16).fill(binding.sourceFrameId),
   storage:{kind:'rgba',pixels:new ArrayBuffer(16)},hash:'a'.repeat(64),mode:'rgba',fallbackReason:'test',reservationBytes:32,outputBytes:32,
   timing:{copyMs:0,conversionHashMs:0,rasterMs:0,totalMs:0}};
 }};
 const controller=new AbortController(),source=createPreparedLiveSource(capture,preparer,controller.signal);
 return {source,input,recording,sent,rejected,waiters,bindings,controller,get reserveCalls(){return reserveCalls;},get canceled(){return canceled;},get closed(){return closed;},
   highWater(value:number){captured=value;}};
}

test('known recording failure during preparation keeps queued pixels and later ephemeral acquisitions usable',async()=>{
 const s=recordingScope({held:true}),first=s.source.submit(s.input(),3,1)!,queued=s.source.submit(s.input(),1,2)!;
 s.source.retain(first);s.source.retain(queued);const firstTaken=s.source.take(first);await tick();
 s.waiters.shift()!();const firstPixels=await firstTaken;await tick();
 assert.equal(firstPixels.binding.sourceFrameId,first);assert.equal(s.source.isPersistent(first),true);assert.deepEqual(s.sent,[first]);
 // The asynchronous writer can fail while the next source is already owned by
 // preparation. Its valid pixels are not owned by the recording's fate.
 s.recording.error='Canonical frame index capacity exceeded';
 const queuedTaken=s.source.take(queued);s.waiters.shift()!();const queuedPixels=await queuedTaken;
 assert.equal(queuedPixels.binding.sourceFrameId,queued);assert.equal(queuedPixels.binding.captureTime,1);
 assert.equal(queuedPixels.pixels.length,16);assert.equal(s.source.isPersistent(queued),false);
 s.highWater(9);
 const transient=s.source.submit(s.input(),2,3)!;assert.equal(transient,10);s.source.retain(transient);const transientTaken=s.source.take(transient);await tick();
 s.waiters.shift()!();const transientPixels=await transientTaken;
 assert.equal(transientPixels.binding.sourceFrameId,10);assert.equal(transientPixels.binding.captureTime,2);assert.equal(transientPixels.pixels[0],10);
 assert.equal(s.source.isPersistent(transient),false);assert.equal(s.source.isPersistent(first),true,'verified prefix source identity remains physical');
 // Even if an external status string is cleared, the controller never turns a
 // process-local ID into an archive reservation or reuses its identity.
 s.recording.error='';const later=s.source.submit(s.input(),.5,4)!;assert.equal(later,11);s.source.retain(later);const laterTaken=s.source.take(later);await tick();
 s.waiters.shift()!();assert.equal((await laterTaken).binding.captureTime,.5);
 assert.equal(s.reserveCalls,2);assert.deepEqual(s.sent,[first]);assert.deepEqual(s.rejected,[]);assert.equal(s.canceled,0);
 assert.equal(s.source.stats.failed,false);assert.equal(s.source.stats.persistenceFailed,true);assert.equal(s.source.stats.recordingGapSources,3);
 assert.equal(s.source.stats.ephemeralSources,2);assert.equal(s.source.stats.unpersistedPrepared,3);
 assert.equal(s.source.stats.pendingBytes,0);assert.ok(s.source.stats.peakPendingBytes<=128*1024*1024);assert.ok(s.source.stats.peakJobs<=4);
 await s.source.finish();s.source.dispose();assert.equal(s.closed,4);assert.equal(s.canceled,0);
});

test('a recording-only reservation failure gives a fresh logical ID and does not retry storage',async()=>{
 const s=recordingScope({reserveFailure:'recording'});s.highWater(316);
 const id=s.source.submit(s.input(),8,8000)!;assert.equal(id,317);s.source.retain(id);const pixels=await s.source.take(id);
 assert.equal(pixels.binding.sourceFrameId,317);assert.equal(pixels.binding.captureTime,8);assert.equal(s.source.isPersistent(id),false);
 const next=s.source.submit(s.input(),9,9000)!;assert.equal(next,318);s.source.retain(next);await s.source.take(next);
 assert.equal(s.reserveCalls,1);assert.deepEqual(s.sent,[]);assert.deepEqual(s.rejected,[]);assert.equal(s.source.stats.recordingGapSources,2);
 await s.source.finish();s.source.dispose();assert.equal(s.source.stats.failed,false);assert.equal(s.canceled,0);
});

test('a silent reserve decline is not mistaken for a recording failure',async()=>{
 const s=recordingScope({reserveFailure:'silent'});assert.equal(s.source.submit(s.input(),1,1000),undefined);
 assert.equal(s.source.stats.persistenceFailed,false);assert.equal(s.source.stats.ephemeralSources,0);assert.equal(s.bindings.length,0);
 await s.source.finish();s.source.dispose();assert.equal(s.canceled,0);
});

test('malformed prepared pixels remain fatal even after an existing recording failure',async()=>{
 const s=recordingScope({badPreparation:true});s.recording.error='disk quota';
 const id=s.source.submit(s.input(),1,1000)!;s.source.retain(id);
 const taken=assert.rejects(s.source.take(id),/prepared source pixels/);await assert.rejects(s.source.finish(),/prepared source pixels/);await taken;
 assert.equal(s.source.stats.failed,true);assert.equal(s.source.stats.pendingBytes,0);assert.deepEqual(s.sent,[]);assert.deepEqual(s.rejected,[]);
 assert.equal(s.canceled,1);assert.equal(s.closed,1);s.source.dispose();
});

test('new synchronous submit validation or transfer failures remain fatal rather than hiding behind file status',async()=>{
 for(const submitFailure of ['throw','status'] as const){
  const s=recordingScope({submitFailure}),id=s.source.submit(s.input(),1,1000)!;s.source.retain(id);
  const taken=assert.rejects(s.source.take(id),/synchronous validation/);await assert.rejects(s.source.finish(),/synchronous validation/);await taken;
  assert.equal(s.source.stats.failed,true);assert.equal(s.source.isPersistent(id),false);assert.equal(s.source.stats.pendingBytes,0);
  assert.deepEqual(s.sent,[]);assert.deepEqual(s.rejected,[id]);assert.equal(s.canceled,1);assert.equal(s.closed,1);s.source.dispose();
 }
});

test('invalid source timing cannot enter the ephemeral namespace after a recording failure',async()=>{
 const s=recordingScope();s.recording.error='disk quota';assert.equal(s.source.submit(s.input(),NaN,1000),undefined);
 assert.equal(s.source.stats.failed,true);assert.equal(s.source.stats.ephemeralSources,0);assert.equal(s.bindings.length,0);
 await assert.rejects(s.source.finish(),/time/);s.source.dispose();
});

test('a source preparation hash failure remains fatal in recording-only degraded mode',async()=>{
 const s=recordingScope({preparationFailure:'source SHA failed'});s.recording.error='disk quota';
 const id=s.source.submit(s.input(),1,1000)!;s.source.retain(id);
 const taken=assert.rejects(s.source.take(id),/source SHA failed/);await assert.rejects(s.source.finish(),/source SHA failed/);await taken;
 assert.equal(s.source.stats.failed,true);assert.equal(s.source.stats.unpersistedPrepared,0);assert.equal(s.source.stats.pendingBytes,0);
 assert.deepEqual(s.sent,[]);assert.deepEqual(s.rejected,[]);assert.equal(s.canceled,1);assert.equal(s.closed,1);s.source.dispose();
});

test('recording-only degraded mode keeps the same four-source and 128MiB queue bounds',async()=>{
 const s=recordingScope({held:true});s.recording.error='disk quota';
 for(let index=0;index<4;index++)assert.ok(s.source.submit(s.input(),index,index*1000));
 await tick();assert.equal(s.source.stats.peakJobs,4);
 assert.equal(s.source.submit(s.input(),4,4000),undefined);assert.equal(s.source.stats.failed,true);
 s.waiters.shift()!();await assert.rejects(s.source.finish(),/queue capacity/);
 assert.equal(s.source.stats.pendingBytes,0);assert.equal(s.closed,4);assert.deepEqual(s.sent,[]);assert.deepEqual(s.rejected,[]);s.source.dispose();
});

async function withSnapshotGlobals(frame:unknown,bitmap:unknown,run:()=>Promise<void>){
 const originals=['VideoFrame','createImageBitmap'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 Object.defineProperty(globalThis,'VideoFrame',{value:frame,configurable:true,writable:true});
 Object.defineProperty(globalThis,'createImageBitmap',{value:bitmap,configurable:true,writable:true});
 try{await run();}finally{
  for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
 }
}
function defaultSnapshotScope(prepare?:(owned:VideoFrame|ImageBitmap,binding:SourceBinding)=>Promise<PreparedSource>){
 let reserved=0,canceled=0,prepared=0;const sent:number[]=[],rejected:number[]=[];
 const capture={reserve(value:any){return {...value,id:++reserved};},submitPrepared(id:number){sent.push(id);},
  rejectReserved(id:number){rejected.push(id);},cancel(){canceled++;},get captured(){return reserved;},stats:{error:''}};
 const controller=new AbortController(),source=createPreparedLiveSource(capture,{async prepare(owned,binding){
  prepared++;if(prepare)return prepare(owned,binding);owned.close();
  return {binding,width:2,height:2,pixels:new Uint8Array(16),storage:{kind:'rgba',pixels:new ArrayBuffer(16)},hash:'a'.repeat(64),
   mode:'rgba',fallbackReason:'test',reservationBytes:32,outputBytes:32,timing:{copyMs:0,conversionHashMs:0,rasterMs:0,totalMs:0}};
 }},controller.signal);
 return {source,controller,sent,rejected,get reserved(){return reserved;},get canceled(){return canceled;},get prepared(){return prepared;}};
}

test('default video backup freezes one native sample synchronously without a bitmap or closing the borrowed video',async()=>{
 let native=0,bitmaps=0,closed=0,borrowedClosed=0,observedSample=0;
 const video={videoWidth:2,videoHeight:2,sample:10,close(){borrowedClosed++;}};
 class NativeSnapshot {
  displayWidth=2;displayHeight=2;sample:number;
  constructor(input:typeof video){assert.equal(s.reserved,1,'reserve identity before snapshot');native++;this.sample=input.sample;}
  close(){observedSample=this.sample;closed++;}
 }
 const s=defaultSnapshotScope();
 await withSnapshotGlobals(NativeSnapshot,()=>{bitmaps++;assert.fail('native video must not become a bitmap');},async()=>{
  const id=s.source.submit(video as unknown as HTMLVideoElement,3,1)!;
  assert.equal(native,1,'snapshot is constructed in submit, before asynchronous preparation');video.sample=20;
  s.source.retain(id);const value=await s.source.take(id);assert.equal(value.binding.captureTime,3);
  assert.equal(observedSample,10);assert.equal(closed,1);assert.equal(borrowedClosed,0);assert.equal(bitmaps,0);
  assert.deepEqual(s.sent,[id]);await s.source.finish();s.source.dispose();assert.equal(s.canceled,0);
 });
});

test('unavailable or unsupported native video constructors fall back to exactly one bitmap',async()=>{
 for(const available of [false,true]){
  let native=0,bitmaps=0,closed=0,borrowedClosed=0;
  const video={videoWidth:2,videoHeight:2,close(){borrowedClosed++;}};
  class UnsupportedSnapshot {constructor(){native++;throw Error('video constructor unsupported');}}
  await withSnapshotGlobals(available?UnsupportedSnapshot:undefined,async(input:unknown)=>{
   assert.equal(input,video);bitmaps++;return {width:2,height:2,close(){closed++;}};
  },async()=>{
   const s=defaultSnapshotScope(),id=s.source.submit(video as unknown as HTMLVideoElement,0,0)!;
   s.source.retain(id);await s.source.take(id);await s.source.finish();s.source.dispose();
   assert.equal(native,available?1:0);assert.equal(bitmaps,1);assert.equal(closed,1);assert.equal(borrowedClosed,0);
   assert.equal(s.canceled,0);assert.deepEqual(s.sent,[id]);
  });
 }
});

test('a successful native video snapshot followed by preparation failure never recaptures the moving video',async()=>{
 let native=0,bitmaps=0,closed=0;
 class NativeSnapshot {displayWidth=2;displayHeight=2;constructor(){native++;}close(){closed++;}}
 await withSnapshotGlobals(NativeSnapshot,async()=>{bitmaps++;throw Error('unexpected bitmap retry');},async()=>{
  const s=defaultSnapshotScope(async owned=>{owned.close();throw Error('native copy or SHA failure');});
  const id=s.source.submit({videoWidth:2,videoHeight:2} as HTMLVideoElement,0,0)!;s.source.retain(id);
  const reading=assert.rejects(s.source.take(id),/native copy or SHA failure/);
  await assert.rejects(s.source.finish(),/native copy or SHA failure/);await reading;s.source.dispose();
  assert.equal(native,1);assert.equal(bitmaps,0);assert.equal(closed,1);assert.equal(s.canceled,1);
  assert.deepEqual(s.sent,[]);assert.deepEqual(s.rejected,[id]);assert.equal(s.source.stats.pendingBytes,0);
 });
});

test('cancelling a synchronously frozen video before preparation releases only its owned snapshot once',async()=>{
 let native=0,bitmaps=0,closed=0,borrowedClosed=0;
 class NativeSnapshot {displayWidth=2;displayHeight=2;constructor(){native++;}close(){closed++;}}
 await withSnapshotGlobals(NativeSnapshot,async()=>{bitmaps++;assert.fail();},async()=>{
  const s=defaultSnapshotScope(),video={videoWidth:2,videoHeight:2,close(){borrowedClosed++;}};
  s.source.submit(video as unknown as HTMLVideoElement,0,0);s.controller.abort(Error('stop before preparation'));
  await assert.rejects(s.source.flush(),/stop before preparation/);await tick();s.source.dispose();
  assert.equal(native,1);assert.equal(bitmaps,0);assert.equal(closed,1);assert.equal(borrowedClosed,0);assert.equal(s.prepared,0);
  assert.equal(s.canceled,1);assert.equal(s.source.stats.pendingBytes,0);assert.deepEqual(s.sent,[]);
 });
});

test('cancelling queued native video snapshots preserves preparation ownership of the active snapshot',async()=>{
 let native=0,bitmaps=0,closed=0,finish!:()=>void;
 class NativeSnapshot {displayWidth=2;displayHeight=2;constructor(){native++;}close(){closed++;}}
 await withSnapshotGlobals(NativeSnapshot,async()=>{bitmaps++;assert.fail();},async()=>{
  const s=defaultSnapshotScope(async owned=>{await new Promise<void>(resolve=>{finish=resolve;});owned.close();throw Error('active preparation joined');});
  const video={videoWidth:2,videoHeight:2} as HTMLVideoElement;
  s.source.submit(video,0,0);s.source.submit(video,1,1);await tick();assert.equal(s.prepared,1);
  s.controller.abort(Error('stop queued video'));await tick();assert.equal(closed,1,'queued handle released; preparer still owns active handle');
  finish();await assert.rejects(s.source.flush(),/stop queued video/);await tick();s.source.dispose();
  assert.equal(native,2);assert.equal(bitmaps,0);assert.equal(closed,2);assert.equal(s.canceled,1);
  assert.equal(s.source.stats.pendingBytes,0);assert.deepEqual(s.sent,[]);
 });
});

test('existing VideoFrame cloning and canvas bitmap snapshots do not use the video constructor branch',async()=>{
 let native=0,bitmaps=0,cloned=0,ownedClosed=0,borrowedClosed=0;
 class UnexpectedSnapshot {constructor(){native++;assert.fail('only video elements may use this constructor');}}
 const canvas={width:2,height:2},borrowed={displayWidth:2,displayHeight:2,clone(){cloned++;return {displayWidth:2,displayHeight:2,close(){ownedClosed++;}};},close(){borrowedClosed++;}};
 await withSnapshotGlobals(UnexpectedSnapshot,async(input:unknown)=>{assert.equal(input,canvas);bitmaps++;return {width:2,height:2,close(){ownedClosed++;}};},async()=>{
  const s=defaultSnapshotScope();s.source.submit(borrowed as unknown as VideoFrame,0,0);s.source.submit(canvas as HTMLCanvasElement,1,1);
  await s.source.finish();s.source.dispose();assert.equal(native,0);assert.equal(cloned,1);assert.equal(bitmaps,1);
  assert.equal(ownedClosed,2);assert.equal(borrowedClosed,0);assert.deepEqual(s.sent,[1,2]);assert.equal(s.canceled,0);
 });
});
