import test from 'node:test';
import assert from 'node:assert/strict';
import {loadReplayOriginal} from '../dev/replay-original';
const signal=()=>new AbortController().signal;
test('replay download preserves chunk order without requiring a video MIME',async()=>{
 const request=(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));c.enqueue(new Uint8Array([3]));c.close();}}))) as typeof fetch;
 const blob=await loadReplayOriginal('/local',3,signal(),request);
 assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())],[1,2,3]);
});
test('replay downloader rejects short, oversized and cancelled inputs',async()=>{
 const request=(async()=>new Response(new Uint8Array([1,2]))) as typeof fetch;
 await assert.rejects(loadReplayOriginal('/local',3,signal(),request),/mismatch/);
 await assert.rejects(loadReplayOriginal('/local',1,signal(),request),/exceeds/);
 let fetched=false;const never=(async()=>{fetched=true;return new Response();}) as typeof fetch;
 await assert.rejects(loadReplayOriginal('/local',2e9,signal(),never),/Invalid/);
 const controller=new AbortController();controller.abort();
 await assert.rejects(loadReplayOriginal('/local',1,controller.signal,never),{name:'AbortError'});
 assert.equal(fetched,false);
});
