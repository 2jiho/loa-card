import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createExactRecording} from '../src/features/card-scanner/exact-recording';

test('compact recording format is explicit and requires matching worker acknowledgement',async()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');let worker:any;
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:class{
  onmessage:any;onerror:any;messages:any[]=[];terminated=false;
  constructor(){worker=this;}
  postMessage(m:any){this.messages.push(m);
   if(m.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready',supportsSourceReads:true,storageVersion:1}}));
   if(m.kind==='finish')queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(),stats:{frames:1,events:0,dropped:0,
    bytes:0,complete:true,error:'',canonical:true,storageVersion:1,nativeFrames:1,rgbaFrames:0}}}));
   if(m.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
  }terminate(){this.terminated=true;}
 }});
 try{
  await assert.rejects(createExactRecording({storageVersion:2} as never),/형식/);
  await assert.rejects(createExactRecording([] as never),/형식/);
  const recorder=await createExactRecording({storageVersion:1});
  assert.equal(worker.messages[0].storageVersion,1);assert.equal(recorder.supportsSourceReads,true);
  const result=await recorder.finish();assert.equal(result.stats.storageVersion,1);assert.equal(result.stats.complete,true);
  await result.dispose();assert.equal(worker.terminated,true);
  await assert.rejects(createExactRecording(),/응답 불일치/);
  assert.equal(worker.terminated,true,'unexpected compact worker cannot remain alive for a legacy client');
 }finally{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
});
test('recorder has bounded event batches and marks overflow as incomplete',async()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');let worker:any;
 class FakeWorker{
  onmessage:any;onerror:any;messages:any[]=[];terminated=false;
  constructor(){worker=this;}
  postMessage(m:any){this.messages.push(m);if(m.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready'}}));
   if(m.kind==='finish')queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(),stats:{frames:1,events:0,dropped:0,bytes:0,complete:true,error:''}}}));
   if(m.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
  }
  terminate(){this.terminated=true;}
 }
 Object.defineProperty(globalThis,'Worker',{value:FakeWorker,configurable:true});
 try{
  const recorder=await createExactRecording();
  assert.equal(recorder.finishedStats,undefined);
  for(let i=0;i<12;i++)recorder.event('large','x'.repeat(200000),i);
  assert.equal(worker.messages.filter((m:any)=>m.kind==='events').length,4);
  const waiting=recorder.eventQueueStats;
  assert.equal(waiting.acceptedEvents,6);assert.equal(waiting.postedBatches,4);assert.equal(waiting.acknowledgedBatches,0);
  assert.equal(waiting.firstFailure?.reason,'pending-byte-limit');assert.equal(waiting.firstFailure?.seq,7);
  assert.equal(waiting.firstFailure?.eventType,'large');assert.equal(waiting.firstFailure?.pendingEvents,2);
  assert.equal(waiting.firstFailure?.inFlightBatches,4);assert.ok(waiting.firstFailure!.estimatedBytes!>400_000);
  assert.ok(Object.isFrozen(waiting));assert.ok(Object.isFrozen(waiting.firstFailure));
  // Complete the outstanding writes. Overflow must still survive the final response.
  for(let i=0;i<5;i++)worker.onmessage({data:{kind:'events-written'}});
  const result=await recorder.finish();assert.equal(result.stats.complete,false);assert.match(result.stats.error,/한도/);
  assert.equal(result.stats.eventQueue?.postedBatches,5);assert.equal(result.stats.eventQueue?.acknowledgedBatches,5);
  assert.equal(result.stats.eventQueue?.pendingEvents,0);assert.equal(result.stats.eventQueue?.inFlightBatches,0);
  assert.deepEqual(result.stats.eventQueue?.firstFailure,waiting.firstFailure,'first rejection is not overwritten by later drain/ACKs');
  assert.deepEqual(recorder.finishedStats,result.stats);assert.equal(Object.isFrozen(recorder.finishedStats),true);
  await result.dispose();assert.equal(worker.terminated,true);
  assert.equal(recorder.finishedStats?.frames,1,'producer telemetry survives disposal without retaining input pixels');
 }finally{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
});

async function eventQueueClient(run:(recorder:Awaited<ReturnType<typeof createExactRecording>>,worker:any)=>Promise<void>,autoAck=false){
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker'),workers:any[]=[];let recorder:Awaited<ReturnType<typeof createExactRecording>>|undefined;
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:class{
  onmessage:any;onerror:any;messages:any[]=[];
  constructor(){workers.push(this);}
  postMessage(message:any){this.messages.push(message);
   if(message.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready'}}));
   if(message.kind==='events'&&autoAck)queueMicrotask(()=>this.onmessage({data:{kind:'events-written'}}));
   if(message.kind==='finish')queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(['retained']),
    stats:{frames:1,events:0,dropped:0,bytes:8,complete:true,error:''}}}));
   if(message.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
  }terminate(){}
 }});
 try{recorder=await createExactRecording();await run(recorder,workers[0]);}
 finally{await recorder?.dispose();if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
}

