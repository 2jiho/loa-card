import test from 'node:test';
import assert from 'node:assert/strict';
import {loadComparisonOriginal,MAX_COMPARISON_SOURCE_BYTES} from '../dev/comparison-original';
import {pixelHash} from '../src/features/card-scanner/exact-recording-codec';

test('comparison source verifies the exact bounded original, preserving its bytes and type',async()=>{
 const bytes=new Uint8Array([0,1,2,255]),sha256=await pixelHash(bytes);
 const request:typeof fetch=async(_url,options)=>{assert.equal(options?.cache,'no-store');return new Response(bytes);};
 const result=await loadComparisonOriginal('/source',{bytes:4,type:'video/mp4',sha256},new AbortController().signal,request);
 assert.deepEqual(result.verified,{bytes:4,sha256});assert.equal(result.blob.type,'video/mp4');
 assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()),bytes);
 await assert.rejects(loadComparisonOriginal('/source',{bytes:4,type:'video/mp4',sha256:'0'.repeat(64)},new AbortController().signal,request),/SHA-256/);
});
test('invalid source metadata and pre-aborted requests never start a fetch',async()=>{
 let requested=0;const request:typeof fetch=async()=>{requested++;throw Error('must not fetch');};
 for(const value of [{bytes:0,type:'video/mp4'},{bytes:MAX_COMPARISON_SOURCE_BYTES+1,type:'video/mp4'},{bytes:1.1,type:'video/mp4'},
  {bytes:1,type:'text/plain'},{bytes:1,type:'video/mp4',sha256:'bad'}])await assert.rejects(loadComparisonOriginal('/source',value,new AbortController().signal,request));
 const controller=new AbortController();controller.abort();await assert.rejects(loadComparisonOriginal('/source',{bytes:1,type:'video/mp4'},controller.signal,request));
 assert.equal(requested,0);
});
test('oversized or truncated bodies fail, and cancellation closes a partial reader',async()=>{
 for(const body of [new Uint8Array([1]),new Uint8Array([1,2,3])]){
  const request:typeof fetch=async()=>new Response(body);await assert.rejects(loadComparisonOriginal('/source',{bytes:2,type:'video/mp4'},new AbortController().signal,request),/길이/);
 }
 const controller=new AbortController();let cancelled=false,requested=0;
 const request:typeof fetch=async()=>{requested++;return new Response(new ReadableStream({start(stream){stream.enqueue(new Uint8Array([1]));controller.abort();},cancel(){cancelled=true;}}));};
 await assert.rejects(loadComparisonOriginal('/source',{bytes:2,type:'video/mp4'},controller.signal,request));
 assert.equal(requested,1);assert.equal(cancelled,true,'a late response body must be cancelled before a reader exists');
 cancelled=false;
 const stop=new AbortController();let read=0;
 const during:typeof fetch=async()=>new Response(new ReadableStream({pull(stream){if(++read===1)stream.enqueue(new Uint8Array([1]));else{stop.abort();stream.enqueue(new Uint8Array([2]));}},cancel(){cancelled=true;}}));
 await assert.rejects(loadComparisonOriginal('/source',{bytes:3,type:'video/mp4'},stop.signal,during));assert.equal(cancelled,true);
});
