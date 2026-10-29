import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {RunStateCompression,RUN_STATE_COMPRESSION_LIMITS} from '../dev/run-state-compression';
import type {RunStateCompressionWorker} from '../dev/run-state-compression';
import {createRunStateCompressionRuntime,parseRunStateCompressionRequest,parseRunStateCompressionResponse} from '../dev/run-state-compression-worker';
import type {RunStateCompressionRequest,RunStateCompressionResponse} from '../dev/run-state-compression-worker';

const tick=()=>new Promise<void>(resolve=>queueMicrotask(resolve));
const raw=(text:string)=>new TextEncoder().encode(text);
const buffer=(bytes:Uint8Array)=>Uint8Array.from(bytes).buffer;
class FakeWorker implements RunStateCompressionWorker {
 onmessage:Worker['onmessage']=null;onerror:Worker['onerror']=null;onmessageerror:Worker['onmessageerror']=null;
 requests:RunStateCompressionRequest[]=[];terminations=0;
 postMessage(value:unknown){this.requests.push(parseRunStateCompressionRequest(value));}
 terminate(){this.terminations++;}
 reply(output?:ArrayBuffer){
  const request=this.requests.at(-1)!;
  this.onmessage?.({data:{version:1,id:request.id,rawBytes:request.rawBytes,
   output:output??buffer(gzipSync(new Uint8Array(request.raw)))}} as MessageEvent);
 }
}
function workers(options:{deadlineMs?:number;idleMs?:number}={}){
 const created:FakeWorker[]=[];
 const compression=new RunStateCompression({...options,createWorker:()=>{const worker=new FakeWorker();created.push(worker);return worker;}});
 return {created,compression};
}

test('two Worker lanes start after synchronous capture and allow out-of-order completion',async()=>{
 const {compression,created}=workers();
 try{
  const first=compression.compress('first',5,1000),second=compression.compress('second',6,1000),third=compression.compress('third',5,1000);
  assert.equal(created.length,0,'Worker setup and encoding are deferred from record()');await tick();
  assert.equal(created.length,2);assert.equal(compression.stats.active,2);assert.equal(compression.stats.pendingBytes,16);
  created[1].reply();assert.equal(gunzipSync(await second).toString(),'second');await tick();
  assert.equal(created.length,2,'a free lane reuses its Worker');assert.equal(created[1].requests.length,2);
  assert.equal(compression.stats.active,2);assert.equal(compression.stats.pendingBytes,10);
  created[1].reply();assert.equal(gunzipSync(await third).toString(),'third');
  created[0].reply();assert.equal(gunzipSync(await first).toString(),'first');
  assert.equal(compression.stats.pendingBytes,0);assert.equal(compression.stats.peakActive,2);
 }finally{compression.dispose();}
 assert.ok(created.every(worker=>worker.terminations===1));
});

test('pending input stays charged in active Workers and cannot exceed two MiB',async()=>{
 const {compression,created}=workers(),text='x'.repeat(RUN_STATE_COMPRESSION_LIMITS.pendingBytes/2);
 try{
  const first=compression.compress(text,text.length,1000),second=compression.compress(text,text.length,1000);
  await assert.rejects(compression.compress('x',1,1000),/대기 한도/);await tick();
  assert.equal(compression.stats.pendingBytes,RUN_STATE_COMPRESSION_LIMITS.pendingBytes);
  assert.equal(compression.stats.peakPendingBytes,RUN_STATE_COMPRESSION_LIMITS.pendingBytes);
  created[0].reply(new ArrayBuffer(1));created[1].reply(new ArrayBuffer(1));await Promise.all([first,second]);
  assert.equal(compression.stats.pendingBytes,0);
 }finally{compression.dispose();}
});

test('strict response ownership rejects mismatched IDs, bytes, extra fields and oversized output',async()=>{
 for(const mutate of [
  (value:Record<string,unknown>)=>({...value,id:(value.id as number)+1}),
  (value:Record<string,unknown>)=>({...value,rawBytes:2}),
  (value:Record<string,unknown>)=>({...value,output:new ArrayBuffer(101)}),
  (value:Record<string,unknown>)=>({...value,extra:true}),
  (value:Record<string,unknown>)=>({...value,output:new Uint8Array(1)}),
 ]){
  const {compression,created}=workers();
  try{
   const result=compression.compress('a',1,100);await tick();const request=created[0].requests[0];
   created[0].onmessage?.({data:mutate({version:1,id:request.id,rawBytes:1,output:new ArrayBuffer(1)})} as MessageEvent);
   await assert.rejects(result,/압축 응답/);assert.equal(created[0].terminations,1);assert.equal(compression.stats.pendingBytes,0);
  }finally{compression.dispose();}
 }
});

