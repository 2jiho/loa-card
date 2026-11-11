import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadVerifiedReplayOriginal} from '../dev/replay-original';
import {hashReplayOriginal} from '../dev/replay-original-hash';
import {hashReplayOriginalChunks,MAX_REPLAY_ORIGINAL_BYTES} from '../dev/replay-original-hash-core';

const bytes=new Uint8Array([1,2,3,4]);
const digest=createHash('sha256').update(bytes).digest('hex');
const signal=()=>new AbortController().signal;
const requestFor=(value:Uint8Array)=>(async()=>new Response(value)) as typeof fetch;
const actualHash=(blob:Blob,s:AbortSignal)=>hashReplayOriginalChunks(blob,s);

test('verified replay preserves the same downloaded bytes and rejects equal-length mutation',async()=>{
 const blob=await loadVerifiedReplayOriginal('/case',bytes.length,digest,signal(),{request:requestFor(bytes),hash:actualHash});
 assert.deepEqual(new Uint8Array(await blob.arrayBuffer()),bytes);
 await assert.rejects(loadVerifiedReplayOriginal('/case',bytes.length,digest,signal(),
  {request:requestFor(new Uint8Array([1,2,3,5])),hash:actualHash}),/SHA-256/);
});
test('bad digest, length and abort fail before a replay can be parsed',async()=>{
 let fetched=false,hashed=false;
 const request=(async()=>{fetched=true;return new Response(bytes);}) as typeof fetch;
 const hash=async()=>{hashed=true;return digest;};
 await assert.rejects(loadVerifiedReplayOriginal('/case',4,'bad',signal(),{request,hash}),/SHA-256/);
 assert.equal(fetched,false);assert.equal(hashed,false);
 await assert.rejects(loadVerifiedReplayOriginal('/case',5,digest,signal(),{request,hash}),/mismatch/);
 assert.equal(hashed,false);
 const c=new AbortController();c.abort();fetched=false;
 await assert.rejects(loadVerifiedReplayOriginal('/case',4,digest,c.signal,{request,hash}),{name:'AbortError'});
 assert.equal(fetched,false);
});
test('hashing failure or abort after download never returns the downloaded Blob',async()=>{
 const controller=new AbortController();
 await assert.rejects(loadVerifiedReplayOriginal('/case',4,digest,controller.signal,{request:requestFor(bytes),
  hash:async()=>{controller.abort();return digest;}}),{name:'AbortError'});
 await assert.rejects(loadVerifiedReplayOriginal('/case',4,digest,signal(),{request:requestFor(bytes),
  hash:async()=>{throw Error('worker failure');}}),/worker failure/);
});
test('real incremental core hashes more than one slice in order',async()=>{
 const data=new Uint8Array(1024*1024+11);data[0]=9;data[data.length-1]=7;
 const seen:number[]=[];
 const value=await hashReplayOriginalChunks(new Blob([data]),signal(),p=>seen.push(p));
 assert.equal(value,createHash('sha256').update(data).digest('hex'));
 assert.deepEqual(seen,[data.length]);
});

class FakeWorker extends EventTarget {
 terminated=false;posted:unknown;
 postMessage(value:unknown){this.posted=value;}
 terminate(){this.terminated=true;}
 reply(value:unknown){this.dispatchEvent(new MessageEvent('message',{data:value}));}
 fail(){this.dispatchEvent(new Event('error'));}
}
test('worker hash validates replies, emits progress and closes on success',async()=>{
 const worker=new FakeWorker(),progress:number[]=[];
 const blob=new Blob([bytes]);const task=hashReplayOriginal(blob,signal(),{workerFactory:()=>worker,onProgress:p=>progress.push(p)});
 worker.reply({kind:'progress',bytes:4});worker.reply({kind:'done',bytes:4,sha256:digest});
 assert.equal(await task,digest);assert.deepEqual(progress,[4]);assert.equal(worker.posted,blob);assert.equal(worker.terminated,true);
});
test('worker error, malformed message, cancellation and timeout all terminate and reject',async()=>{
 for(const mode of ['error','bad','abort','timeout'] as const){
  const worker=new FakeWorker(),controller=new AbortController();
  const task=hashReplayOriginal(new Blob([bytes]),controller.signal,{workerFactory:()=>worker,timeoutMs:10});
  if(mode==='error')worker.fail();else if(mode==='bad')worker.reply({kind:'done',bytes:4,sha256:'wrong'});else if(mode==='abort')controller.abort();
  await assert.rejects(task);assert.equal(worker.terminated,true);
 }
});
test('worker cannot claim invalid progress or incorrect output byte length',async()=>{
 for(const reply of [{kind:'progress',bytes:5},{kind:'progress',bytes:0},{kind:'done',bytes:3,sha256:digest}]){
  const worker=new FakeWorker(),task=hashReplayOriginal(new Blob([bytes]),signal(),{workerFactory:()=>worker});
  worker.reply(reply);await assert.rejects(task);assert.equal(worker.terminated,true);
 }
 const controller=new AbortController();controller.abort();let created=false;
 assert.throws(()=>hashReplayOriginal(new Blob([bytes]),controller.signal,{workerFactory:()=>{created=true;return new FakeWorker();}}),{name:'AbortError'});
 assert.equal(created,false);
});
test('worker policy retains the old 1296 MiB bound rather than 544 MiB',async()=>{
 const makeSized=(size:number)=>{const blob=new Blob([bytes]);Object.defineProperty(blob,'size',{value:size});return blob;};
 const worker=new FakeWorker(),size=MAX_REPLAY_ORIGINAL_BYTES;
 const task=hashReplayOriginal(makeSized(size),signal(),{workerFactory:()=>worker});
 worker.reply({kind:'done',bytes:size,sha256:digest});assert.equal(await task,digest);
 let created=false;
 await assert.rejects(hashReplayOriginal(makeSized(size+1),signal(),{workerFactory:()=>{created=true;return new FakeWorker();}}),/length/);
 assert.equal(created,false);
});
