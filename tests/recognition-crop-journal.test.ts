import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createRecognitionCropJournal,replayRecognitionCropJournal,cropJournalHash,cropJournalChain} from '../dev/recognition-crop-journal';
import {createCropIndexedDbSink,loadCropIndexedDbRun,deleteCropIndexedDbRun,listCropIndexedDbRuns} from '../dev/recognition-crop-indexeddb';
import type {RecognitionInputMeta,RecognitionInputOutcome} from '../src/features/card-scanner/recognition/recognition-input-observer';

const seed={version:1 as const,sessionId:null,build:'test',catalog:'test',nameConfiguration:{version:1,rawResultPolicy:'resample'},
 modelSignature:null,recognitionOptions:{fractionalPortrait:false,grayNameFallback:false}};
const meta=(id:number):RecognitionInputMeta=>({diagnosticReadId:id,processingFrame:id,slot:0,
 source:{sessionId:'session',frameId:id,observationId:`o${id}`,captureOrder:id,captureTime:id/10,phase:'input',slot:0},
 group:id,trace:id,pixelKey:`pixel${id}`,stage:'short',stable:true,borderAlignment:1,
 sourceBox:{x:1,y:1,width:1,height:1},sourceWidth:10,sourceHeight:10,cropWidth:1,cropHeight:1});
