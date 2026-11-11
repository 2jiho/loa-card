import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {archiveReplayLocally,archiveRawLocally,archivePendingReplaySessions} from '../src/features/card-scanner/reproduction/dev-replay-archive';
import type {ReproductionFile} from '../src/features/card-scanner/reproduction/scan-reproduction';

const sample=():ReproductionFile=>({video:new Blob(['video']),metadata:{version:1,createdAt:'2026-10-01',browser:'test',catalog:'test',build:'test',
 completed:true,warnings:[],duration:2,type:'video/webm',bytes:5,seed:[],result:null}});
const digest='a'.repeat(64),caseId=createHash('sha256').update(JSON.stringify({version:1,kind:'replay',inputs:[digest]})).digest('hex');
const hash=async()=>digest;
const reply=(bytes:number,changes:Record<string,unknown>={})=>new Response(JSON.stringify({created:true,caseId,
 input:{sha256:digest,bytes},recordedCoverage:'unknown',...changes}),{status:201});

test('archives a sealed replay only to the local development endpoint',async()=>{
 let sent:Blob|undefined;
 const send:typeof fetch=async(url,options)=>{
  assert.equal(url,'/__corpus/replay');assert.equal(options?.method,'POST');assert.equal(options?.redirect,'error');
  assert.equal(options?.credentials,'same-origin');assert.equal((options?.headers as Record<string,string>)['Content-Type'],'application/octet-stream');
  assert.ok(options?.body instanceof Blob);sent=options.body;return reply(sent.size);
 };
 const result=await archiveReplayLocally(sample(),{send,hash});
 assert.equal(result.caseId,caseId);assert.equal(result.input.bytes,sent?.size);assert.equal(result.recordedCoverage,'unknown');
});

test('rejects failed, malformed or inconsistent archive receipts',async()=>{
 for(const send of [
  async()=>new Response('',{status:503}),
  async(_url:unknown,options?:RequestInit)=>reply((options!.body as Blob).size+1),
  async(_url:unknown,options?:RequestInit)=>reply((options!.body as Blob).size,{recordedCoverage:'declared-complete'}),
  async(_url:unknown,options?:RequestInit)=>reply((options!.body as Blob).size,{input:{sha256:'c'.repeat(64),bytes:(options!.body as Blob).size}}),
  async(_url:unknown,options?:RequestInit)=>reply((options!.body as Blob).size,{caseId:'not-a-hash'}),
  async(_url:unknown,options?:RequestInit)=>reply((options!.body as Blob).size,{caseId:'b'.repeat(64)}),
 ] satisfies Array<typeof fetch>)await assert.rejects(archiveReplayLocally(sample(),{send,hash}));
});

test('raw receipt must identify the raw case derived from its exact uploaded bytes',async()=>{
 const chunk=new Blob(['x']),chunkHash=createHash('sha256').update('x').digest('hex');
 const snapshot={index:{version:1 as const,id:'raw',createdAt:'2026-10-30T00:00:00.000Z',updatedAt:'2026-10-30T00:00:00.000Z',
  environment:{browser:'test',catalog:'test',build:'test'},record:true,status:'partial' as const,sealed:true,pinned:false,ownerId:'owner',leaseUntil:null,
  bytes:1,detailsBytes:0,chunkCounts:{video:0,exact:1},chunkBytes:{video:0,exact:1},hasInput:true,read:null,expected:null,cards:null,
  generation:'g',archiveRevision:'r',archive:{state:'pending' as const}},chunks:[{kind:'exact' as const,seq:0,bytes:1,sha256:chunkHash,blob:chunk}]};
 const rawCase=createHash('sha256').update(JSON.stringify({version:1,kind:'raw-session',inputs:[digest]})).digest('hex');
 const send=(id:string):typeof fetch=>async(_url,options)=>reply((options!.body as Blob).size,{caseId:id,recordedCoverage:'partial'});
 await assert.rejects(archiveRawLocally(snapshot,{send:send(caseId),hash,hashChunks:async()=>[chunkHash]}));
 const accepted=await archiveRawLocally(snapshot,{send:send(rawCase),hash,hashChunks:async()=>[chunkHash]});assert.equal(accepted.caseId,rawCase);
});

