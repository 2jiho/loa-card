import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanonicalCapture} from '../src/features/card-scanner/canonical-capture';
import type {SavedAcquisition} from '../src/features/card-scanner/saved-acquisition';
import type {NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';
import type {SourcePreparationAttestationIdentity} from '../src/features/card-scanner/source-preparation-protocol';
import type {PreparedNativeAttestation} from '../src/features/card-scanner/prepared-native-attestation';
import {planNativeYuvFrame} from '../src/features/card-scanner/native-yuv-recipe';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
type Source=VideoFrame&{tag:number};
const source=(tag:number,width=1,height=1)=>({displayWidth:width,displayHeight:height,tag}) as Source;
type FrameRequest={kind:'frame';id:number;width:number;height:number;time:number;role:string;phase:string;canonical:boolean;bitmap?:ImageBitmap&{tag:number};pixels?:ArrayBuffer;native?:{pixels:Uint8Array<ArrayBuffer>}};

function harness(options:{manualCopies?:boolean;manualAck?:boolean;manualDrain?:boolean;byteLimit?:number;ownedRgba?:boolean;recoveryCapacityTimeoutMs?:number;onTiming?:(value:unknown)=>void;attestation?:SourcePreparationAttestationIdentity;read?:(id:number,signal:AbortSignal)=>Promise<unknown>}={}){
  const requests:Record<string,unknown>[]=[],reports:string[]=[],incomplete:string[]=[],uses:unknown[]=[],receipts:unknown[]=[],reads:number[]=[];
  const stored=new Map<number,{id:number;width:number;height:number;time:number;hash:string;pixels:Uint8ClampedArray<ArrayBuffer>}>();
  const copies:{tag:number;resolve:(bitmap:ImageBitmap)=>void;reject:(reason:unknown)=>void;closed:number}[]=[];
  const raster:{width:number;height:number;pixel:number}[]=[],attestations:PreparedNativeAttestation[]=[];
  let portClosed=0,portStarted=0,taken=0;
  const port={onmessage:null as ((event:MessageEvent)=>void)|null,start(){portStarted++;},close(){portClosed++;},
    postMessage(message:Record<string,unknown>){
      requests.push(message);
      if(message.kind==='drain'&&!options.manualDrain)queueMicrotask(()=>port.onmessage?.({data:{kind:'drained'}} as MessageEvent));
      if(message.kind!=='frame')return;
      const frame=message as unknown as FrameRequest;
      stored.set(frame.id,{id:frame.id,width:frame.width,height:frame.height,time:frame.time,hash:'a'.repeat(64),
        pixels:frame.pixels?new Uint8ClampedArray(frame.pixels):new Uint8ClampedArray(frame.width*frame.height*4).fill(frame.bitmap?.tag??0)});
      // A real transferred bitmap is owned and closed by the receiver.
      frame.bitmap?.close();
      if(!options.manualAck)queueMicrotask(()=>port.onmessage?.({data:{kind:'stored',...stored.get(frame.id)}} as MessageEvent));
    }};
  const canvas={width:0,height:0,getContext:()=>({putImageData(image:ImageData){raster.push({width:image.width,height:image.height,pixel:image.data[0]});}})} as unknown as HTMLCanvasElement;
  const capture=createCanonicalCapture({
    takePort(){taken++;return port as unknown as MessagePort;},
    incomplete(reason){incomplete.push(reason);},
    async readFrame(id,signal){
      reads.push(id);if(options.read)return await options.read(id,signal) as Awaited<ReturnType<Parameters<typeof createCanonicalCapture>[0]['readFrame']>>;
      signal.throwIfAborted();const frame=stored.get(id);if(!frame)throw Error('missing fake stored frame');
      return {...frame,pixels:frame.pixels.slice()};
    },
  },message=>reports.push(message),{
    byteLimit:options.byteLimit,
    recoveryCapacityTimeoutMs:options.recoveryCapacityTimeoutMs,
    bitmapFactory:input=>new Promise<ImageBitmap>((resolve,reject)=>{
      const copy={tag:(input as Source).tag,resolve,reject,closed:0};copies.push(copy);
      if(!options.manualCopies)resolve({tag:copy.tag,close(){copy.closed++;}} as unknown as ImageBitmap);
    }),
    canvasFactory:()=>canvas,onUse:value=>uses.push(value),onRasterReceipt:value=>receipts.push(value),ownedRgba:options.ownedRgba,onTiming:options.onTiming,
    attestation:options.attestation,onStorageAttestation:value=>attestations.push(value),
  });
  return {capture,requests,reports,incomplete,uses,receipts,reads,copies,raster,canvas,attestations,
    frames:()=>requests.filter(value=>value.kind==='frame') as unknown as FrameRequest[],
    resolveCopy(index:number){const copy=copies[index];copy.resolve({tag:copy.tag,close(){copy.closed++;}} as unknown as ImageBitmap);},
    ack(id:number,override:Record<string,unknown>={}){port.onmessage?.({data:{kind:'stored',...stored.get(id),id,...override}} as MessageEvent);},
    drained(){port.onmessage?.({data:{kind:'drained'}} as MessageEvent);},
    sourceError(error:string){port.onmessage?.({data:{kind:'source-error',error}} as MessageEvent);},
    portCounts:()=>({closed:portClosed,started:portStarted,taken}),
  };
}

test('serialized recovery waits for stored ACK credits without dropping a frame or widening the byte cap',async()=>{
 const h=harness({manualAck:true,byteLimit:8});const record=h.capture.reserve({width:1,height:1,time:1,elapsed:1,role:'recovery'})!;
 h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
 let ready=false;const waiting=h.capture.waitForRecoveryCapacity(8,new AbortController().signal).then(()=>{ready=true;});
 await turn();assert.equal(ready,false);assert.equal(h.capture.captured,1);assert.equal(h.capture.stats.waitingForCapacity,true);assert.equal(h.capture.stats.error,'');
 h.ack(1);await waiting;const next=h.capture.reserve({width:1,height:1,time:2,elapsed:2,role:'recovery'})!;
 assert.equal(next.id,2);assert.equal(h.capture.stats.peakPendingBytes,8);
 h.capture.submitPrepared(2,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});h.ack(2);await h.capture.finish();
 assert.equal(h.capture.stats.waitingForCapacity,false);assert.equal(h.capture.stats.capacityWaits,1);
});
test('recording failure unblocks a capacity wait into explicit unrecorded processing',async()=>{
 const h=harness({manualAck:true,byteLimit:8});const record=h.capture.reserve({width:1,height:1,time:1,elapsed:1})!;
 h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
 const waiting=h.capture.waitForRecoveryCapacity(8,new AbortController().signal);h.sourceError('disk quota exceeded');await waiting;
 assert.match(h.capture.stats.error,/disk quota/);assert.equal(h.capture.stats.waitingForCapacity,false);assert.equal(h.capture.stats.pendingBytes,0);
 assert.equal(h.capture.reserve({width:1,height:1,time:2,elapsed:2}),undefined);await h.capture.finish();
});
test('capacity cancellation releases only the waiter while keeping the already accepted source',async()=>{
 const h=harness({manualAck:true,byteLimit:8});const record=h.capture.reserve({width:1,height:1,time:1,elapsed:1})!;
 h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});const control=new AbortController();
 const waiting=h.capture.waitForRecoveryCapacity(8,control.signal);const rejected=assert.rejects(waiting,{name:'AbortError'});control.abort();await rejected;
 assert.equal(h.capture.stats.error,'');assert.equal(h.capture.stats.pending,1);assert.equal(h.capture.stats.waitingForCapacity,false);
 h.ack(1);await h.capture.finish();assert.equal(h.capture.stats.storedFrames,1);
});
test('capacity wait deadline marks partial storage but does not hang recovery',async()=>{
 const h=harness({manualAck:true,byteLimit:8,recoveryCapacityTimeoutMs:5});const record=h.capture.reserve({width:1,height:1,time:1,elapsed:1})!;
 h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
 await h.capture.waitForRecoveryCapacity(8,new AbortController().signal);assert.match(h.capture.stats.error,/저장 대기 시간 초과/);
 assert.equal(h.capture.stats.pending,0);assert.equal(h.capture.stats.waitingForCapacity,false);await h.capture.finish();
});
test('capacity wait rejects concurrent waiters, oversized requests and completion races',async()=>{
 const h=harness({manualAck:true,byteLimit:8});const record=h.capture.reserve({width:1,height:1,time:1,elapsed:1})!;
 h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});const signal=new AbortController().signal;
 assert.throws(()=>h.capture.waitForRecoveryCapacity(9,signal),/예약 크기/);
 const waiting=h.capture.waitForRecoveryCapacity(8,signal);assert.throws(()=>h.capture.waitForRecoveryCapacity(8,signal),/동시/);
 const rejected=assert.rejects(waiting,/종료/),ending=h.capture.finish();await rejected;h.ack(1);await ending;
 assert.throws(()=>h.capture.waitForRecoveryCapacity(8,signal),/종료/);assert.equal(h.capture.stats.pendingBytes,0);
});
test('failed raster receipts are unverified rather than still pending after storage terminates',async()=>{
 const h=harness({manualAck:true});const record=h.capture.reserve({width:1,height:1,time:1,elapsed:1})!;
 h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
 h.capture.use(record.id,17,'input',1,{version:1,kind:'measured',sourceFrameId:record.id,acquisitionFrameId:17,captureTime:1,width:1,height:1,hash:'a'.repeat(64)});
 assert.equal(h.capture.stats.pendingRasterUses,1);h.sourceError('disk error');assert.equal(h.capture.stats.pendingRasterUses,0);
 assert.equal(h.capture.stats.unverifiedRasterUses,1);await h.capture.finish();
});