test('a single oversized event is distinguished from an aggregate backlog without retaining its value',async()=>{
 await eventQueueClient(async(recorder,worker)=>{
  const type='long-event-type-'.repeat(30),secret='private-payload-'.repeat(40_000);
  recorder.event(type,secret,4);
  const queue=recorder.eventQueueStats;
  assert.equal(queue.acceptedEvents,0);assert.equal(queue.postedBatches,0);assert.equal(queue.peakPendingBytes,0);
  assert.equal(queue.firstFailure?.reason,'pending-byte-limit');assert.equal(queue.firstFailure?.seq,1);
  assert.equal(queue.firstFailure?.pendingBytes,0);assert.equal(queue.firstFailure?.pendingEvents,0);
  assert.equal(queue.firstFailure?.inFlightBatches,0);assert.equal(queue.firstFailure?.eventType,type.slice(0,128));
  assert.ok(queue.firstFailure!.estimatedBytes!>1024*1024);assert.ok(!JSON.stringify(queue).includes('private-payload'));
  assert.equal(worker.messages.some((message:any)=>message.kind==='events'),false);
  const raw=await recorder.finish();assert.equal(raw.stats.complete,false);assert.deepEqual(raw.stats.eventQueue?.firstFailure,queue.firstFailure);
 });
});

test('explicit event write failure seals a partial prefix without pretending ACKs or waiting for impossible ones',async()=>{
 await eventQueueClient(async(recorder,worker)=>{
  for(let i=0;i<4;i++)recorder.event('batch','x'.repeat(40_000),i);
  recorder.event('pending',{small:true},5);
  assert.equal(recorder.eventQueueStats.inFlightBatches,4);assert.equal(recorder.eventQueueStats.pendingEvents,1);
  worker.onmessage({data:{kind:'events-error',error:'event append refused'}});
  const failed=recorder.eventQueueStats;
  assert.equal(failed.firstFailure?.reason,'worker-write');assert.equal(failed.firstFailure?.pendingEvents,1);
  assert.equal(failed.firstFailure?.inFlightBatches,4);assert.match(failed.firstFailure!.error!,/append refused/);
  assert.equal(failed.pendingEvents,0);assert.equal(failed.inFlightBatches,0);assert.equal(failed.acknowledgedBatches,0);
  recorder.event('after-failure','not accepted',6);assert.equal(recorder.eventQueueStats.acceptedEvents,5);
  worker.onmessage({data:{kind:'events-written'}});assert.equal(recorder.eventQueueStats.acknowledgedBatches,0,'unsolicited late ACK is not counted as a persisted batch');
  const ending=recorder.finish();assert.equal(worker.messages.at(-1).kind,'finish','failed window must not enter the 10-second ACK wait');
  const raw=await ending;assert.equal(await raw.blob.text(),'retained');assert.equal(raw.stats.complete,false);assert.match(raw.stats.error,/append refused/);
  assert.deepEqual(raw.stats.eventQueue?.firstFailure,failed.firstFailure);
 });
});

test('serialization failure keeps the preceding accepted prefix and never retains the malformed event body',async()=>{
 await eventQueueClient(async(recorder,worker)=>{
  recorder.event('valid',{ok:true},1);
  const cycle:any={secret:'not-a-telemetry-field'};cycle.self=cycle;
  assert.doesNotThrow(()=>recorder.event('cyclic',cycle,2));recorder.event('ignored',{},3);
  const queue=recorder.eventQueueStats;
  assert.equal(queue.acceptedEvents,1);assert.equal(queue.firstFailure?.reason,'serialization');assert.equal(queue.firstFailure?.seq,2);
  assert.equal(queue.firstFailure?.estimatedBytes,null);assert.ok(!JSON.stringify(queue).includes('not-a-telemetry-field'));
  const raw=await recorder.finish();assert.equal(raw.stats.complete,false);assert.match(raw.stats.error,/직렬화/);
  const batches=worker.messages.filter((message:any)=>message.kind==='events');
  assert.equal(batches.length,1);assert.deepEqual(batches[0].events.map((entry:any)=>entry.type),['valid']);
 },true);
});

