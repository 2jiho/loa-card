import test from 'node:test';
import assert from 'node:assert/strict';
import {createExactRecording,type ExactJournalMirrorStats,type ExactRecorder} from '../src/features/card-scanner/exact-recording';
import type {RecordingJournal} from '../src/features/card-scanner/recording-journal';

type Message={kind:string;[key:string]:unknown};
class JournalWorker {
 static instance:JournalWorker;
 onmessage:((event:{data:Message})=>void)|undefined;
 messages:Message[]=[];
 constructor(){JournalWorker.instance=this;}
 postMessage(message:Message){
  this.messages.push(message);
  if(message.kind==='init')queueMicrotask(()=>this.emit({kind:'ready'}));
  if(message.kind==='dispose')queueMicrotask(()=>this.emit({kind:'disposed'}));
 }
 emit(data:Message){this.onmessage?.({data});}
 terminate(){}
}
async function client(run:(recorder:ExactRecorder,worker:JournalWorker)=>Promise<void>){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker');let recorder:ExactRecorder|undefined;
 Object.defineProperty(globalThis,'Worker',{configurable:true,value:JournalWorker});
 try{recorder=await createExactRecording();await run(recorder,JournalWorker.instance);}
 finally{await recorder?.dispose();if(previous)Object.defineProperty(globalThis,'Worker',previous);else Reflect.deleteProperty(globalThis,'Worker');}
}
const snapshot=(overrides:Partial<ExactJournalMirrorStats>={}):ExactJournalMirrorStats=>({
 availableBytes:4,sentBytes:4,acknowledgedBytes:0,pendingBytes:4,peakPendingBytes:4,chunks:1,complete:false,error:'',...overrides,
});
const target:RecordingJournal={async write(){},incomplete(){}};
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('journal mirror snapshots are bounded immutable diagnostics on the main event clock, not persistence ACKs',async(t)=>{
 let now=100;t.mock.method(performance,'now',()=>now);
 await client(async(recorder,worker)=>{
  let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
  recorder.setJournal({async write(){await blocked;},incomplete:assert.fail});
  now=106;const mirror={...snapshot()};
  worker.emit({kind:'journal-chunk',sequence:0,blob:new Blob(['test']),mirror});
  const pending=recorder.journalStats;
  assert.deepEqual(pending.mirror,snapshot());assert.equal(Object.isFrozen(pending.mirror),true);
  assert.equal(pending.mirrorObservedAtMs,6);assert.equal(pending.firstErrorAtMs,undefined);
  assert.equal(pending.bytes,0);assert.equal(pending.chunks,0);assert.equal(pending.complete,false);
  assert.equal(worker.messages.some(message=>message.kind==='journal-credit'),false);
  mirror.sentBytes=999;assert.equal(recorder.journalStats.mirror?.sentBytes,4,'the diagnostic retains no sender-owned object');
  release();await turn();assert.deepEqual(worker.messages.filter(message=>message.kind==='journal-credit'),[{kind:'journal-credit',sequence:0,bytes:4}]);
  now=112;const completed=snapshot({acknowledgedBytes:4,pendingBytes:0,complete:true});
  worker.emit({kind:'journal-done',mirror:completed});
  const stats=await recorder.finishJournal();assert.equal(stats.complete,true);assert.equal(stats.bytes,4);assert.equal(stats.chunks,1);
  assert.deepEqual(stats.mirror,completed);assert.equal(stats.mirrorObservedAtMs,12);
 });
});

test('a mirror completion or error claim cannot promote the original chunk message into a terminal journal result',async()=>{
 await client(async(recorder,worker)=>{
  recorder.setJournal(target);
  worker.emit({kind:'journal-chunk',sequence:0,blob:new Blob(['test']),mirror:snapshot({acknowledgedBytes:4,pendingBytes:0,complete:true})});
  await turn();assert.equal(recorder.journalStats.complete,false);assert.equal(recorder.journalStats.error,'');
  worker.emit({kind:'journal-chunk',sequence:1,blob:new Blob(['next']),mirror:snapshot({availableBytes:8,sentBytes:8,acknowledgedBytes:4,chunks:2,error:'mirror-only warning'})});
  await turn();assert.equal(recorder.journalStats.error,'');assert.equal(recorder.journalStats.firstErrorAtMs,undefined);
  assert.equal(recorder.journalStats.bytes,8);assert.equal(worker.messages.filter(message=>message.kind==='journal-credit').length,2);
  worker.emit({kind:'journal-done',mirror:{complete:false}});
  assert.equal((await recorder.finishJournal()).complete,true,'the existing done protocol is processed independently of malformed telemetry');
 });
});