test('experimental source timings retain the pending prefix before failure and update only the first late ACK',async()=>{
 const snapshots:unknown[]=[],h=harness({manualAck:true,ownedRgba:true,onTiming:value=>snapshots.push(value)});
 const first=h.capture.reserve({width:1,height:1,time:1,elapsed:1})!,second=h.capture.reserve({width:1,height:1,time:2,elapsed:2})!;
 h.capture.notePreparation(first.id,{copyMs:1,conversionHashMs:2,rasterMs:0,totalMs:4});
 h.capture.submitPrepared(first.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});h.sourceError('writer stopped before ACK');
 assert.equal(h.capture.stats.pending,0);const failure=h.capture.stats.timing!.failure!;
 assert.deepEqual(failure.pending.map(({id,bytes,prepared,transferred})=>({id,bytes,prepared,transferred})),[
  {id:first.id,bytes:8,prepared:true,transferred:true},{id:second.id,bytes:8,prepared:false,transferred:false}]);
 h.ack(first.id,{timing:{version:1,path:'rgba',queuedMs:10,prepareMs:20,packMs:2,compressMs:3,appendMs:4,workMs:30,receiveToAckMs:40}});
 for(let index=0;index<20;index++)h.ack(first.id);
 const row=h.capture.stats.timing!.sources[0];assert.equal(row.worker?.prepareMs,20);assert.equal(row.preparation?.copyMs,1);
 assert.ok(row.reserveToAckMs!==undefined&&row.reserveToAckMs>=0);assert.equal(snapshots.length,2,'one failure and the first late ACK only');
 assert.deepEqual(h.capture.stats.timing!.failure,failure);assert.equal(h.capture.stats.storedFrames,1);await h.capture.finish();
});

test('optional timing payload/reporting errors never reject valid stored pixels and callbacks remain first-eight bounded',async()=>{
 let callbacks=0;const h=harness({manualAck:true,ownedRgba:true,onTiming(){callbacks++;throw Error('optional sink failed');}});
 for(let index=0;index<10;index++){
  const record=h.capture.reserve({width:1,height:1,time:index,elapsed:index})!;
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});h.ack(record.id,{timing:{bad:'not a valid timing payload'}});
  assert.equal((await h.capture.stored(record.id)).hash,'a'.repeat(64));
 }
 assert.equal(callbacks,8);assert.equal(h.capture.stats.error,'');assert.equal(h.capture.stats.timing!.sources.length,8);
 assert.equal(h.capture.stats.timing!.ignored.workerTiming,8);assert.equal(h.capture.stats.timing!.truncatedSources,true);
 assert.equal(h.capture.stats.storedFrames,10);await h.capture.finish();
});

test('legacy capture leaves timing diagnostics disabled and a timing-bearing ACK cannot hide bad pixel evidence',async()=>{
 const legacy=harness();legacy.capture.submit(source(1),1,1);await legacy.capture.finish();assert.equal(legacy.capture.stats.timing,undefined);
 const h=harness({manualAck:true,ownedRgba:true}),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1})!;
 h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
 h.ack(record.id,{hash:'b'.repeat(64),timing:{version:1,path:'rgba',queuedMs:0,prepareMs:0,packMs:0,compressMs:0,appendMs:0,workMs:0,receiveToAckMs:0}});
 assert.match(h.capture.stats.error,/픽셀 근거/);assert.equal(h.capture.stats.storedFrames,0);assert.equal(h.capture.stats.timing!.sources[0].ackAtMs,undefined);
 await h.capture.finish();
});

async function imageDataScope(run:()=>Promise<void>){
  const previous=globalThis.ImageData;
  Object.assign(globalThis,{ImageData:class {
    constructor(public data:Uint8ClampedArray<ArrayBuffer>,public width:number,public height:number){}
  }});
  try{await run();}finally{Object.assign(globalThis,{ImageData:previous});}
}

test('a selected input reuses its exact backup receipt and records acquisition use separately',async()=>{
  const h=harness(),pixels=source(7),backup=h.capture.submit(pixels,1,1000)!;
  assert.equal(h.capture.input(pixels,1,1000,'input',backup,true),backup);
  h.capture.use(backup,99,'input',1);h.capture.use(backup,120,'recovery',1);
  await h.capture.finish();
  assert.equal(h.frames().length,1);assert.equal(h.copies.length,1);assert.equal(h.capture.stats.frames,1);
  assert.deepEqual(h.uses,[{sourceFrameId:backup,acquisitionFrameId:99,phase:'input',captureTime:1},
    {sourceFrameId:backup,acquisitionFrameId:120,phase:'recovery',captureTime:1}]);
  assert.equal(h.frames()[0].role,'backup');assert.equal(h.frames()[0].canonical,true);
  assert.deepEqual(h.portCounts(),{closed:1,started:1,taken:1});assert.deepEqual(h.reports,[]);
});

test('selected input persistence off stores no extra copy but keeps an existing backup receipt',async()=>{
  const h=harness(),pixels=source(1);
  assert.equal(h.capture.input(pixels,1,1000,'input',undefined,false),undefined);
  h.capture.use(undefined,1,'input',1);assert.equal(h.capture.stats.frames,0);assert.equal(h.copies.length,0);
  const backup=h.capture.submit(pixels,1,1000)!;
  assert.equal(h.capture.input(pixels,1,1000,'input',backup,false),backup);
  await h.capture.finish();assert.equal(h.frames().length,1);assert.deepEqual(h.uses,[]);
});