test('a synchronous event transport failure is partial and does not throw into card processing',async()=>{
 await eventQueueClient(async(recorder,worker)=>{
  const send=worker.postMessage.bind(worker);
  worker.postMessage=(message:any)=>{if(message.kind==='events')throw new DOMException('cannot clone event','DataCloneError');send(message);};
  assert.doesNotThrow(()=>recorder.event('clone-rejected','x'.repeat(40_000),1));
  const queue=recorder.eventQueueStats;
  assert.equal(queue.acceptedEvents,1);assert.equal(queue.postedBatches,0);assert.equal(queue.inFlightBatches,0);
  assert.equal(queue.firstFailure?.reason,'transport-send');assert.equal(queue.firstFailure?.pendingEvents,1);
  assert.ok(queue.firstFailure!.estimatedBytes!>64*1024);assert.equal(queue.pendingEvents,0);
  recorder.event('after-failure',{},2);assert.equal(recorder.eventQueueStats.acceptedEvents,1);
  const ending=recorder.finish();assert.equal(worker.messages.at(-1).kind,'finish');
  const raw=await ending;assert.equal(raw.stats.complete,false);assert.match(raw.stats.error,/전송 실패/);
 });
});

test('event drain deadline is reported separately from pending byte admission overflow',async(t)=>{
 let now=0;t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setTimeout']});
 await eventQueueClient(async(recorder)=>{
  recorder.event('waiting-for-ack',{},0);const ending=recorder.finish();
  now=10_001;t.mock.timers.tick(10);
  const raw=await ending;assert.equal(raw.stats.complete,false);
  assert.equal(raw.stats.eventQueue?.firstFailure?.reason,'finish-timeout');assert.equal(raw.stats.eventQueue?.firstFailure?.seq,null);
  assert.equal(raw.stats.eventQueue?.firstFailure?.estimatedBytes,null);assert.equal(raw.stats.eventQueue?.firstFailure?.inFlightBatches,1);
 });
});
test('a missing input channel is reported, not mistaken for a complete recording',async()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');let request:any;
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:class{
  onmessage:any;onerror:any;terminate(){}
  postMessage(m:any){if(m.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready'}}));if(m.kind==='finish'){request=m;queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(),stats:{frames:0,events:0,dropped:0,bytes:0,complete:true,error:''}}}));}if(m.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));}
 }});
 try{const r=await createExactRecording();r.takePort();assert.throws(()=>r.takePort(),/이미/);r.incomplete('입력 Worker 중단');const result=await r.finish();assert.equal(request.noSource,true);assert.equal(result.stats.complete,false);assert.match(result.stats.error,/중단/);await result.dispose();}
 finally{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
});

test('exact journal chunks are persisted before transport credits while raw finish remains independent',async()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');let release!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve;}),written:string[]=[];
 class JournalWorker{
  static instance:JournalWorker;
  onmessage:any;onerror:any;messages:any[]=[];credits=0;
  constructor(){JournalWorker.instance=this;}
  postMessage(message:any){
   this.messages.push(message);
   if(message.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready'}}));
   if(message.kind==='journal-start')queueMicrotask(()=>{for(let sequence=0;sequence<2;sequence++)this.onmessage({data:{kind:'journal-chunk',sequence,blob:new Blob([sequence?'second':'first'])}});});
   if(message.kind==='journal-credit'&&++this.credits===2)queueMicrotask(()=>this.onmessage({data:{kind:'journal-done'}}));
   if(message.kind==='finish')queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(['firstsecond']),stats:{frames:1,events:0,dropped:0,bytes:11,complete:true,error:''}}}));
   if(message.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
  }
  terminate(){}
 }
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:JournalWorker});
 try{
  const recorder=await createExactRecording();recorder.setJournal({async write(chunk){await blocked;written.push(await chunk.blob.text());},incomplete:assert.fail});
  assert.throws(()=>recorder.setJournal({async write(){},incomplete(){}}),/연결/);
  const raw=await recorder.finish(),worker=JournalWorker.instance;assert.equal(await raw.blob.text(),'firstsecond');assert.equal(worker.credits,0);
  const finalizing=recorder.finishJournal();release();const journal=await finalizing;
  assert.deepEqual(written,['first','second']);assert.deepEqual(journal,{enabled:true,complete:true,chunks:2,bytes:11,peakPendingBytes:11,error:''});
  assert.equal(worker.messages.filter((message:any)=>message.kind==='journal-credit').length,2);await raw.dispose();
 }finally{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
});