const canvas=(value:number)=>({width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([value,2,3,255])})})}) as unknown as HTMLCanvasElement;
const outcome={admitted:true,identifyExecuted:true,timedOut:false,error:null,status:'read'} as RecognitionInputOutcome;
const signal=()=>new AbortController().signal;
test('v1 database upgrade preserves existing runs and rebuilds shared usage',async()=>{
 const name='loacard-dev-recognition-crops-v1';
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(name,1);
  r.onupgradeneeded=()=>{r.result.createObjectStore('runs',{keyPath:'id'});r.result.createObjectStore('events',{keyPath:['runId','seq']});r.result.createObjectStore('pixels',{keyPath:['runId','key']});};
  r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['runs','events','pixels'],'readwrite');
  tx.objectStore('runs').add({id:'legacy',seed,checkpoint:{version:1,complete:false}});
  tx.objectStore('events').add({runId:'legacy',seq:1,event:{seq:1,kind:'begin',readId:1,meta:meta(1)}});
  tx.objectStore('pixels').add({runId:'legacy',key:'legacy',pixels:new Uint8Array([1,2,3,4])});
  tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
 const upgraded=await loadCropIndexedDbRun('legacy');assert.equal(upgraded.events.length,1);
 assert.deepEqual(await upgraded.read('legacy'),new Uint8Array([1,2,3,4]));upgraded.close();
 assert.equal(await deleteCropIndexedDbRun('legacy'),true);
});
test('real IndexedDB stores all attempts in order, sharing only exact bytes with distinct source metadata',async()=>{
 const id=`test-${crypto.randomUUID()}`,sink=await createCropIndexedDbSink(id),journal=createRecognitionCropJournal(seed,sink);
 for(const [read,value] of [[1,1],[2,1],[3,9]]){
  const inspection=journal.observer.begin(meta(read))!;inspection.captureCard(canvas(value));inspection.finish(outcome);
 }
 const checkpoint=await journal.finish();sink.close();
 assert.equal(checkpoint.complete,true);assert.equal(checkpoint.attempts,3);assert.equal(checkpoint.captured,3);
 assert.equal(checkpoint.unique,2);assert.equal(checkpoint.shared,1);assert.equal(checkpoint.nominalBytes,12);assert.equal(checkpoint.storedBytes,8);
 assert.equal(checkpoint.batches,1);assert.equal(checkpoint.peakBatchEvents,9);assert.equal(checkpoint.peakBatchBytes,12);
 const stored=await loadCropIndexedDbRun(id),rows:{id:string;pixel:number;complete:boolean}[]=[];
 try{
  const result=await replayRecognitionCropJournal(stored.seed,stored.events,stored.checkpoint,stored.read,(_event,m,pixels,scope)=>{
   rows.push({id:m.source.observationId,pixel:pixels[0],complete:scope.complete});
  },signal());
  assert.equal(result.complete,true);assert.deepEqual(rows,[{id:'o1',pixel:1,complete:true},{id:'o2',pixel:1,complete:true},{id:'o3',pixel:9,complete:true}]);
  assert.equal(stored.events.length,9);
  const unknown=await replayRecognitionCropJournal(stored.seed,stored.events,null,stored.read,()=>{},signal());assert.equal(unknown.complete,false);
  const changed=structuredClone(stored.events);changed[0].seq=2;
  let invoked=false;await assert.rejects(replayRecognitionCropJournal(stored.seed,changed,stored.checkpoint,stored.read,()=>{invoked=true;},signal()));assert.equal(invoked,false);
  const bad={...stored.checkpoint!,chain:'0'.repeat(64)};
  await assert.rejects(replayRecognitionCropJournal(stored.seed,stored.events,bad,stored.read,()=>{invoked=true;},signal()),/checkpoint/);assert.equal(invoked,false);
  await assert.rejects(replayRecognitionCropJournal({...stored.seed,build:'changed'},stored.events,stored.checkpoint,stored.read,()=>{invoked=true;},signal()),/checkpoint/);
  await assert.rejects(replayRecognitionCropJournal(stored.seed,stored.events,{...stored.checkpoint!,storedBytes:0},stored.read,()=>{invoked=true;},signal()),/checkpoint/);
  await assert.rejects(replayRecognitionCropJournal(stored.seed,stored.events,stored.checkpoint,async()=>new Uint8Array([9,9,9,9]),()=>{},signal()),/integrity/);
 }finally{stored.close();await deleteCropIndexedDbRun(id);}
});
test('queue exhaustion and missing capture are visibly partial without throwing into recognition',async()=>{
 let unblock!:()=>void;const gate=new Promise<void>(resolve=>{unblock=resolve;});let saved:unknown;const events:unknown[]=[];
 const sink={begin:async()=>gate,get:async()=>undefined,put:async()=>{},append:async(value:unknown)=>{events.push(value);},seal:async(value:unknown)=>{saved=value;}};
 const journal=createRecognitionCropJournal(seed,sink,{maxPendingEvents:1});
 const attempt=journal.observer.begin(meta(1))!;attempt.captureCard(canvas(1));attempt.finish(outcome);
 unblock();const result=await journal.finish();
 assert.equal(result.complete,false);assert.ok(result.lost>0);assert.match(result.reason!,/event queue limit/);assert.deepEqual(saved,result);
 assert.equal(events.length,1,'accepted prefix drains after admission limit is hit');assert.equal(result.events,1);
});
test('matching digest with unequal stored bytes cannot be shared',async()=>{
 const sink={begin:async()=>{},get:async()=>new Uint8Array([8,8,8,8]),put:async()=>{},append:async()=>{},seal:async()=>{}};
 const journal=createRecognitionCropJournal(seed,sink),attempt=journal.observer.begin(meta(1))!;
 attempt.captureCard(canvas(1));attempt.finish(outcome);const checkpoint=await journal.finish();
 assert.equal(checkpoint.complete,false);assert.match(checkpoint.reason!,/collision|corruption/);assert.equal(checkpoint.shared,0);
});