test('asynchronous bitmap completion keeps source order and capture metadata after the source changes',async()=>{
  const h=harness({manualCopies:true}),pixels=source(3);
  h.capture.submit(pixels,2,2000);h.capture.submit(source(4),1,2100);
  (pixels as unknown as {displayWidth:number;tag:number}).displayWidth=8;pixels.tag=99;
  const finishing=h.capture.finish();h.resolveCopy(1);await turn();assert.equal(h.frames().length,0);
  h.resolveCopy(0);await finishing;
  assert.deepEqual(h.frames().map(value=>[value.id,value.width,value.time,value.bitmap!.tag]),[[1,1,2,3],[2,1,1,4]]);
  assert.deepEqual(h.copies.map(value=>value.closed),[1,1]);
});

test('finish waits for every storage acknowledgement before sending one end marker',async()=>{
  const h=harness({manualAck:true});h.capture.submit(source(1),1,1000);h.capture.submit(source(2),2,2000);
  let settled=false;const finish=h.capture.finish();assert.equal(h.capture.finish(),finish);
  void finish.then(()=>{settled=true;});await turn();
  assert.equal(h.frames().length,2);assert.equal(settled,false);assert.equal(h.capture.stats.pendingBytes,8);
  h.ack(2);await turn();assert.equal(settled,false);h.ack(1);await finish;
  assert.equal(h.requests.filter(value=>value.kind==='end').length,1);assert.equal(h.capture.stats.pendingBytes,0);
  await h.capture.discard();assert.equal(h.portCounts().closed,1);
});

test('original replay is a finite chronological cut while new recovery pixels append',async()=>{
  await imageDataScope(async()=>{
    const h=harness();h.capture.submit(source(3),3,1000);h.capture.submit(source(1),1,1100);
    h.capture.submit(source(8),.5,1200,'recovery');h.capture.submit(source(2),1,1300,'input');
    const iterator=h.capture.frames(new AbortController().signal),first=await iterator.next();
    assert.equal(first.value?.canonicalFrameId,2);assert.equal(first.value?.time,1);
    assert.equal(h.capture.submit(source(9),9,9000),undefined,'ordinary capture closes when original replay starts');
    assert.ok(h.capture.submit(source(0),0,9100,'recovery'));
    const rest:number[]=[];for await(const frame of iterator)rest.push(frame.canonicalFrameId);
    assert.deepEqual(rest,[4,1]);assert.deepEqual(h.reads,[2,4,1]);
    assert.deepEqual(h.raster.map(value=>value.pixel),[1,2,3]);
    assert.equal(h.canvas.width,0);assert.equal(h.canvas.height,0);await h.capture.finish();
  });
});

test('saved acquisition retains its live reference and late observations remain available during replay',async()=>{
  await imageDataScope(async()=>{
    const h=harness(),id=h.capture.submit(source(5),1,1000)!;
    const analysis:SavedAcquisition={width:1,height:1,layout:null,cells:[],observations:[]};
    h.capture.attachAnalysis(id,analysis);
    analysis.observations.push({order:42,frame:'input/1',stable:true});
    for await(const frame of h.capture.frames(new AbortController().signal)){
      assert.equal(frame.analysis,analysis);assert.equal(frame.analysis.observations[0]?.order,42);
    }
    await h.capture.discard();
  });
});

test('recovery-only analyses cannot evict original sidecars before or during their finite read pass',async()=>{
  await imageDataScope(async()=>{
    const h=harness(),analyses:SavedAcquisition[]=[];
    for(let id=1;id<=2;id++){
      const actual=h.capture.submit(source(id),id,id*1000)!;
      const analysis:SavedAcquisition={width:1,height:1,layout:null,cells:[],observations:[{order:id,frame:`input/${id}`,stable:false}]};
      analyses.push(analysis);h.capture.attachAnalysis(actual,analysis);
    }
    const appendRecovery=()=>{
      for(let index=0;index<130;index++){
        const id=h.capture.submit(source(9),.5+index/1000,3000+index,'recovery')!;
        assert.ok(id);h.capture.attachAnalysis(id,{width:1,height:1,layout:null,cells:[],observations:[]});
      }
    };
    appendRecovery();
    const iterator=h.capture.frames(new AbortController().signal),first=await iterator.next();
    assert.equal(first.value?.canonicalFrameId,1);assert.equal(first.value?.analysis,analyses[0]);
    appendRecovery();
    const second=await iterator.next();assert.equal(second.value?.canonicalFrameId,2);assert.equal(second.value?.analysis,analyses[1]);
    assert.equal((await iterator.next()).done,true);await h.capture.finish();
    assert.deepEqual(h.reads,[1,2],'new physical recovery sources stay outside the original cut');
    assert.equal(h.capture.stats.frames,262);assert.equal(h.capture.stats.storedFrames,262);
    assert.deepEqual(h.frames().map(frame=>frame.id),Array.from({length:262},(_,index)=>index+1));
    assert.equal(h.capture.stats.error,'');assert.deepEqual(h.uses,[]);assert.deepEqual(h.receipts,[]);
  });
});

test('the 128-sidecar cap remains and reacquiring a spent backup cannot evict the next original',async()=>{
  await imageDataScope(async()=>{
    const h=harness(),analyses:SavedAcquisition[]=[];
    for(let id=1;id<=129;id++){
      const actual=h.capture.submit(source(id),id,id*1000)!;
      const analysis:SavedAcquisition={width:1,height:1,layout:null,cells:[],observations:[{order:id,frame:`input/${id}`,stable:false}]};
      analyses.push(analysis);h.capture.attachAnalysis(actual,analysis);
    }
    const iterator=h.capture.frames(new AbortController().signal,{
      ready:()=>false,covered:()=>true,skipped:()=>assert.fail('cache lifecycle cannot loosen global completion'),
    }),first=await iterator.next();
    assert.equal(first.value?.canonicalFrameId,1);assert.equal(first.value?.analysis,undefined,'129 originals still evict the oldest at the unchanged cap');
    // Actual recovery collect reattaches newly calculated analysis under this
    // same backup source ID while its original iterator is suspended here.
    h.capture.attachAnalysis(1,{width:1,height:1,layout:null,cells:[],observations:[]});
    const second=await iterator.next();assert.equal(second.value?.canonicalFrameId,2);assert.equal(second.value?.analysis,analyses[1]);
    let count=2;for await(const frame of iterator){assert.equal(frame.analysis,analyses[count]);count++;}
    assert.equal(count,129);assert.deepEqual(h.reads,Array.from({length:129},(_,index)=>index+1));
    await h.capture.finish();assert.equal(h.capture.stats.storedFrames,129);assert.equal(h.capture.stats.error,'');
  });
});