test('journal persistence failure marks only that journal partial and cannot suppress the original recording',async()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');const warnings:string[]=[];
 class FailedJournalWorker{
  static instance:FailedJournalWorker;
  onmessage:any;onerror:any;messages:any[]=[];constructor(){FailedJournalWorker.instance=this;}
  postMessage(message:any){this.messages.push(message);
   if(message.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready'}}));
   if(message.kind==='journal-start')queueMicrotask(()=>this.onmessage({data:{kind:'journal-chunk',sequence:0,blob:new Blob(['encoded'])}}));
   if(message.kind==='finish')queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(['encoded']),stats:{frames:1,events:0,dropped:0,bytes:7,complete:true,error:''}}}));
   if(message.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
  }terminate(){}
 }
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:FailedJournalWorker});
 try{
  const recorder=await createExactRecording();recorder.setJournal({async write(){throw Error('quota');},incomplete:reason=>{warnings.push(reason);}});
  const raw=await recorder.finish(),journal=await recorder.finishJournal();
  assert.equal(raw.stats.complete,true);assert.equal(journal.complete,false);assert.match(journal.error,/quota/);
  assert.equal(FailedJournalWorker.instance.messages.some((message:any)=>message.kind==='journal-credit'),false);assert.equal(warnings.length,1);await raw.dispose();
 }finally{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
});

test('journal close has a separate deadline when persistence never settles',async()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');let aborted=false;
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:class{
  onmessage:any;onerror:any;postMessage(message:any){
   if(message.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready'}}));
   if(message.kind==='journal-start')queueMicrotask(()=>this.onmessage({data:{kind:'journal-chunk',sequence:0,blob:new Blob(['encoded'])}}));
   if(message.kind==='finish')queueMicrotask(()=>this.onmessage({data:{kind:'done',blob:new Blob(['encoded']),stats:{frames:1,events:0,dropped:0,bytes:7,complete:true,error:''}}}));
   if(message.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
  }terminate(){}
 }});
 try{
  const recorder=await createExactRecording();recorder.setJournal({write(_chunk,signal){signal!.addEventListener('abort',()=>{aborted=true;});return new Promise(()=>{});},incomplete(){}});
  const raw=await recorder.finish(),journal=await recorder.finishJournal(10);assert.equal(journal.complete,false);assert.match(journal.error,/時間|시간/);assert.equal(aborted,true);await raw.dispose();
 }finally{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
});

async function sourceReader(run:(recorder:Awaited<ReturnType<typeof createExactRecording>>,worker:any)=>Promise<void>,supported=true){
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');let worker:any;
 class SourceWorker {
  onmessage:any;onerror:any;messages:any[]=[];terminated=false;
  constructor(){worker=this;}
  postMessage(message:any){this.messages.push(message);
   if(message.kind==='init')queueMicrotask(()=>this.onmessage({data:{kind:'ready',supportsSourceReads:supported}}));
   if(message.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
  }
  terminate(){this.terminated=true;}
 }
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:SourceWorker});
 try{const recorder=await createExactRecording();await run(recorder,worker);}
 finally{if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
}
const rawSource=(id:number)=>({id,width:1,height:1,time:4,hash:'a'.repeat(64),pixels:new Uint8ClampedArray([id,2,3,255])});

test('canonical client permits one read, ignores cancelled late replies and validates transferred frames',async()=>{
 await sourceReader(async(recorder,worker)=>{
  assert.equal(recorder.supportsSourceReads,true);
  const controller=new AbortController(),first=recorder.readFrame(1,controller.signal),cancelled=assert.rejects(first,/cancelled/);
  await assert.rejects(recorder.readFrame(2),/한 번에/);
  controller.abort(new Error('cancelled'));await cancelled;
  assert.equal(worker.messages.at(-1).kind,'read-cancel');
  const second=recorder.readFrame(2),request=worker.messages.at(-1);
  worker.onmessage({data:{kind:'read-frame',requestId:request.requestId-1,raw:rawSource(1)}});
  worker.onmessage({data:{kind:'read-frame',requestId:request.requestId,raw:rawSource(2)}});
  assert.deepEqual((await second).pixels,new Uint8ClampedArray([2,2,3,255]));
  const invalid=recorder.readFrame(3),rejectInvalid=assert.rejects(invalid,/응답 오류/),invalidRequest=worker.messages.at(-1);
  worker.onmessage({data:{kind:'read-frame',requestId:invalidRequest.requestId,raw:{...rawSource(3),width:2}}});
  await rejectInvalid;await recorder.dispose();assert.equal(worker.terminated,true);
 });
});

