import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {hashBlobChunks,hashBlobListChunks} from '../src/features/card-scanner/reproduction/dev-blob-hash-core';
import {hashReplayBlob,hashBlobList} from '../src/features/card-scanner/reproduction/dev-blob-hash';
import {MAX_DEV_REPLAY_BYTES,MAX_DEV_HASH_BLOBS} from '../src/features/card-scanner/reproduction/dev-blob-hash-limits';

const signal=()=>new AbortController().signal;
const hex=(bytes:Uint8Array)=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
const data=(length:number)=>Uint8Array.from({length},(_,index)=>(index*37+index%13)&255);

test('incremental SHA-256 matches Node and WebCrypto across block and chunk boundaries',async()=>{
  for(const length of [0,1,55,56,63,64,65,1023,1024,1025,1024*1024-1,1024*1024,1024*1024+1,4*1024*1024+17]){
    const bytes=data(length),blob=new Blob([bytes]);
    const expected=createHash('sha256').update(bytes).digest('hex');
    assert.equal(await hashBlobChunks(blob,signal()),expected,`length ${length}`);
    if(length<=1025)assert.equal(hex(new Uint8Array(await webcrypto.subtle.digest('SHA-256',bytes))),expected);
  }
});

test('never requests an oversized slice and rejects invalid limits',async()=>{
  const blob=new Blob([data(2*1024*1024+13)]),original=blob.slice.bind(blob),sizes:number[]=[];
  Object.defineProperty(blob,'slice',{value:(start:number,end:number)=>{sizes.push(end-start);return original(start,end);}});
  await hashBlobChunks(blob,signal(),1024*1024);
  assert.deepEqual(sizes,[1024*1024,1024*1024,13]);
  for(const value of [0,-1,1.5,4*1024*1024+1])await assert.rejects(hashBlobChunks(blob,signal(),value));
  const huge=new Blob();Object.defineProperty(huge,'size',{value:MAX_DEV_REPLAY_BYTES+1});
  await assert.rejects(hashBlobChunks(huge,signal()),/크기/);
});

test('aborting while a Blob read is pending never returns a digest',async()=>{
  const blob=new Blob([data(50)]),original=blob.slice.bind(blob),controller=new AbortController();
  let resolveRead!:(value:ArrayBuffer)=>void;
  Object.defineProperty(blob,'slice',{value:(start:number,end:number)=>{
    const piece=original(start,end);
    Object.defineProperty(piece,'arrayBuffer',{value:()=>new Promise<ArrayBuffer>(resolve=>{resolveRead=resolve;})});
    return piece;
  }});
  const pending=hashBlobChunks(blob,controller.signal);
  controller.abort();resolveRead(new ArrayBuffer(50));
  await assert.rejects(pending);
});

class FakeWorker extends EventTarget {
  terminated=0;posted:unknown;throwPost=false;
  postMessage(value:unknown){if(this.throwPost)throw Error('post failed');this.posted=value;}
  terminate(){this.terminated++;}
  deliver(value:unknown){this.dispatchEvent(new MessageEvent('message',{data:value}));}
}

test('Worker client accepts only a valid matching receipt and terminates the Worker',async()=>{
  const blob=new Blob(['hello']),worker=new FakeWorker();
  const pending=hashReplayBlob(blob,signal(),{workerFactory:()=>worker as unknown as Worker});
  assert.equal(worker.posted,blob);
  const digest=createHash('sha256').update('hello').digest('hex');worker.deliver({ok:true,sha256:digest,bytes:blob.size});
  assert.equal(await pending,digest);assert.equal(worker.terminated,1);
  worker.deliver({ok:true,sha256:digest,bytes:blob.size});assert.equal(worker.terminated,1);
});