test('an unconsumed original can receive a late analysis while retired yielded observations keep their live references',async()=>{
  await imageDataScope(async()=>{
    const h=harness(),first=h.capture.submit(source(1),1,1000)!,second=h.capture.submit(source(2),2,2000)!;
    const firstAnalysis:SavedAcquisition={width:1,height:1,layout:null,cells:[],observations:[{order:42,frame:'session/source/1',stable:false}]};
    h.capture.attachAnalysis(first,firstAnalysis);
    h.capture.attachAnalysis(second,{width:1,height:1,layout:null,cells:[],observations:[]});
    const iterator=h.capture.frames(new AbortController().signal),yielded=await iterator.next();
    assert.equal(yielded.value?.analysis,firstAnalysis);
    const replacement:SavedAcquisition={width:1,height:1,layout:null,cells:[],observations:[{order:52,frame:'session/source/2',stable:false}]};
    h.capture.attachAnalysis(second,replacement);
    firstAnalysis.observations[0]!.identity={id:'pending',review:['이름 확인']} as NonNullable<SavedAcquisition['observations'][number]>['identity'];
    assert.equal(yielded.value?.analysis?.observations[0],firstAnalysis.observations[0]);
    assert.equal(yielded.value?.analysis?.observations[0]?.order,42);assert.equal(yielded.value?.analysis?.observations[0]?.stable,false);
    assert.deepEqual(yielded.value?.analysis?.observations[0]?.identity?.review,['이름 확인']);
    assert.equal((await iterator.next()).value?.analysis,replacement);assert.equal((await iterator.next()).done,true);
    assert.equal(yielded.value?.analysis,firstAnalysis,'cache cleanup does not mutate an already delivered object');
    await h.capture.finish();assert.equal(h.capture.stats.error,'');
  });
});

test('early original return retires sidecars without cancelling new storage or an already joined measured origin',async()=>{
  await imageDataScope(async()=>{
    const h=harness({manualAck:true}),first=h.capture.reserve({width:1,height:1,time:1,elapsed:1000,role:'input'})!,
      second=h.capture.reserve({width:1,height:1,time:2,elapsed:2000,role:'backup'})!;
    const origin={version:1 as const,kind:'measured' as const,sourceFrameId:first.id,acquisitionFrameId:17,captureTime:1,width:1,height:1,hash:'a'.repeat(64)};
    h.capture.submitPrepared(first.id,{pixels:new ArrayBuffer(4),hash:origin.hash});
    h.capture.submitPrepared(second.id,{pixels:new ArrayBuffer(4),hash:origin.hash});
    h.capture.use(first.id,17,'input',1,origin);h.ack(first.id);h.ack(second.id);
    const analysis:SavedAcquisition={width:1,height:1,layout:null,cells:[],observations:[{order:42,frame:'session/source/1',stable:false}],rasterReceipt:origin};
    h.capture.attachAnalysis(first.id,analysis);h.capture.attachAnalysis(second.id,{width:1,height:1,layout:null,cells:[],observations:[]});
    const iterator=h.capture.frames(new AbortController().signal),yielded=await iterator.next();assert.equal(yielded.value?.analysis,analysis);
    const recovery=h.capture.reserve({width:1,height:1,time:.5,elapsed:3000,role:'recovery'})!;
    h.capture.submitPrepared(recovery.id,{pixels:new ArrayBuffer(4),hash:origin.hash});
    await iterator.return(undefined);h.capture.attachAnalysis(second.id,{width:1,height:1,layout:null,cells:[],observations:[]});
    assert.equal(h.canvas.width,0);assert.equal(h.canvas.height,0);assert.equal(h.capture.stats.pending,1);
    assert.equal(h.capture.stats.error,'');assert.equal(h.capture.canReuseAnalysis(origin),true);
    analysis.observations[0]!.order=43;assert.equal(yielded.value?.analysis?.observations[0]?.order,43);
    const ending=h.capture.finish();h.ack(recovery.id);await ending;
    assert.equal(h.capture.stats.storedFrames,3);assert.equal(h.capture.stats.measuredRasterUses,1);
    assert.deepEqual(h.reads,[first.id]);assert.equal(h.receipts.length,1);assert.equal(h.uses.length,1);
    await assert.rejects(h.capture.frames(new AbortController().signal).next(),/한 번만/);
  });
});

test('only covered originals are skipped and missing analyses still reach the decoder',async()=>{
  await imageDataScope(async()=>{
    const h=harness();for(let id=1;id<=4;id++)h.capture.submit(source(id),id,id*1000);
    const covered={width:1,height:1,layout:null,cells:[],observations:[]} as SavedAcquisition;
    h.capture.attachAnalysis(1,covered);h.capture.attachAnalysis(3,covered);
    const skipped:number[]=[],seen:number[]=[];
    for await(const frame of h.capture.frames(new AbortController().signal,{
      ready:()=>true,covered:value=>value===covered,skipped:count=>skipped.push(count),
    }))seen.push(frame.canonicalFrameId);
    assert.deepEqual(seen,[2,4]);assert.deepEqual(h.reads,[2,4]);assert.deepEqual(skipped,[1,1]);
    await h.capture.finish();
  });
});

test('global readiness must pass before even a covered original can skip disk read',async()=>{
  await imageDataScope(async()=>{
    const h=harness(),id=h.capture.submit(source(1),1,1000)!;
    h.capture.attachAnalysis(id,{width:1,height:1,layout:null,cells:[],observations:[]});
    for await(const _frame of h.capture.frames(new AbortController().signal,{
      ready:()=>false,covered:()=>true,skipped:()=>assert.fail('not globally ready'),
    })){/* consume */}
    assert.deepEqual(h.reads,[1]);await h.capture.finish();
  });
});

test('a mismatching analysis geometry cannot skip or replace the original frame analysis',async()=>{
  await imageDataScope(async()=>{
    const h=harness(),id=h.capture.submit(source(1),1,1000)!;
    h.capture.attachAnalysis(id,{width:2,height:1,layout:null,cells:[],observations:[]});
    const seen:(SavedAcquisition|undefined)[]=[];
    try{
      for await(const frame of h.capture.frames(new AbortController().signal,{
        ready:()=>true,covered:value=>!!value,skipped:()=>assert.fail('wrong geometry cannot prove coverage'),
      }))seen.push(frame.analysis);
      assert.deepEqual(h.reads,[id]);assert.deepEqual(seen,[undefined]);
    }finally{await h.capture.finish();}
  });
});

test('pending-byte overflow cancels unfinished copies, records a gap and releases their eventual bitmaps',async()=>{
  const h=harness({manualCopies:true,byteLimit:4});assert.equal(h.capture.submit(source(1),1,1000),1);
  assert.equal(h.capture.submit(source(2),2,2000),undefined);assert.equal(h.capture.active,false);
  assert.equal(h.capture.stats.pendingBytes,0);assert.equal(h.incomplete.length,1);assert.equal(h.reports.length,1);
  await h.capture.finish();h.resolveCopy(0);await turn();
  assert.equal(h.copies[0].closed,1);assert.equal(h.frames().length,0);assert.equal(h.requests.filter(value=>value.kind==='gap').length,1);
});

test('explicit cancellation settles pending acknowledgements and finish without leaving copied pixels alive',async()=>{
  const h=harness({manualAck:true});h.capture.submit(source(1),1,1000);await turn();
  h.capture.cancel();assert.equal(h.capture.stats.pendingBytes,0);await h.capture.finish();
  assert.equal(h.copies[0].closed,1);assert.equal(h.capture.stats.pending,0);assert.equal(h.reports.length,1);
});