test('unknown or malformed mirror telemetry is discarded while original chunks and done messages keep their behavior',async(t)=>{
 let now=200;t.mock.method(performance,'now',()=>now);
 await client(async(recorder,worker)=>{
  recorder.setJournal(target);
  const accessor=Object.defineProperty({...snapshot()},'sentBytes',{get(){throw Error('must not evaluate telemetry accessors');}});
  const invalid:unknown[]=[undefined,null,[],42,{...snapshot(),extra:'unknown'},snapshot({chunks:NaN}),snapshot({sentBytes:-1}),
   snapshot({acknowledgedBytes:5}),snapshot({pendingBytes:0}),snapshot({peakPendingBytes:9*1024*1024}),
   snapshot({error:'x'.repeat(2001)}),snapshot({complete:true}),accessor];
  for(let sequence=0;sequence<invalid.length;sequence++){
   now++;assert.doesNotThrow(()=>worker.emit({kind:'journal-chunk',sequence,blob:new Blob(['test']),mirror:invalid[sequence]}));
  }
  await turn();const stats=recorder.journalStats;
  assert.equal(stats.mirror,undefined);assert.equal(stats.mirrorObservedAtMs,undefined);assert.equal(stats.error,'');
  assert.equal(stats.chunks,invalid.length);assert.equal(stats.bytes,invalid.length*4);
  assert.equal(worker.messages.filter(message=>message.kind==='journal-credit').length,invalid.length);
  worker.emit({kind:'journal-done',mirror:{complete:true,error:'forged'}});
  assert.equal((await recorder.finishJournal()).complete,true);assert.equal(recorder.journalStats.mirror,undefined);
 });
});

test('the latest valid snapshot time is retained when a later malformed snapshot is discarded',async(t)=>{
 let now=100;t.mock.method(performance,'now',()=>now);
 await client(async(recorder,worker)=>{
  recorder.setJournal(target);now=104;
  worker.emit({kind:'journal-chunk',sequence:0,blob:new Blob(['test']),mirror:snapshot()});await turn();
  now=109;worker.emit({kind:'journal-done',mirror:{...snapshot(),sentBytes:'4'}});
  const stats=await recorder.finishJournal();assert.deepEqual(stats.mirror,snapshot());assert.equal(stats.mirrorObservedAtMs,4);
 });
});

test('the first real journal error timestamp accepts zero and does not move on repeated errors or later snapshots',async(t)=>{
 let now=500;t.mock.method(performance,'now',()=>now);
 await client(async(recorder,worker)=>{
  const warnings:string[]=[];recorder.setJournal({async write(){},incomplete(reason){warnings.push(reason);}});
  worker.emit({kind:'journal-error',error:'first failure',mirror:snapshot({error:'first failure'})});
  assert.equal(recorder.journalStats.firstErrorAtMs,0);assert.equal(recorder.journalStats.mirrorObservedAtMs,0);
  now=525;worker.emit({kind:'journal-error',error:'later failure',mirror:snapshot({error:'later failure'})});
  const stats=await recorder.finishJournal();assert.equal(stats.firstErrorAtMs,0);assert.equal(stats.error,'first failure');
  assert.equal(stats.mirrorObservedAtMs,25);assert.equal(stats.mirror?.error,'later failure');assert.equal(stats.complete,false);
  assert.deepEqual(warnings,['first failure']);assert.equal(worker.messages.filter(message=>message.kind==='journal-stop').length,1);
 });
});

test('a local persistence failure is timestamped independently of a worker snapshot and cannot be cleared by done',async(t)=>{
 let now=800;t.mock.method(performance,'now',()=>now);
 await client(async(recorder,worker)=>{
  recorder.setJournal({async write(){throw Error('quota');},incomplete(){}});now=807;
  worker.emit({kind:'journal-chunk',sequence:0,blob:new Blob(['test'])});await turn();
  assert.equal(recorder.journalStats.firstErrorAtMs,7);assert.equal(recorder.journalStats.mirror,undefined);
  now=820;worker.emit({kind:'journal-done',mirror:snapshot({acknowledgedBytes:4,pendingBytes:0,complete:true})});
  const stats=await recorder.finishJournal();assert.equal(stats.complete,false);assert.match(stats.error,/quota/);
  assert.equal(stats.firstErrorAtMs,7);assert.equal(stats.mirrorObservedAtMs,20);
  assert.equal(worker.messages.some(message=>message.kind==='journal-credit'),false);
 });
});