test('Worker cancellation, invalid results, errors, timeout and post failure never return a digest',async()=>{
  const blob=new Blob(['hello']);
  for(const scenario of ['abort','bad-hash','bad-bytes','error','messageerror','timeout','post'] as const){
    const worker=new FakeWorker(),controller=new AbortController();worker.throwPost=scenario==='post';
    const pending=hashReplayBlob(blob,controller.signal,{workerFactory:()=>worker as unknown as Worker,timeoutMs:scenario==='timeout'?1:1000});
    if(scenario==='abort')controller.abort();
    if(scenario==='bad-hash')worker.deliver({ok:true,sha256:'bad',bytes:blob.size});
    if(scenario==='bad-bytes')worker.deliver({ok:true,sha256:'0'.repeat(64),bytes:blob.size+1});
    if(scenario==='error'||scenario==='messageerror')worker.dispatchEvent(new Event(scenario));
    await assert.rejects(pending,undefined,scenario);assert.equal(worker.terminated,1,scenario);
  }
});

test('raw chunk hashes preserve order and bound each underlying Blob read',async()=>{
  const values=[data(1024*1024+3),data(17)],blobs=values.map(bytes=>new Blob([bytes]));
  const sizes:number[]=[];
  for(const blob of blobs){const original=blob.slice.bind(blob);
    Object.defineProperty(blob,'slice',{value:(start:number,end:number)=>{sizes.push(end-start);return original(start,end);}});}
  const digests=await hashBlobListChunks(blobs,signal());
  assert.deepEqual(digests,values.map(bytes=>createHash('sha256').update(bytes).digest('hex')));
  assert.deepEqual(sizes,[1024*1024,3,17]);
  assert.deepEqual(await hashBlobListChunks([],signal()),[]);
});

test('raw chunk Worker validates ordered receipts and never reads pixels on UI thread',async()=>{
  const blobs=[new Blob(['first']),new Blob(['second'])],worker=new FakeWorker();
  for(const blob of blobs)Object.defineProperty(blob,'arrayBuffer',{value:()=>{throw Error('UI read');}});
  const pending=hashBlobList(blobs,signal(),{workerFactory:()=>worker as unknown as Worker});
  assert.deepEqual(worker.posted,{kind:'list',blobs});
  const hashes=['first','second'].map(value=>createHash('sha256').update(value).digest('hex'));
  worker.deliver({ok:true,kind:'list',hashes,bytes:[5,6]});
  assert.deepEqual(await pending,hashes);assert.equal(worker.terminated,1);
  let madeWorker=false;
  assert.deepEqual(await hashBlobList([],signal(),{workerFactory:()=>{madeWorker=true;throw Error('unexpected');}}),[]);
  assert.equal(madeWorker,false);
});

test('raw chunk Worker fails closed for malformed receipts, resource limits and cancellation',async()=>{
  const blobs=[new Blob(['first']),new Blob(['second'])];
  for(const scenario of ['abort','count','hash','bytes','error','messageerror','timeout','post'] as const){
    const worker=new FakeWorker(),controller=new AbortController();worker.throwPost=scenario==='post';
    const pending=hashBlobList(blobs,controller.signal,{workerFactory:()=>worker as unknown as Worker,timeoutMs:scenario==='timeout'?1:1000});
    const hashes=['a'.repeat(64),'b'.repeat(64)];
    if(scenario==='abort')controller.abort();
    if(scenario==='count')worker.deliver({ok:true,kind:'list',hashes:[hashes[0]],bytes:[5,6]});
    if(scenario==='hash')worker.deliver({ok:true,kind:'list',hashes:['bad',hashes[1]],bytes:[5,6]});
    if(scenario==='bytes')worker.deliver({ok:true,kind:'list',hashes,bytes:[6,5]});
    if(scenario==='error'||scenario==='messageerror')worker.dispatchEvent(new Event(scenario));
    await assert.rejects(pending,undefined,scenario);assert.equal(worker.terminated,1,scenario);
  }
  const tooBig=new Blob();Object.defineProperty(tooBig,'size',{value:4*1024*1024+1});
  await assert.rejects(hashBlobList([tooBig],signal()));
  const full=new Blob();Object.defineProperty(full,'size',{value:4*1024*1024});
  await assert.rejects(hashBlobList(Array(129).fill(full),signal()));
  await assert.rejects(hashBlobList([new Blob()],signal()));
  await assert.rejects(hashBlobList(Array(MAX_DEV_HASH_BLOBS+1).fill(blobs[0]),signal()));
  const controller=new AbortController();controller.abort();
  assert.throws(()=>hashBlobList([],controller.signal));
});