test('later copy failure preserves committed originals without inventing the missing source',async()=>{
  await imageDataScope(async()=>{
    const h=harness({manualCopies:true});
    h.capture.submit(source(7),1,1000);h.resolveCopy(0);await turn();
    h.capture.submit(source(8),2,2000);h.copies[1].reject(Error('later copy failed'));await turn();
    assert.equal(h.capture.active,false);assert.equal(h.capture.stats.storedFrames,1);
    const seen:number[]=[];
    for await(const frame of h.capture.frames(new AbortController().signal))seen.push(frame.canonicalFrameId);
    assert.deepEqual(seen,[1]);assert.deepEqual(h.reads,[1]);assert.deepEqual(h.raster.map(value=>value.pixel),[7]);
    assert.equal(h.requests.filter(value=>value.kind==='drain').length,1);
    assert.match(h.capture.stats.error,/later copy failed/);assert.equal(h.incomplete.length,1);
    await h.capture.finish();
  });
});

test('overflow joins transferred writes and late ACKs before recovering only durable originals',async()=>{
  await imageDataScope(async()=>{
    const h=harness({manualCopies:true,manualAck:true,manualDrain:true,byteLimit:8});
    h.capture.submit(source(3),1,1000);h.resolveCopy(0);await turn();
    h.capture.submit(source(4),2,2000);
    assert.equal(h.capture.submit(source(5),3,3000),undefined);
    const iterator=h.capture.frames(new AbortController().signal);let settled=false;
    const reading=iterator.next().then(value=>{settled=true;return value;});await turn();
    assert.equal(settled,false);assert.deepEqual(h.reads,[]);
    h.ack(1);h.drained();const first=await reading;
    assert.equal(first.value?.canonicalFrameId,1);assert.equal(first.value?.time,1);
    assert.equal((await iterator.next()).done,true);assert.deepEqual(h.reads,[1]);
    h.resolveCopy(1);await turn();assert.equal(h.copies[1].closed,1);
    assert.equal(h.capture.stats.storedFrames,1);assert.equal(h.capture.stats.pendingBytes,0);
    assert.equal(h.reports.length,1);await h.capture.finish();
  });
});

test('a failed source drain stays abortable and cannot make pending originals readable',async()=>{
  const h=harness({manualCopies:true,manualDrain:true,byteLimit:4}),controller=new AbortController();
  h.capture.submit(source(1),1,1000);h.capture.submit(source(2),2,2000);
  const reading=h.capture.frames(controller.signal).next(),rejected=assert.rejects(reading,/stop drain/);
  await turn();controller.abort(Error('stop drain'));await rejected;
  h.drained();h.resolveCopy(0);await h.capture.finish();assert.deepEqual(h.reads,[]);
});

test('bitmap rejection and source errors terminate only the canonical producer and keep cleanup available',async()=>{
  const copy=harness({manualCopies:true});copy.capture.submit(source(1),1,1000);copy.copies[0].reject(Error('decode'));
  await turn();await copy.capture.finish();assert.equal(copy.capture.stats.pending,0);assert.match(copy.capture.stats.error,/decode/);
  const worker=harness({manualAck:true});worker.capture.submit(source(2),2,2000);await turn();worker.sourceError('quota');
  await worker.capture.finish();assert.match(worker.capture.stats.error,/quota/);assert.equal(worker.capture.stats.pendingBytes,0);
});

test('an unknown storage acknowledgement fails explicitly rather than confirming another source',async()=>{
  const h=harness({manualAck:true});h.capture.submit(source(1),1,1000);await turn();h.ack(999);await h.capture.finish();
  assert.equal(h.reports.length,1);assert.match(h.capture.stats.error,/응답 불일치/);assert.equal(h.capture.stats.pending,0);
});

test('receipt IDs, capture times and acquisition IDs must agree before reuse or use reporting',async()=>{
  const h=harness(),pixels=source(1),id=h.capture.submit(pixels,1,1000)!;
  assert.throws(()=>h.capture.input(pixels,1,1000,'input',999,true),/근거 불일치/);
  assert.throws(()=>h.capture.input(pixels,2,1000,'input',id,true),/근거 불일치/);
  assert.throws(()=>h.capture.use(id,0,'input',1),/근거 불일치/);
  assert.throws(()=>h.capture.use(id,7,'input',2),/근거 불일치/);
  assert.deepEqual(h.uses,[]);await h.capture.finish();
});

test('nonfinite receipt time and mismatching source dimensions cannot masquerade as the saved pixels',async()=>{
  const h=harness(),pixels=source(1),id=h.capture.submit(pixels,1,1000)!;
  try{
    for(const time of [NaN,Infinity,-Infinity]){
      assert.throws(()=>h.capture.input(pixels,time,1000,'input',id,true),/근거 불일치|시각|source|time/i);
      assert.throws(()=>h.capture.use(id,7,'input',time),/근거 불일치|시각|source|time/i);
    }
    assert.throws(()=>h.capture.input(source(2,2),1,1000,'input',id,true),/근거 불일치|크기|source/i);
  }finally{await h.capture.finish();}
});

test('an aborted original iterator does not wait for an unresolved bitmap copy',async()=>{
  const h=harness({manualCopies:true}),controller=new AbortController();h.capture.submit(source(1),1,1000);
  let settled=false;const reading=h.capture.frames(controller.signal).next();
  const handled=reading.then(()=>{settled=true;},()=>{settled=true;});controller.abort(new DOMException('test abort','AbortError'));
  try{await turn();await turn();assert.equal(settled,true,'abort should settle before an unrelated copy resolves');}
  finally{h.capture.cancel();h.resolveCopy(0);await handled;await h.capture.finish();}
  assert.equal(h.copies[0].closed,1);assert.equal(h.capture.stats.pendingBytes,0);
});