test('global budget accounts for concurrent runs and never evicts an older sealed recording',async()=>{
 const first=`first-${crypto.randomUUID()}`,second=`second-${crypto.randomUUID()}`;
 // One open run reserves the final checkpoint. The same shared database usage
 // is checked atomically even when each sink is a different connection.
 const a=await createCropIndexedDbSink(first,{logicalBudget:18_000}),b=await createCropIndexedDbSink(second,{logicalBudget:18_000});
 await a.begin(seed);
 const active=await listCropIndexedDbRuns();assert.ok(active.runs.some(run=>run.id===first&&run.status==='open'));
 await assert.rejects(b.begin(seed),/budget/);
 await assert.rejects(deleteCropIndexedDbRun(first),/active/);
 const partial={version:1 as const,complete:false,reason:'test',events:0,chain:'0'.repeat(64),attempts:0,captured:0,unique:0,shared:0,lost:1,
  nominalBytes:0,storedBytes:0,peakPendingBytes:0,copyMs:0,hashMs:0,storageMs:0,maxPendingBytes:1,maxPendingEvents:1,scope:'recognition-crops-only' as const};
 await a.seal(partial);a.close();await b.begin(seed);await b.seal(partial);b.close();
 const saved=await loadCropIndexedDbRun(first);assert.equal(saved.checkpoint?.reason,'test');saved.close();
 const listed=await listCropIndexedDbRuns();assert.ok(listed.runs.some(run=>run.id===first&&run.status==='partial'));assert.equal(listed.truncated,false);
 assert.equal(await deleteCropIndexedDbRun(second),true);
 const preserved=await loadCropIndexedDbRun(first);assert.equal(preserved.checkpoint?.reason,'test');preserved.close();
 assert.equal(await deleteCropIndexedDbRun(first),true);
});

test('sealing failure after disk errors is surfaced and a prefix is not called complete',async()=>{
 const sink={begin:async()=>{},get:async()=>undefined,put:async()=>{},append:async()=>{throw Error('write failed');},seal:async()=>{throw Error('seal failed');}};
 const journal=createRecognitionCropJournal(seed,sink),attempt=journal.observer.begin(meta(1))!;
 attempt.captureCard(canvas(1));attempt.finish(outcome);const result=await journal.finish();
 assert.equal(result.complete,false);assert.match(result.reason!,/seal failed/);assert.ok(result.lost>0);
});

test('batch quota and digest collisions roll back every event and crop atomically',async()=>{
 const id=`atomic-${crypto.randomUUID()}`,sink=await createCropIndexedDbSink(id,{logicalBudget:18_000});await sink.begin(seed);
 const pixels=new Uint8Array(64*64*4),crop={kind:'pixels' as const,seq:2,readId:1,width:64,height:64,sha256:'a'.repeat(64),pixels};
 const begin={kind:'event' as const,event:{seq:1,kind:'begin' as const,readId:1,meta:meta(1)}};
 await assert.rejects(sink.appendBatch!([begin,crop]),/budget/);
 const saved=await loadCropIndexedDbRun(id);assert.equal(saved.events.length,0);
 assert.equal(await saved.read(`64x64:${crop.sha256}`),undefined);saved.close();
 const collision=[begin,{...crop,width:1,height:1,pixels:new Uint8Array([1,2,3,4])},
  {...crop,seq:3,width:1,height:1,pixels:new Uint8Array([9,2,3,4])}];
 await assert.rejects(sink.appendBatch!(collision),/collision|corruption/);
 const again=await loadCropIndexedDbRun(id);assert.equal(again.events.length,0);
 assert.equal(await again.read(`1x1:${crop.sha256}`),undefined);again.close();
 await sink.seal({version:1,complete:false,reason:'test',events:0,chain:'0'.repeat(64),attempts:0,captured:0,unique:0,shared:0,lost:1,
  nominalBytes:0,storedBytes:0,peakPendingBytes:0,copyMs:0,hashMs:0,storageMs:0,maxPendingBytes:1,maxPendingEvents:1,scope:'recognition-crops-only'});
 sink.close();await deleteCropIndexedDbRun(id);
});

