import test from 'node:test';
import assert from 'node:assert/strict';
import {beginReproduction,type ReproductionFinalizationTiming} from '../src/features/card-scanner/scan-reproduction';
import {entryParts} from '../src/features/card-scanner/exact-recording-codec';
import type {ReproductionSession,ReproductionSessionStore,SessionSeal,SessionStart} from '../src/features/card-scanner/reproduction-session-store';

const environment={browser:'test',catalog:'test',build:'test'};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
function storeHarness(options:{registered?:Promise<void>;exact?:Blob;seal?:(value:SessionSeal)=>void}={}){
 const now=new Date().toISOString(),seals:SessionSeal[]=[];
 const stored:ReproductionSession={index:{version:1,id:'',createdAt:now,updatedAt:now,environment,record:true,
  status:'open',sealed:false,pinned:false,ownerId:'test',leaseUntil:Date.now()+120_000,bytes:0,detailsBytes:0,
  chunkCounts:{exact:0,video:0},chunkBytes:{exact:0,video:0},hasInput:!!options.exact?.size,read:null,expected:null,cards:null},
  initial:{seed:[]},video:new Blob(),...(options.exact?{exact:options.exact}:{})};
 const store={
  async beginSession(value:SessionStart){stored.index={...stored.index,id:value.id,createdAt:value.createdAt,
   environment:value.environment,record:value.record};stored.initial=value.initial;await options.registered;return stored.index;},
  async heartbeat(){},
  async appendChunk(_id:string,kind:'exact'|'video',_sequence:number,blob:Blob){
   if(kind==='video')stored.video=new Blob([stored.video,blob],{type:'video/webm'});
   else stored.exact=new Blob([...(stored.exact?[stored.exact]:[]),blob]);
   stored.index.hasInput=true;
  },
  async getSession(){return {...stored,index:{...stored.index}};},
  async sealSession(_id:string,value:SessionSeal){seals.push(value);options.seal?.(value);
   stored.index={...stored.index,status:value.status,sealed:true,leaseUntil:null,...(value.reason?{reason:value.reason}:{})};
   stored.metadata=value.metadata;stored.summary=value.summary;return stored.index;},
 } as unknown as ReproductionSessionStore;
 return {store,stored,seals};
}
function assertSettled(timing:ReproductionFinalizationTiming,status:'fulfilled'|'rejected'){
 assert.equal(timing.status,status);assert.ok(Number.isFinite(timing.totalMs));assert.ok(timing.totalMs!>=0);
 for(const [key,value]of Object.entries(timing))if(key.endsWith('Ms')&&value!==null){
  assert.equal(typeof value,'number');assert.ok(Number.isFinite(value));assert.ok(value>=0);
 }
}

test('finalization snapshots stay immutable and total waits for cleanup on the same shared finish promise',async()=>{
 const registered=deferred(),cleanup=deferred(),cleanupEntered=deferred(),h=storeHarness({registered:registered.promise});
 let previewDisposed=0,exactDisposed=0;
 const run=beginReproduction([],environment,{record:true,store:h.store,exact:{async finish(){return undefined;},
  async dispose(){exactDisposed++;}} as never});
 run.options.continuous!({blob:new Blob(['preview'],{type:'video/webm'}),duration:1,
  async dispose(){previewDisposed++;cleanupEntered.resolve();await cleanup.promise;}});
 const idle=run.finalizationTiming();assert.equal(idle.status,'idle');assert.equal(idle.totalMs,null);
 assert.ok(Object.isFrozen(idle));assert.ok(Object.isFrozen(idle.failedStages));
 assert.ok(Object.entries(idle).filter(([key])=>key.endsWith('Ms')).every(([,value])=>value===null));
 const finishing=run.finish(undefined,false);assert.equal(run.finish(undefined,true),finishing);
 assert.equal(run.finalizationTiming().status,'running');assert.equal(run.finalizationTiming().registeredMs,null);
 assert.equal(run.finalizationTiming().totalMs,null);
 registered.resolve();await cleanupEntered.promise;
 assert.equal(run.finalizationTiming().totalMs,null);assert.equal(run.finalizationTiming().cleanupMs,null);
 cleanup.resolve();const file=await finishing,timing=run.finalizationTiming();assertSettled(timing,'fulfilled');
 assert.equal(file?.metadata.recordState,'partial','fulfilled describes finalization settlement, not input completeness');
 assert.equal(previewDisposed,1);assert.equal(exactDisposed,1);assert.deepEqual(timing.failedStages,[]);
 assert.equal(Reflect.set(timing,'status','idle'),false);assert.equal(run.finalizationTiming().status,'fulfilled');
 assert.equal(idle.status,'idle');assert.equal(idle.registeredMs,null);assert.equal(idle.totalMs,null);
});