test('a cancelled disk read settles the iterator and clears its reusable canvas',async()=>{
  await imageDataScope(async()=>{
    const h=harness({read:(_id,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
    h.capture.submit(source(1),1,1000);const controller=new AbortController(),iterator=h.capture.frames(controller.signal);
    const reading=iterator.next(),handled=assert.rejects(reading,/test abort/);await turn();controller.abort(Error('test abort'));
    await handled;assert.equal(h.canvas.width,0);assert.equal(h.canvas.height,0);await h.capture.finish();
  });
});

test('raw frame identity, dimensions, timestamp and pixel count are revalidated on read',async()=>{
  await imageDataScope(async()=>{
    const valid={id:1,width:1,height:1,time:1,pixels:new Uint8ClampedArray(4)};
    for(const invalid of [{...valid,id:2},{...valid,width:2},{...valid,time:2},{...valid,pixels:new Uint8ClampedArray(3)}]){
      const h=harness({read:async()=>invalid});h.capture.submit(source(1),1,1000);
      await assert.rejects(h.capture.frames(new AbortController().signal).next(),/불일치/);
      assert.equal(h.canvas.width,0);assert.equal(h.canvas.height,0);await h.capture.finish();
    }
  });
});

const nativeDescriptor:NativeYuvFrameMetadata={format:'I420',codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,
  visibleRect:{x:0,y:0,width:2,height:2},rotation:0,flip:false,
  colorSpace:{primaries:'smpte170m',transfer:'smpte170m',matrix:'smpte170m',fullRange:false}};
const measuredReceipt=(sourceFrameId:number,acquisitionFrameId=17)=>({version:1 as const,kind:'measured' as const,
  sourceFrameId,acquisitionFrameId,captureTime:1,width:1,height:1,hash:'a'.repeat(64)});
const reusedReceipt=(sourceFrameId:number,acquisitionFrameId=18,originAcquisitionFrameId=17)=>({
  ...measuredReceipt(sourceFrameId,acquisitionFrameId),kind:'analysis-reused' as const,originAcquisitionFrameId});

const storageIdentity={version:1 as const,sessionId:'session',producerId:'preparation'};
function storageTuple(ticketId:string):PreparedNativeAttestation{return {
 version:1,kind:'prepared-native-conversion',sessionId:'session',producerId:'preparation',requestId:1,sourceFrameId:1,captureTime:1,
 width:2,height:2,nativeByteLength:6,rgbaByteLength:16,descriptorSha256:'b'.repeat(64),nativeSha256:'c'.repeat(64),
 recipeId:planNativeYuvFrame(nativeDescriptor).recipe.id,recipeSha256:'d'.repeat(64),generatedRgbaSha256:'a'.repeat(64),ticketId,
};}

test('attested ACK joins only its requested physical source and does not replace actual acquisition evidence',async()=>{
 const h=harness({manualAck:true,ownedRgba:true,attestation:storageIdentity}),ticketId=crypto.randomUUID(),tuple=storageTuple(ticketId);
 const record=h.capture.reserve({width:2,height:2,time:1,elapsed:1})!;
 h.capture.submitPrepared(record.id,{native:{descriptor:nativeDescriptor,pixels:new Uint8Array(6),ticketId},hash:'a'.repeat(64)});
 const measured={...measuredReceipt(1),width:2,height:2};h.capture.use(1,17,'input',1,measured);
 assert.deepEqual(h.receipts,[]);assert.deepEqual(h.attestations,[]);
 h.ack(1,{kind:'stored-attested',attestation:tuple});
 const stored=await h.capture.stored(1);assert.deepEqual(stored.attestation,tuple);
 assert.deepEqual(h.attestations,[tuple]);assert.deepEqual(h.receipts,[measured]);
 assert.equal(h.capture.stats.measuredRasterUses,1);assert.equal(h.capture.stats.unverifiedRasterUses,0);await h.capture.finish();
});

for(const fault of ['plain-ack','ticket','session','producer','source','time','size','hash'] as const)test(`attested physical source rejects wrong ${fault} ACK`,async()=>{
 const h=harness({manualAck:true,attestation:storageIdentity}),ticketId=crypto.randomUUID();
 const record=h.capture.reserve({width:2,height:2,time:1,elapsed:1})!;
 h.capture.submitPrepared(record.id,{native:{descriptor:nativeDescriptor,pixels:new Uint8Array(6),ticketId},hash:'a'.repeat(64)});
 const tuple:any={...storageTuple(ticketId)};
 if(fault==='ticket')tuple.ticketId=crypto.randomUUID();if(fault==='session')tuple.sessionId='other';if(fault==='producer')tuple.producerId='other';
 if(fault==='source')tuple.sourceFrameId=2;if(fault==='time')tuple.captureTime=2;if(fault==='size'){tuple.width=4;tuple.nativeByteLength=12;tuple.rgbaByteLength=32;}
 if(fault==='hash')tuple.generatedRgbaSha256='e'.repeat(64);
 h.ack(1,fault==='plain-ack'?{}:{kind:'stored-attested',attestation:tuple});
 await assert.rejects(h.capture.stored(1),/변환 증명/);assert.equal(h.capture.stats.storedFrames,0);assert.deepEqual(h.attestations,[]);await h.capture.finish();
});

test('unrequested attested ACK cannot authorize an ordinary native source',async()=>{
 const h=harness({manualAck:true}),ticketId=crypto.randomUUID();
 const record=h.capture.reserve({width:2,height:2,time:1,elapsed:1})!;
 h.capture.submitPrepared(record.id,{native:{descriptor:nativeDescriptor,pixels:new Uint8Array(6)},hash:'a'.repeat(64)});
 h.ack(1,{kind:'stored-attested',attestation:storageTuple(ticketId)});
 await assert.rejects(h.capture.stored(1),/요청하지 않은/);assert.equal(h.capture.stats.storedFrames,0);await h.capture.finish();
});

test('prepared native ticket policy is fixed at capture construction while RGBA fallback stays independent',async()=>{
 const required=harness({manualAck:true,attestation:storageIdentity});
 const record=required.capture.reserve({width:2,height:2,time:1,elapsed:1})!;
 assert.throws(()=>required.capture.submitPrepared(record.id,{native:{descriptor:nativeDescriptor,pixels:new Uint8Array(6)},hash:'a'.repeat(64)}),/증명 요청 불일치/);
 await required.capture.finish();
 const ordinary=harness({manualAck:true}),row=ordinary.capture.reserve({width:2,height:2,time:1,elapsed:1})!;
 assert.throws(()=>ordinary.capture.submitPrepared(row.id,{native:{descriptor:nativeDescriptor,pixels:new Uint8Array(6),ticketId:crypto.randomUUID()},hash:'a'.repeat(64)}),/증명 요청 불일치/);
 await ordinary.capture.finish();
 const fallback=harness({attestation:storageIdentity}),raw=fallback.capture.reserve({width:1,height:1,time:1,elapsed:1})!;
 fallback.capture.submitPrepared(raw.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
 assert.equal((await fallback.capture.stored(1)).attestation,undefined);assert.deepEqual(fallback.attestations,[]);await fallback.capture.finish();
});

test('attested native ownership returns unused RGBA credits before ACK without raising the source byte limit',async()=>{
 const h=harness({manualAck:true,attestation:storageIdentity,byteLimit:144}),tickets:string[]=[];
 const first=h.capture.reserve({width:2,height:2,time:1,elapsed:1},32)!;
 const submit=(id:number)=>{const ticketId=crypto.randomUUID();tickets[id]=ticketId;
  h.capture.submitPrepared(id,{native:{descriptor:nativeDescriptor,pixels:new Uint8Array(6),ticketId},hash:'a'.repeat(64)});};
 submit(first.id);assert.equal(h.capture.stats.pendingBytes,6);assert.equal(h.capture.stats.rebatedPreparedBytes,26);
 // Same structure as the real failure: one transferred source and three
 // unprepared originals. Its native-only store lease no longer charges RGBA.
 const queued=[2,3,4].map(()=>h.capture.reserve({width:2,height:2,time:1,elapsed:1},32)!);
 assert.equal(h.capture.stats.pendingBytes,102);
 const next=h.capture.reserve({width:2,height:2,time:1,elapsed:1},32)!;
 assert.equal(next.id,5);assert.equal(h.capture.stats.pendingBytes,134);assert.equal(h.capture.stats.error,'');
 for(const record of [...queued,next])submit(record.id);
 assert.equal(h.capture.stats.pendingBytes,30);assert.equal(h.capture.stats.rebatedPreparedBytes,130);
 assert.equal(h.capture.stats.nativeAttestationBudget,'native-owned-v1');assert.ok(h.capture.stats.peakPendingBytes<=144);
 for(let id=1;id<=5;id++)h.ack(id,{kind:'stored-attested',attestation:{...storageTuple(tickets[id]),sourceFrameId:id,requestId:id}});
 await h.capture.finish();assert.equal(h.capture.stats.pendingBytes,0);assert.equal(h.capture.stats.storedFrames,5);
 const independent=harness({manualAck:true}),row=independent.capture.reserve({width:2,height:2,time:1,elapsed:1},32)!;
 independent.capture.submitPrepared(row.id,{native:{descriptor:nativeDescriptor,pixels:new Uint8Array(6)},hash:'a'.repeat(64)});
 assert.equal(independent.capture.stats.pendingBytes,32,'independent native conversion retains its prior RGBA budget');independent.ack(1);await independent.capture.finish();
 const limited=harness({byteLimit:144,attestation:storageIdentity});
 assert.equal(limited.capture.reserve({width:2,height:2,time:1,elapsed:1},145),undefined);assert.match(limited.capture.stats.error,/용량 한도/);await limited.capture.finish();
});

test('prepared sources reserve immutable IDs before async work and share one mixed ordered dispatch',async()=>{
  const h=harness({manualCopies:true,manualAck:true});
  h.capture.submit(source(1),1,1000);
  const input={width:2,height:2,time:2,elapsed:2000,role:'input' as const},native=h.capture.reserve(input,22)!;
  input.time=99;input.width=99;
  h.capture.submit(source(3),3,3000);
  const raw=h.capture.reserve({width:1,height:1,time:4,elapsed:4000})!;
  const rawBytes=new Uint8Array([4,4,4,255]);
  h.capture.submitPrepared(raw.id,{pixels:rawBytes.buffer,hash:'a'.repeat(64)});
  assert.equal(rawBytes.byteLength,0,'queued raw bytes are exclusively owned immediately');
  h.resolveCopy(1);await turn();assert.deepEqual(h.frames(),[]);
  const nativeBytes=new Uint8Array([16,16,16,16,128,128]);
  h.capture.submitPrepared(native.id,{native:{descriptor:nativeDescriptor,pixels:nativeBytes},hash:'a'.repeat(64)});
  assert.equal(nativeBytes.byteLength,0,'native bytes transfer before earlier preparation resolves');
  assert.equal(Object.isFrozen(native),true);assert.equal(native.time,2);assert.equal(native.width,2);
  const finishing=h.capture.finish();h.resolveCopy(0);await turn();
  assert.deepEqual(h.frames().map(frame=>[frame.id,frame.time,frame.width]),[[1,1,1],[2,2,2],[3,3,1],[4,4,1]]);
  assert.equal(h.frames()[1].native?.pixels.length,6);assert.equal(h.frames()[3].pixels?.byteLength,4);
  assert.equal(h.capture.stats.peakPendingBytes,38);
  for(const id of [4,2,1,3])h.ack(id);
  await finishing;assert.equal((await h.capture.stored(2)).time,2);assert.equal(h.capture.stats.pendingBytes,0);
});

test('finish closes admission synchronously but joins already reserved preparations and storage',async()=>{
  const h=harness({manualAck:true}),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
  let finished=false;const finishing=h.capture.finish().then(()=>{finished=true;});
  assert.equal(h.capture.reserve({width:1,height:1,time:2,elapsed:2000}),undefined);
  await turn();assert.equal(finished,false);assert.equal(h.requests.some(value=>value.kind==='end'),false);
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});await turn();
  assert.equal(finished,false);h.ack(record.id);await finishing;
  assert.equal(h.requests.at(-1)?.kind,'end');
});

test('canceling an unresolved source releases queued mixed payloads and rejects stored waiters',async()=>{
  const h=harness({manualCopies:true}),first=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
  h.capture.submit(source(2),2,2000);h.resolveCopy(0);await turn();
  const third=h.capture.reserve({width:1,height:1,time:3,elapsed:3000})!,raw=new ArrayBuffer(4);
  h.capture.submitPrepared(third.id,{pixels:raw,hash:'a'.repeat(64)});
  const rejected=assert.rejects(h.capture.stored(first.id),/prepare failure/);
  h.capture.rejectReserved(first.id,Error('prepare failure'));await rejected;await h.capture.finish();
  assert.equal(h.copies[0].closed,1);assert.equal(raw.byteLength,0);assert.equal(h.frames().length,0);
  assert.equal(h.capture.stats.pendingBytes,0);assert.equal(h.requests.filter(value=>value.kind==='gap').length,1);
});

test('prepared ACK metadata and generated hash must match before a source becomes committed',async()=>{
  for(const override of [{width:2},{height:2},{time:2},{hash:'b'.repeat(64)},{hash:'bad'}]){
    const h=harness({manualAck:true}),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
    h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
    const rejected=assert.rejects(h.capture.stored(record.id),/픽셀 근거 불일치/);
    h.ack(record.id,override);await rejected;await h.capture.finish();
    assert.equal(h.capture.stats.storedFrames,0);assert.equal(h.receipts.length,0);
  }
});

test('actual acquisition receipt waits only for matching stored ACK and is immutable with exact fields',async()=>{
  const h=harness({manualAck:true}),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
  const receipt=measuredReceipt(record.id);
  h.capture.use(record.id,17,'input',1,receipt);receipt.hash='b'.repeat(64);
  assert.equal(h.uses.length,1,'processing feedback does not wait for disk');assert.equal(h.receipts.length,0);
  assert.equal(h.capture.stats.pendingRasterUses,1);
  h.ack(record.id);assert.deepEqual(h.receipts,[measuredReceipt(record.id)]);
  assert.equal(Object.isFrozen(h.receipts[0]),true);assert.equal(h.capture.stats.measuredRasterUses,1);
  assert.equal(h.capture.stats.pendingRasterUses,0);await h.capture.finish();
});

test('a measured use after commit joins immediately and duplicate acquisition measurements are rejected',async()=>{
  const h=harness(),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});await h.capture.stored(record.id);
  h.capture.use(record.id,17,'recovery',1,measuredReceipt(record.id));assert.equal(h.receipts.length,1);
  assert.throws(()=>h.capture.use(record.id,17,'recovery',1,measuredReceipt(record.id)),/중복/);
  await h.capture.finish();
});