test('Worker failure revokes ownership before replacement and ignores late replies',async()=>{
 const {compression,created}=workers();
 try{
  const first=compression.compress('a',1,100),second=compression.compress('b',1,100),third=compression.compress('c',1,100);
  await tick();const stale=created[0].onmessage!,request=created[0].requests[0];
  created[0].onerror?.({} as ErrorEvent);await assert.rejects(first,/Worker 실패/);await tick();
  assert.equal(created.length,3);assert.equal(created[0].terminations,1);
  stale({data:{version:1,id:request.id,rawBytes:1,output:new ArrayBuffer(1)}} as MessageEvent);
  assert.equal(compression.stats.active,2);assert.equal(compression.stats.pendingBytes,2);
  created[2].reply();created[1].reply();await Promise.all([second,third]);
  assert.equal(compression.stats.pendingBytes,0);
 }finally{compression.dispose();}
});

test('deadline and dispose settle outstanding jobs, terminate Workers and ignore late completion',async()=>{
 const timed=workers({deadlineMs:10});
 try{
  const jobs=[timed.compression.compress('a',1,100),timed.compression.compress('b',1,100),timed.compression.compress('c',1,100)];
  await Promise.all(jobs.map(job=>assert.rejects(job,/時間|시간 한도/)));
  assert.equal(timed.compression.stats.pendingBytes,0);assert.ok(timed.created.every(worker=>worker.terminations===1));
 }finally{timed.compression.dispose();}
 const {compression,created}=workers();
 const jobs=[compression.compress('a',1,100),compression.compress('b',1,100),compression.compress('c',1,100)];
 const rejected=jobs.map(job=>assert.rejects(job,/압축 종료/));await tick();const stale=created[0].onmessage!;
 compression.dispose();compression.dispose();await Promise.all(rejected);
 stale({data:{version:1,id:1,rawBytes:1,output:new ArrayBuffer(1)}} as MessageEvent);
 assert.equal(compression.stats.pendingBytes,0);assert.equal(compression.stats.active,0);assert.ok(created.every(worker=>worker.terminations===1));
 await assert.rejects(compression.compress('d',1,100),/종료/);
});

test('idle Workers terminate and later snapshots can start fresh lanes',async()=>{
 const {compression,created}=workers({idleMs:10});
 try{
  const first=compression.compress('a',1,100);await tick();created[0].reply();await first;
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(created[0].terminations,1);
  const second=compression.compress('b',1,100);await tick();assert.equal(created.length,2);created[1].reply();await second;
 }finally{compression.dispose();}
});

test('no-Worker native gzip uses two bounded lanes and checks late cancellation',async()=>{
 const pending:{raw:Uint8Array<ArrayBuffer>;signal:AbortSignal;resolve:(value:Uint8Array<ArrayBuffer>)=>void}[]=[];
 const compression=new RunStateCompression({nativeGzip:(bytes,_limit,signal)=>new Promise(resolve=>pending.push({raw:bytes,signal,resolve}))});
 const jobs=['a','b','c'].map(text=>compression.compress(text,1,100));await tick();
 assert.equal(pending.length,2);assert.equal(compression.stats.peakActive,2);
 pending[1].resolve(Uint8Array.from([2]));assert.deepEqual(await jobs[1],Uint8Array.from([2]));await tick();assert.equal(pending.length,3);
 const rejected=[assert.rejects(jobs[0],/압축 종료/),assert.rejects(jobs[2],/압축 종료/)];compression.dispose();await Promise.all(rejected);
 assert.ok(pending.every(job=>job.signal.aborted));pending[0].resolve(Uint8Array.from([1]));pending[2].resolve(Uint8Array.from([3]));await tick();
 assert.equal(compression.stats.pendingBytes,0);assert.equal(compression.stats.active,0);
});

test('Worker runtime validates wire bounds and produces gzip without source payload retention',async()=>{
 const messages:RunStateCompressionResponse[]=[];
 const runtime=createRunStateCompressionRuntime({postMessage:message=>messages.push(message)});
 const bytes=raw('bounded source'),request={version:1 as const,id:1,rawBytes:bytes.byteLength,limit:1000,raw:bytes.buffer};
 await runtime.handle(request);assert.equal(messages.length,1);
 const output=parseRunStateCompressionResponse(messages[0],1,bytes.byteLength,1000);
 assert.equal(gunzipSync(output).toString(),'bounded source');await assert.rejects(runtime.handle(request),/작업 순서/);
 for(const value of [{...request,extra:true},{...request,rawBytes:1},{...request,raw:new Uint8Array(1)},
  {...request,rawBytes:RUN_STATE_COMPRESSION_LIMITS.pendingBytes+1},{...request,limit:RUN_STATE_COMPRESSION_LIMITS.outputBytes+1}])
  await assert.rejects(runtime.handle(value),/압축 요청/);
 const failed:RunStateCompressionResponse[]=[];
 await createRunStateCompressionRuntime({postMessage:value=>failed.push(value)}).handle({...request,limit:1});
 assert.deepEqual(failed,[{version:1,id:1,rawBytes:bytes.byteLength,error:'compression-failed'}]);
});