test('does not transmit an aborted or invalid replay',async()=>{
 const controller=new AbortController();controller.abort();let sent=false;
 const send:typeof fetch=async()=>{sent=true;throw Error('unexpected');};
 await assert.rejects(archiveReplayLocally(sample(),{send,hash,signal:controller.signal}));
 const bad=sample();bad.metadata.bytes=99;
 await assert.rejects(archiveReplayLocally(bad,{send,hash}));assert.equal(sent,false);
 await assert.rejects(archiveReplayLocally(sample(),{send,hash:async()=>{throw Error('hash failed');}}));
 assert.equal(sent,false,'a failed source hash must not transmit or acknowledge');
});

test('retries protected sealed sessions in order and acknowledges only successful uploads',async()=>{
 const entries=[{id:'one',archive:{state:'pending'},status:'partial',hasInput:true},
  {id:'two',archive:{state:'pending'},status:'complete',hasInput:true},
  {id:'already',archive:{state:'stored',coverage:'declared-complete',exactVerified:true},status:'complete',hasInput:true},
  {id:'open',archive:{state:'pending'},status:'open',hasInput:true}];
 const events:string[]=[],acks:string[]=[];
 const dependencies={list:async()=>entries,load:async(id:string)=>({file:sample(),raw:{index:{id},chunks:[]},generation:'gen',revision:id}),
  upload:async(file:ReproductionFile)=>({created:true,caseId,input:{sha256:digest,bytes:5},recordedCoverage:'unknown'}),
  uploadRaw:async()=>({created:true,caseId,input:{sha256:digest,bytes:7},recordedCoverage:'partial'}),
  acknowledge:async(id:string)=>{acks.push(id);return {archive:{state:'stored',coverage:'unknown'}};}};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(`${event.id}:${event.state}`),dependencies as never);
 assert.deepEqual(acks,['one','two']);assert.deepEqual(events,['one:saving','one:stored','two:saving','two:stored','open:waiting']);
});

test('failed or interrupted transfers never acknowledge protected sessions',async()=>{
 const entries=[{id:'one',archive:{state:'pending'},status:'complete',hasInput:true},
  {id:'two',archive:{state:'pending'},status:'complete',hasInput:true}];
 const controller=new AbortController(),events:string[]=[],acks:string[]=[];let loads=0;
 const dependencies={list:async()=>entries,load:async()=>{loads++;return {file:sample(),generation:'gen',revision:'rev'};},
  upload:async()=>{controller.abort();throw Error('aborted');},acknowledge:async(id:string)=>{acks.push(id);}};
 await assert.rejects(archivePendingReplaySessions(controller.signal,event=>events.push(`${event.id}:${event.state}`),dependencies as never));
 assert.equal(loads,1);assert.deepEqual(acks,[]);assert.deepEqual(events,['one:saving']);
});

test('one failed archive remains protected while later sessions are still attempted',async()=>{
 const entries=[{id:'one',archive:{state:'pending'},status:'partial',hasInput:true},
  {id:'two',archive:{state:'pending'},status:'complete',hasInput:true}];
 const events:string[]=[],acks:string[]=[];let uploads=0;
 const dependencies={list:async()=>entries,load:async(id:string)=>({file:sample(),raw:{index:{id},chunks:[]},generation:'gen',revision:id}),
  upload:async()=>{if(++uploads===1)throw Error('local archive unavailable');
   return {created:true,caseId,input:{sha256:digest,bytes:5},recordedCoverage:'unknown'};},
  uploadRaw:async()=>({created:true,caseId,input:{sha256:digest,bytes:7},recordedCoverage:'partial'}),
  acknowledge:async(id:string)=>{acks.push(id);return {archive:{state:'stored',coverage:'unknown'}};}};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(`${event.id}:${event.state}`),dependencies as never);
 assert.deepEqual(acks,['two']);assert.deepEqual(events,['one:saving','one:failed','two:saving','two:stored']);
});

test('reports the protection store coverage rather than the uploaded bundle declaration',async()=>{
 const entries=[{id:'one',archive:{state:'pending'},status:'partial',hasInput:true}];
 const events:Array<{state:string;coverage?:string}>=[];
 const dependencies={list:async()=>entries,load:async()=>({file:sample(),raw:{index:{id:'one'},chunks:[]},generation:'gen',revision:'rev'}),
  upload:async()=>({created:true,caseId,input:{sha256:digest,bytes:5},recordedCoverage:'declared-complete'}),
  uploadRaw:async()=>({created:true,caseId,input:{sha256:digest,bytes:7},recordedCoverage:'partial'}),
  acknowledge:async()=>({archive:{state:'stored',coverage:'partial'}})};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event),dependencies as never);
 assert.deepEqual(events.map(({state,coverage})=>({state,coverage})),[
  {state:'saving',coverage:undefined},{state:'stored',coverage:'partial'},
 ]);
});