test('measurement hash mismatch keeps card use separate but makes reproduction partial',async()=>{
  const h=harness(),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});await h.capture.stored(record.id);
  h.capture.use(record.id,17,'input',1,{...measuredReceipt(record.id),hash:'b'.repeat(64)});
  assert.match(h.capture.stats.error,/해시 불일치/);assert.equal(h.receipts.length,0);assert.equal(h.uses.length,1);
  assert.equal(h.capture.stats.storedFrames,1);await h.capture.finish();
});

test('malformed or mismatched measurement is rejected before reporting a processing use',async()=>{
  const h=harness(),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
  for(const extra of [{sourceFrameId:2},{acquisitionFrameId:18},{captureTime:2},{width:2},{hash:'bad'},{extra:true}])
    assert.throws(()=>h.capture.use(record.id,17,'input',1,{...measuredReceipt(record.id),...extra}));
  assert.equal(h.uses.length,0);assert.equal(h.receipts.length,0);await h.capture.finish();
});

test('prepared raw/native protocol validates exact owned buffer sizes and budget before dispatch',async()=>{
  assert.throws(()=>harness({byteLimit:128*1024*1024+1}),/Invalid canonical source budget/);
  const h=harness(),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000},4)!;
  assert.throws(()=>h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)}),/예약 바이트 부족/);
  assert.equal(h.frames().length,0);await h.capture.finish();
  const badNative=harness(),native=badNative.capture.reserve({width:2,height:2,time:1,elapsed:1000})!;
  const subarray=new Uint8Array(8).subarray(2);
  assert.throws(()=>badNative.capture.submitPrepared(native.id,{native:{descriptor:nativeDescriptor,pixels:subarray},hash:'a'.repeat(64)}),/native 원본 크기/);
  await badNative.capture.finish();assert.equal(badNative.frames().length,0);
});