test('v2 records input-time pixels and preserves rejected attempt without a crop',async()=>{
 const id=`input-v2-${crypto.randomUUID()}`,sink=await createCropIndexedDbSink(id);
 const journal=createRecognitionCropJournal({...seed,version:2,captureBoundary:'recognition-input-v2'},sink);
 let value=7;const mutable={width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([value,2,3,255])})})} as unknown as HTMLCanvasElement;
 const attempt=journal.observer.begin(meta(1))!;attempt.captureInput!(mutable);value=9;attempt.captureCard(mutable);attempt.finish(outcome);
 const rejected=journal.observer.begin(meta(2))!;rejected.captureCard(mutable);rejected.finish({...outcome,admitted:false});
 const checkpoint=await journal.finish();sink.close();
 assert.equal(checkpoint.complete,true);assert.equal(checkpoint.captured,1);assert.equal(checkpoint.skipped,1);assert.equal(checkpoint.attempts,2);
 const stored=await loadCropIndexedDbRun(id);let pixel=-1;
 try {assert.equal(stored.seed.version,2);assert.equal(stored.seed.captureBoundary,'recognition-input-v2');
  const replay=await replayRecognitionCropJournal(stored.seed,stored.events,stored.checkpoint,stored.read,(_event,_meta,pixels)=>{pixel=pixels[0];},signal());
  assert.equal(replay.complete,true);assert.equal(pixel,7);
  await assert.rejects(replayRecognitionCropJournal({...stored.seed,version:1,captureBoundary:undefined},stored.events,stored.checkpoint,stored.read,()=>{},signal()));
  await assert.rejects(replayRecognitionCropJournal(stored.seed,stored.events,{...stored.checkpoint!,skipped:0},stored.read,()=>{},signal()),/checkpoint/);
 } finally {stored.close();await deleteCropIndexedDbRun(id);}
});
test('v2 admitted attempt without input is partial',async()=>{
 const sink={begin:async()=>{},get:async()=>undefined,put:async()=>{},append:async()=>{},seal:async()=>{}};
 const journal=createRecognitionCropJournal({...seed,version:2,captureBoundary:'recognition-input-v2'},sink);
 const attempt=journal.observer.begin(meta(1))!;attempt.finish(outcome);
 const result=await journal.finish();assert.equal(result.complete,false);assert.match(result.reason!,/missing card crop/);
});

test('v2 rejects zero or changing input dimensions and canvas read failures as partial',async()=>{
 for(const input of [
  {width:0,height:1,getContext:()=>null},
  {width:2,height:1,getContext:()=>null},
  {width:1,height:1,getContext:()=>null},
  {width:1,height:1,getContext:()=>({getImageData:()=>{throw Error('readback failed');}})},
 ]){
  const sink={begin:async()=>{},get:async()=>undefined,put:async()=>{},append:async()=>{},seal:async()=>{}};
  const journal=createRecognitionCropJournal({...seed,version:2,captureBoundary:'recognition-input-v2'},sink);
  const attempt=journal.observer.begin(meta(1))!;attempt.captureInput!(input as unknown as HTMLCanvasElement);attempt.finish(outcome);
  const result=await journal.finish();assert.equal(result.complete,false);assert.ok(result.reason);assert.equal(result.captured,0);
 }
});
test('v2 keeps actual input and finish ordering for overlapping attempts',async()=>{
 const id=`ordered-v2-${crypto.randomUUID()}`,sink=await createCropIndexedDbSink(id);
 const journal=createRecognitionCropJournal({...seed,version:2,captureBoundary:'recognition-input-v2'},sink);
 const a=journal.observer.begin(meta(1))!,b=journal.observer.begin(meta(2))!;
 b.captureInput!(canvas(2));a.captureInput!(canvas(1));b.finish(outcome);a.finish(outcome);
 const checkpoint=await journal.finish();sink.close();assert.equal(checkpoint.complete,true);
 const stored=await loadCropIndexedDbRun(id),seen:number[]=[];
 try {assert.deepEqual(stored.events.map(e=>`${e.kind}:${e.readId}`),['begin:1','begin:2','crop:2','crop:1','finish:2','finish:1']);
  await replayRecognitionCropJournal(stored.seed,stored.events,stored.checkpoint,stored.read,(_event,m)=>{seen.push(m.diagnosticReadId);},signal());
  assert.deepEqual(seen,[2,1]);
 } finally {stored.close();await deleteCropIndexedDbRun(id);}
});