test('file prefix inspection overlaps cleanup and overall timing settles only after the returned file promise',async()=>{
 const prefixEntered=deferred(),prefixRelease=deferred(),cleanupEntered=deferred(),cleanupRelease=deferred();
 const blob=new Blob(entryParts({kind:'event',seq:1,time:0,type:'test',value:null})),slice=blob.slice.bind(blob);
 blob.slice=(...args)=>{const part=slice(...args),arrayBuffer=part.arrayBuffer.bind(part);
  part.arrayBuffer=async()=>{prefixEntered.resolve();await prefixRelease.promise;return arrayBuffer();};return part;};
 const h=storeHarness({exact:blob}),run=beginReproduction([],environment,{record:true,store:h.store});
 run.options.continuous!({blob:new Blob(),duration:0,async dispose(){cleanupEntered.resolve();await cleanupRelease.promise;}});
 const finishing=run.finish(undefined,false);
 let deadline:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([Promise.all([prefixEntered.promise,cleanupEntered.promise]),new Promise<never>((_resolve,reject)=>{
   deadline=setTimeout(()=>reject(Error('prefix and cleanup did not overlap')),1000);
  })]);clearTimeout(deadline);
  assert.equal(run.finalizationTiming().status,'running');assert.equal(run.finalizationTiming().totalMs,null);
  assert.equal(run.finalizationTiming().filePrefixMs,null);assert.equal(run.finalizationTiming().cleanupMs,null);
  cleanupRelease.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.ok(run.finalizationTiming().cleanupMs!==null);assert.equal(run.finalizationTiming().filePrefixMs,null);
  assert.equal(run.finalizationTiming().status,'running');assert.equal(run.finalizationTiming().totalMs,null);
  prefixRelease.resolve();const file=await finishing,timing=run.finalizationTiming();assertSettled(timing,'fulfilled');
  assert.equal(file?.metadata.exact?.events,1);assert.equal(file?.metadata.recordState,'partial');
  assert.ok(timing.filePrefixMs!==null);assert.ok(timing.cleanupMs!==null);assert.equal(timing.exactFinishMs,null);
 }finally{clearTimeout(deadline);cleanupRelease.resolve();prefixRelease.resolve();await finishing;}
});

test('failed stages preserve partial sealing, retry and nested cleanup rejection semantics',async()=>{
 const cleanupError=Error('preview cleanup failed');let sealCalls=0,exactDisposed=0;
 const h=storeHarness({seal(){if(++sealCalls===1)throw Error('seal failed');}}),run=beginReproduction([],environment,{record:true,
  store:h.store,exact:{async finish(){throw Error('producer finish failed');},async dispose(){exactDisposed++;}} as never});
 run.options.continuous!({blob:new Blob(['preview'],{type:'video/webm'}),duration:1,async dispose(){throw cleanupError;}});
 const finishing=run.finish(undefined,true);await assert.rejects(finishing,error=>error===cleanupError);
 assert.equal(run.finish(undefined,false),finishing);assert.equal(exactDisposed,1);assert.equal(sealCalls,2);
 assert.equal(h.stored.index.status,'partial');assert.equal(h.stored.index.reason,'Error: seal failed');
 const timing=run.finalizationTiming();assertSettled(timing,'rejected');
 assert.deepEqual(timing.failedStages,['exactFinish','seal','cleanup']);assert.ok(timing.sealMs!==null);
 assert.equal(timing.postSealLoadMs,null);assert.equal(timing.filePrefixMs,null);
});

test('exact and preview journal joins start together and expose immutable independent progress',async()=>{
 const exactEntered=deferred(),videoEntered=deferred(),exactRelease=deferred(),videoRelease=deferred(),h=storeHarness();
 const stats={enabled:true,complete:true,chunks:2,bytes:17,peakPendingBytes:9,error:''};
 const before={...stats,complete:false,mirror:{availableBytes:17,sentBytes:17,acknowledgedBytes:8,pendingBytes:9,
  peakPendingBytes:9,chunks:2,complete:false,error:''},firstErrorAtMs:0,mirrorObservedAtMs:12};
 const run=beginReproduction([],environment,{record:true,store:h.store,exact:{
  journalStats:before,async finish(){return undefined;},
  async finishJournal(){exactEntered.resolve();await exactRelease.promise;return {...stats};},async dispose(){},
 } as never});
 run.options.continuous!({blob:new Blob(['preview'],{type:'video/webm'}),duration:1,
  async finishJournal(){videoEntered.resolve();await videoRelease.promise;return {...stats};}});
 const finishing=run.finish(undefined,false);
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([Promise.all([exactEntered.promise,videoEntered.promise]),new Promise<never>((_yes,no)=>{
   timer=setTimeout(()=>no(Error('producer joins were serialized')),1000);
  })]);clearTimeout(timer);
  const active=run.finalizationTiming();
  assert.notEqual(active.producerJournals.exact.startedAtMs,null);assert.notEqual(active.producerJournals.video.startedAtMs,null);
  assert.equal(active.producerJournals.exact.finishedAtMs,null);assert.equal(active.producerJournals.video.finishedAtMs,null);
  assert.equal(active.producerJournals.exact.before?.firstErrorAtMs,0);
  assert.ok(Object.isFrozen(active.producerJournals.exact.before));assert.ok(Object.isFrozen(active.producerJournals.exact.before?.mirror));
  before.mirror.acknowledgedBytes=17;assert.equal(active.producerJournals.exact.before?.mirror?.acknowledgedBytes,8);
  videoRelease.resolve();await new Promise<void>(resolve=>setImmediate(resolve));
  const previewDone=run.finalizationTiming();assert.notEqual(previewDone.producerJournals.video.finishedAtMs,null);
  assert.equal(previewDone.producerJournals.exact.finishedAtMs,null);
  exactRelease.resolve();await finishing;
  const finished=run.finalizationTiming();assertSettled(finished,'fulfilled');
  for(const kind of ['exact','video'] as const){
   const join=finished.producerJournals[kind];assert.ok(join.finishedAtMs!>=join.startedAtMs!);assert.equal(join.after?.bytes,17);
  }
  assert.equal(active.producerJournals.video.finishedAtMs,null,'previous snapshots remain detached');
  assert.notEqual(finished.exactJournalJoinMs,null);assert.notEqual(finished.videoJournalJoinMs,null);
 }finally{clearTimeout(timer);exactRelease.resolve();videoRelease.resolve();await finishing;}
});