test('owned recovery returns independent restored full bytes with a source hash and stable canvas copy',async()=>{
  await imageDataScope(async()=>{
    const h=harness({ownedRgba:true});h.capture.submit(source(7),1,1000);h.capture.submit(source(8),2,2000);
    const iterator=h.capture.frames(new AbortController().signal),first=await iterator.next();
    assert.equal(first.value?.sourceHash,'a'.repeat(64));assert.deepEqual(Array.from(first.value!.rgba!),[7,7,7,7]);
    const transferred=structuredClone(first.value!.rgba!,{transfer:[first.value!.rgba!.buffer]});
    assert.equal(first.value!.rgba!.byteLength,0);
    const second=await iterator.next();assert.deepEqual(Array.from(second.value!.rgba!),[8,8,8,8]);
    assert.deepEqual(Array.from(transferred),[7,7,7,7]);assert.deepEqual(h.raster.map(value=>value.pixel),[7,8]);
    await iterator.next();await h.capture.finish();
  });
});

test('exact source analysis reuse names a joined actual measurement without inventing another measurement',async()=>{
  const h=harness(),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});await h.capture.stored(record.id);
  h.capture.use(record.id,17,'input',1,measuredReceipt(record.id));
  const receipt=reusedReceipt(record.id);
  h.capture.use(record.id,18,'recovery',1,receipt);receipt.originAcquisitionFrameId=99;
  assert.deepEqual(h.receipts,[measuredReceipt(record.id),reusedReceipt(record.id)]);
  assert.equal(Object.isFrozen(h.receipts[1]),true);
  assert.equal(h.capture.stats.measuredRasterUses,1);assert.equal(h.capture.stats.reusedRasterUses,1);
  assert.equal(h.capture.stats.pendingRasterUses,0);assert.equal(h.capture.stats.processingUses,2);
  await h.capture.finish();
});

test('reuse waits for its origin measured ACK to join, and late ACK cannot manufacture a prior valid reuse',async()=>{
  const h=harness({manualAck:true}),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
  h.capture.use(record.id,17,'input',1,measuredReceipt(record.id));
  assert.throws(()=>h.capture.use(record.id,18,'recovery',1,reusedReceipt(record.id)),/재사용 판독 원본/);
  assert.equal(h.uses.length,1);assert.equal(h.receipts.length,0);assert.equal(h.capture.stats.reusedRasterUses,0);
  h.ack(record.id);assert.equal(h.receipts.length,1);
  h.capture.use(record.id,18,'recovery',1,reusedReceipt(record.id));
  assert.equal(h.receipts.length,2);assert.equal(h.capture.stats.measuredRasterUses,1);assert.equal(h.capture.stats.reusedRasterUses,1);
  await h.capture.finish();
});

test('cached analysis eligibility requires its exact committed measurement rather than just an attached raster receipt',async()=>{
  const h=harness({manualAck:true}),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!,receipt=measuredReceipt(record.id);
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:receipt.hash});
  assert.equal(h.capture.canReuseAnalysis(receipt),false,'physical reservation alone is not a measurement');
  h.capture.use(record.id,17,'input',1,receipt);assert.equal(h.capture.canReuseAnalysis(receipt),false,'actual acquisition still awaits stored ACK');
  h.ack(record.id);assert.equal(h.capture.canReuseAnalysis(receipt),true);
  for(const extra of [{sourceFrameId:2},{acquisitionFrameId:18},{captureTime:2},{width:2},{height:2},{hash:'b'.repeat(64)},{extra:true}])
    assert.equal(h.capture.canReuseAnalysis({...receipt,...extra}),false);
  for(const malformed of [undefined,null,{},reusedReceipt(record.id)])assert.equal(h.capture.canReuseAnalysis(malformed),false);
  assert.equal(h.capture.stats.processingUses,1);assert.equal(h.capture.stats.measuredRasterUses,1);await h.capture.finish();
});

test('late prefix ACK after recording failure cannot enable a lost measurement cache and actual reacquisition remains valid',async()=>{
  const h=harness({manualAck:true}),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!,receipt=measuredReceipt(record.id);
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:receipt.hash});h.capture.use(record.id,17,'input',1,receipt);
  h.sourceError('writer capacity exceeded before ACK');h.ack(record.id);
  assert.equal((await h.capture.stored(record.id)).hash,receipt.hash,'late ACK preserves the readable physical prefix');
  assert.equal(h.capture.canReuseAnalysis(receipt),false,'the failed join was never a committed measurement');
  assert.throws(()=>h.capture.use(record.id,18,'recovery',1,reusedReceipt(record.id)),/재사용 판독 원본/);
  assert.doesNotThrow(()=>h.capture.use(record.id,18,'recovery',1,measuredReceipt(record.id,18)));
  assert.equal(h.capture.stats.processingUses,2);assert.equal(h.capture.stats.measuredRasterUses,0);assert.equal(h.capture.stats.reusedRasterUses,0);
  assert.equal(h.capture.stats.unverifiedRasterUses,2);assert.equal(h.capture.stats.pendingRasterUses,0);await h.capture.finish();
});

test('a joined prefix measurement remains eligible after later storage failure without relabelling a later use as measured',async()=>{
  const h=harness(),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!,receipt=measuredReceipt(record.id);
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:receipt.hash});await h.capture.stored(record.id);h.capture.use(record.id,17,'input',1,receipt);
  h.sourceError('later source failed');assert.equal(h.capture.canReuseAnalysis(receipt),true);
  h.capture.use(record.id,18,'recovery',1,reusedReceipt(record.id));assert.equal(h.capture.stats.measuredRasterUses,1);
  assert.equal(h.capture.stats.reusedRasterUses,0,'failed recording cannot publish a new joined proof');assert.equal(h.capture.stats.unverifiedRasterUses,1);
  await h.capture.finish();
});

test('same pixels and capture time from another physical source cannot supply a reuse origin',async()=>{
  const h=harness();
  const first=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!,second=h.capture.reserve({width:1,height:1,time:1,elapsed:1001})!;
  for(const record of [first,second])h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});
  await Promise.all([h.capture.stored(first.id),h.capture.stored(second.id)]);
  h.capture.use(first.id,17,'input',1,measuredReceipt(first.id));
  assert.throws(()=>h.capture.use(second.id,18,'recovery',1,reusedReceipt(second.id)),/재사용 판독 원본/);
  assert.equal(h.capture.stats.reusedRasterUses,0);assert.equal(h.uses.length,1);await h.capture.finish();
});

test('wrong, self, future and reused origins cannot be relabeled as actual measured source proof',async()=>{
  const h=harness(),record=h.capture.reserve({width:1,height:1,time:1,elapsed:1000})!;
  h.capture.submitPrepared(record.id,{pixels:new ArrayBuffer(4),hash:'a'.repeat(64)});await h.capture.stored(record.id);
  h.capture.use(record.id,17,'input',1,measuredReceipt(record.id));
  for(const receipt of [reusedReceipt(record.id,18,999),reusedReceipt(record.id,18,18),reusedReceipt(record.id,16,17),
    {...reusedReceipt(record.id),hash:'b'.repeat(64)}])
    assert.throws(()=>h.capture.use(record.id,receipt.acquisitionFrameId,'recovery',1,receipt));
  h.capture.use(record.id,18,'recovery',1,reusedReceipt(record.id));
  assert.throws(()=>h.capture.use(record.id,19,'recovery',1,reusedReceipt(record.id,19,18)),/재사용 판독 원본/);
  assert.throws(()=>h.capture.use(record.id,18,'recovery',1,reusedReceipt(record.id)),/중복/);
  assert.equal(h.capture.stats.measuredRasterUses,1);assert.equal(h.capture.stats.reusedRasterUses,1);await h.capture.finish();
});