test('an open protected session schedules a later check; a sealed session without input is explicit',async()=>{
 const entries=[{id:'lease',archive:{state:'pending'},status:'open',hasInput:false},
  {id:'empty',archive:{state:'pending'},status:'failed',hasInput:false}];
 const events:string[]=[];
 const dependencies={list:async()=>entries,load:async()=>{throw Error('must not load');},
  upload:async()=>{throw Error('must not upload');},acknowledge:async()=>{throw Error('must not acknowledge');}};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(`${event.id}:${event.state}`),dependencies as never);
 assert.deepEqual(events,['lease:waiting','empty:unavailable']);
});

test('partial session archives replay and all raw bytes before acknowledging the sealed revision',async()=>{
 const events:string[]=[],acks:unknown[]=[];
 const raw={index:{id:'one'},chunks:[]},replayCase='c'.repeat(64);
 const deps={list:async()=>[{id:'one',archive:{state:'pending'},status:'partial',hasInput:true}],
  load:async()=>({file:sample(),raw,generation:'generation',revision:'revision'}),
  upload:async()=>{events.push('replay');return {created:true,caseId:replayCase,input:{sha256:digest,bytes:5},recordedCoverage:'partial'};},
  uploadRaw:async(snapshot:{replayCaseId?:string})=>{events.push('raw');assert.equal(snapshot.replayCaseId,replayCase);
   return {created:true,caseId,input:{sha256:digest,bytes:7},recordedCoverage:'partial'};},
  acknowledge:async(_id:string,revision:unknown,receipt:unknown)=>{events.push('ack');acks.push(revision,receipt);
   return {archive:{state:'stored',coverage:'partial'}};}};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),deps as never);
 assert.deepEqual(events,['saving','replay','raw','ack','stored']);
 assert.deepEqual(acks,[{generation:'generation',revision:'revision'},
  {kind:'raw-session',caseId,sha256:digest,bytes:7,replayCaseId:replayCase}]);
});

test('unplayable partial is retained as raw only; errors and interrupted uploads never acknowledge',async()=>{
 const raw={index:{id:'one'},chunks:[]},events:string[]=[];let acks=0;
 const deps={list:async()=>[{id:'one',archive:{state:'pending'},status:'failed',hasInput:true}],
  load:async()=>({raw,generation:'generation',revision:'revision'}),upload:async()=>{throw Error('unexpected replay');},
  uploadRaw:async()=>({created:true,caseId,input:{sha256:digest,bytes:7},recordedCoverage:'partial'}),
  acknowledge:async()=>{acks++;return {archive:{state:'stored',coverage:'partial'}};}};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(`${event.state}:${event.storage??''}`),deps as never);
 assert.equal(acks,1);assert.deepEqual(events,['saving:','stored:raw']);
 deps.acknowledge=async()=>{acks++;return {archive:{state:'stored',coverage:'partial'}};};
 const broken={...deps,load:async()=>({file:sample(),raw,generation:'generation',revision:'revision'}),
  upload:async()=>{throw Error('replay failed');},uploadRaw:async()=>{events.push('raw saved');return {created:true,caseId,input:{sha256:digest,bytes:7},recordedCoverage:'partial'};}};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),broken as never);
 assert.equal(acks,1);assert.deepEqual(events.slice(-3),['saving','raw saved','failed']);
 const cancelled=new AbortController();
 const interrupted={...broken,upload:async()=>{cancelled.abort();throw Error('cancelled');},uploadRaw:async()=>{throw Error('unexpected raw');}};
 await assert.rejects(archivePendingReplaySessions(cancelled.signal,()=>{},interrupted as never));assert.equal(acks,1);
});

test('older protected replay-only receipts upgrade only after the same replay case is reverified',async()=>{
 const raw={index:{id:'old'},chunks:[]},events:string[]=[];let acks=0,matched=true;
 const deps={list:async()=>[{id:'old',archive:{state:'stored',caseId,coverage:'partial'},status:'partial',hasInput:true}],
  load:async()=>({file:sample(),raw,generation:'g',revision:'r'}),
  upload:async()=>({created:false,caseId:matched?caseId:'c'.repeat(64),input:{sha256:digest,bytes:5},recordedCoverage:'partial'}),
  uploadRaw:async()=>{events.push('raw');return {created:true,caseId:'d'.repeat(64),input:{sha256:digest,bytes:7},recordedCoverage:'partial'};},
  acknowledge:async(_id:string,_revision:unknown,receipt:{replayCaseId:string})=>{acks++;assert.equal(receipt.replayCaseId,caseId);
   return {archive:{state:'stored',coverage:'partial'}};}};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),deps as never);
 assert.equal(acks,1);assert.deepEqual(events,['saving','raw','stored']);
 matched=false;events.length=0;
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),deps as never);
 assert.equal(acks,1);assert.deepEqual(events,['saving','raw','failed']);
});