test('canonical read timeout and disposal cancel pending work without accepting later responses',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 await sourceReader(async(recorder,worker)=>{
  const pending=recorder.readFrame(1),expired=assert.rejects(pending,/시간 초과/);
  t.mock.timers.tick(10_000);await expired;assert.equal(worker.messages.at(-1).kind,'read-cancel');
  const reading=recorder.readFrame(2),stopped=assert.rejects(reading,/저장소 종료/);
  await recorder.dispose();await stopped;
  await assert.rejects(recorder.readFrame(3),/저장소 상태/);
  assert.equal(worker.terminated,true);
 });
});

test('unsupported canonical live reads fail before sending a read request',async()=>{
 await sourceReader(async(recorder,worker)=>{
  assert.equal(recorder.supportsSourceReads,false);await assert.rejects(recorder.readFrame(1),/저장소 상태/);
  assert.equal(worker.messages.some((message:any)=>message.kind==='read-frame'),false);await recorder.dispose();
 },false);
});

async function attestationClient(mode:'valid'|'wrong-session'|'missing'|'unexpected',run:(recorder:Awaited<ReturnType<typeof createExactRecording>>,worker:any)=>Promise<void>){
 const old=Object.getOwnPropertyDescriptor(globalThis,'Worker');let worker:any;
 class AttestedWorker {
  onmessage:any;onerror:any;messages:any[]=[];ports:MessagePort[]=[];terminated=false;
  constructor(){worker=this;}
  postMessage(message:any){this.messages.push(message);
   if(message.kind==='init'){
    this.ports.push(message.port);if(message.attestation)this.ports.push(message.attestation.port);
    const identity=message.attestation?{version:1,sessionId:message.attestation.sessionId,producerId:message.attestation.producerId}:undefined;
    queueMicrotask(()=>this.onmessage({data:{kind:'ready',supportsSourceReads:true,...(message.storageVersion?{storageVersion:1}:{}),
     ...(mode==='missing'?{}:{attestation:mode==='wrong-session'?{...identity,sessionId:'wrong'}:mode==='unexpected'?{version:1,sessionId:'unasked',producerId:'unasked'}:identity})}}));
   }
   if(message.kind==='dispose')queueMicrotask(()=>this.onmessage({data:{kind:'disposed'}}));
  }
  terminate(){this.terminated=true;for(const port of this.ports)port.close();}
 }
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:AttestedWorker});
 try{
  const opening=createExactRecording(mode==='unexpected'?{}:{storageVersion:1,preparedNativeAttestation:true});
  if(mode==='valid')await run(await opening,worker);else {await assert.rejects(opening,/attestation|증명|plain object/);assert.equal(worker.terminated,true);}
 }finally{worker?.terminate();if(old)Object.defineProperty(globalThis,'Worker',old);else Reflect.deleteProperty(globalThis,'Worker');}
}

test('exact client creates one private preparation endpoint and validates the actual worker readiness identity',async()=>{
 await attestationClient('valid',async(recorder,worker)=>{
  const identity=recorder.nativeAttestationIdentity!,init=worker.messages[0];
  assert.equal(Object.isFrozen(identity),true);assert.equal(identity.version,1);
  assert.equal(init.attestation.sessionId,identity.sessionId);assert.equal(init.attestation.producerId,identity.producerId);
  const preparation=recorder.takePreparationAttestation();
  assert.equal(preparation.sessionId,identity.sessionId);assert.equal(preparation.producerId,identity.producerId);
  assert.throws(()=>recorder.takePreparationAttestation(),/接続|연결/);
  preparation.port.close();await recorder.dispose();assert.equal(worker.terminated,true);
 });
});

for(const mode of ['wrong-session','missing','unexpected'] as const)test(`exact client rejects ${mode} attestation capability readiness`,async()=>{
 await attestationClient(mode,async()=>{assert.fail('invalid readiness must not open');});
});

test('native attestation cannot be enabled without the explicitly supported compact storage version',async()=>{
 await assert.rejects(createExactRecording({preparedNativeAttestation:true}),/설정 오류/);
 await assert.rejects(createExactRecording({storageVersion:1,preparedNativeAttestation:false} as any),/설정 오류/);
});

test('a compact writer cannot claim complete when its committed native attestation total is missing',async()=>{
 await attestationClient('valid',async(recorder,worker)=>{
  const ending=recorder.finish();
  worker.onmessage({data:{kind:'done',blob:new Blob(['partial']),stats:{frames:1,events:0,dropped:0,bytes:7,
   complete:true,error:'',storageVersion:1,nativeFrames:1,rgbaFrames:0,nativeAttestedFrames:0}}});
  const raw=await ending;assert.equal(raw.stats.complete,false);assert.match(raw.stats.error,/증명 결과 수/);await raw.dispose();
 });
});