test('restore preserves crop property order and hash chain, validates every field and rolls back mismatches',async()=>{
 const id=`restore-${crypto.randomUUID()}`,sink=await createCropIndexedDbSink(id);await sink.begin(seed);
 const pixels=new Uint8Array([1,2,3,4]),sha256=await cropJournalHash(pixels);
 const begin={seq:1,kind:'begin' as const,readId:1,meta:meta(1)};
 const original={kind:'crop' as const,readId:1,width:1,height:1,sha256,shared:false,seq:2};
 const item={kind:'pixels' as const,seq:2,readId:1,width:1,height:1,sha256,pixels,originalEvent:original};
 const first={kind:'event' as const,event:begin};
 for(const changed of [{...original,shared:true},{...original,readId:2},{...original,seq:3},
  {...original,width:2},{...original,height:2},{...original,sha256:'0'.repeat(64)},
  {...original,kind:'other'},{...original,extra:true}]){
  await assert.rejects(sink.appendBatch!([first,{...item,originalEvent:changed as typeof original}]));
  const run=await loadCropIndexedDbRun(id);assert.equal(run.events.length,0);assert.equal(await run.read(`1x1:${sha256}`),undefined);run.close();
 }
 await assert.rejects(sink.appendBatch!([first,{...item,pixels:new Uint8Array([5,2,3,4])}]),/digest/);
 const events=await sink.appendBatch!([first,item]);assert.equal(JSON.stringify(events[1]),JSON.stringify(original));
 const run=await loadCropIndexedDbRun(id);assert.equal(JSON.stringify(run.events[1]),JSON.stringify(original));
 const chain=await cropJournalChain(await cropJournalChain('0'.repeat(64),begin),original);
 assert.equal(await cropJournalChain(await cropJournalChain('0'.repeat(64),run.events[0]),run.events[1]),chain);
 run.close();await sink.seal({version:1,complete:false,reason:'test',events:2,chain,attempts:1,captured:1,unique:1,shared:0,lost:0,
  nominalBytes:4,storedBytes:4,peakPendingBytes:4,copyMs:0,hashMs:0,storageMs:0,maxPendingBytes:4,maxPendingEvents:2,scope:'recognition-crops-only'});
 sink.close();await deleteCropIndexedDbRun(id);
});

test('restore sharing markers reflect exact bytes within one batch',async()=>{
 const id=`restore-share-${crypto.randomUUID()}`,sink=await createCropIndexedDbSink(id);await sink.begin(seed);
 const pixels=new Uint8Array([1,2,3,4]),sha256=await cropJournalHash(pixels);
 const crop=(seq:number,readId:number,shared:boolean)=>({kind:'crop' as const,seq,readId,width:1,height:1,sha256,shared});
 const item=(seq:number,readId:number,shared:boolean)=>({kind:'pixels' as const,seq,readId,width:1,height:1,sha256,pixels,originalEvent:crop(seq,readId,shared)});
 await assert.rejects(sink.appendBatch!([item(1,1,false),item(2,2,false)]),/sharing/);
 const empty=await loadCropIndexedDbRun(id);assert.equal(empty.events.length,0);assert.equal(await empty.read(`1x1:${sha256}`),undefined);empty.close();
 const events=await sink.appendBatch!([item(1,1,false),item(2,2,true)]);
 assert.equal(events[0].kind==='crop'&&events[0].shared,false);assert.equal(events[1].kind==='crop'&&events[1].shared,true);
 await sink.seal({version:1,complete:false,reason:'test',events:2,chain:'0'.repeat(64),attempts:2,captured:2,unique:1,shared:1,lost:0,
  nominalBytes:8,storedBytes:4,peakPendingBytes:8,copyMs:0,hashMs:0,storageMs:0,maxPendingBytes:8,maxPendingEvents:2,scope:'recognition-crops-only'});
 sink.close();await deleteCropIndexedDbRun(id);
});