test('metadata-only legacy complete receipt is rechecked and preserved raw if validation fails',async()=>{
 const file=sample();file.metadata.recordState='complete';file.metadata.exact={bytes:5,frames:1,events:0,dropped:0,
  peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:''};file.exact=new Blob(['exact']);
 const events:string[]=[];let acknowledged:unknown;
 const deps={list:async()=>[{id:'legacy',archive:{state:'stored',caseId,coverage:'declared-complete'},status:'complete',hasInput:true}],
  load:async()=>({file,snapshot:{index:{id:'legacy'},chunks:[]},generation:'g',revision:'r'}),
  validateExact:async()=>false,
  upload:async()=>({created:false,caseId,input:{sha256:digest,bytes:5},recordedCoverage:'declared-complete'}),
  uploadRaw:async(snapshot:{replayCaseId?:string})=>{assert.equal(snapshot.replayCaseId,caseId);events.push('raw');
   return {created:true,caseId:'d'.repeat(64),input:{sha256:digest,bytes:7},recordedCoverage:'partial'};},
  acknowledge:async(_id:string,_expected:unknown,receipt:unknown)=>{acknowledged=receipt;return {archive:{state:'stored',coverage:'unknown'}};}};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),deps as never);
 assert.deepEqual(events,['saving','raw','stored']);
 assert.deepEqual(acknowledged,{kind:'raw-session',caseId:'d'.repeat(64),sha256:digest,bytes:7,replayCaseId:caseId});
});

test('an exact verification timeout preserves raw bytes without treating them as verified',async()=>{
 const file=sample();file.metadata.recordState='complete';file.metadata.exact={bytes:5,frames:1,events:0,dropped:0,
  peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:''};file.exact=new Blob(['exact']);
 const events:string[]=[];let verifierAborted=false,acknowledged:unknown;
 const deps={exactTimeoutMs:10,list:async()=>[{id:'slow',archive:{state:'pending'},status:'complete',hasInput:true}],
  load:async()=>({file,snapshot:{index:{id:'slow'},chunks:[]},generation:'g',revision:'r'}),
  validateExact:async(_file:ReproductionFile,signal:AbortSignal)=>new Promise<boolean>((_resolve,reject)=>{
   signal.addEventListener('abort',()=>{verifierAborted=true;reject(signal.reason);},{once:true});
  }),
  upload:async()=>({created:true,caseId,input:{sha256:digest,bytes:5},recordedCoverage:'declared-complete'}),
  uploadRaw:async()=>{events.push('raw');return {created:true,caseId:'d'.repeat(64),input:{sha256:digest,bytes:7},recordedCoverage:'partial'};},
  acknowledge:async(_id:string,_expected:unknown,receipt:unknown)=>{acknowledged=receipt;return {archive:{state:'stored',coverage:'unknown'}};}};
 await Promise.all([archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),deps as never),
  new Promise(resolve=>setTimeout(resolve,30))]);
 assert.equal(verifierAborted,true);assert.deepEqual(events,['saving','raw','stored']);
 assert.deepEqual(acknowledged,{kind:'raw-session',caseId:'d'.repeat(64),sha256:digest,bytes:7,replayCaseId:caseId});
});

test('a failed raw upload cannot acknowledge a successful replay prefix',async()=>{
 let acks=0;const events:string[]=[];
 const deps={list:async()=>[{id:'one',archive:{state:'pending'},status:'partial',hasInput:true}],
  load:async()=>({file:sample(),raw:{index:{id:'one'},chunks:[]},generation:'g',revision:'r'}),
  upload:async()=>({created:true,caseId,input:{sha256:digest,bytes:5},recordedCoverage:'partial'}),
  uploadRaw:async()=>{throw Error('raw archive unavailable');},acknowledge:async()=>{acks++;}};
 await archivePendingReplaySessions(new AbortController().signal,event=>events.push(event.state),deps as never);
 assert.equal(acks,0);assert.deepEqual(events,['saving','failed']);
});
