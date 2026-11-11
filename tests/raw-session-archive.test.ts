import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRawSessionArchive,openRawSessionArchive,RAW_SESSION_MAGIC,MAX_RAW_HEADER_BYTES,MAX_RAW_ARCHIVE_BYTES} from '../src/features/card-scanner/reproduction/raw-session-archive';
import type {RawSessionSnapshot,RawSessionChunk} from '../src/features/card-scanner/reproduction/raw-session-archive';
import type {ReproductionSessionIndex} from '../src/features/card-scanner/reproduction/reproduction-session-store';

const signal=()=>new AbortController().signal;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const chunk=(kind:'video'|'exact',seq:number,value:string):RawSessionChunk=>({kind,seq,bytes:Buffer.byteLength(value),sha256:sha(value),blob:new Blob([value])});
function snapshot():RawSessionSnapshot {
  const chunks=[chunk('video',0,'video-0'),chunk('video',1,'video-1'),chunk('exact',0,'complete-entry|partial-tail')];
  const size=chunks.reduce((sum,item)=>sum+item.bytes,0),detailsBytes=17;
  const index:ReproductionSessionIndex={version:1,id:'session-1',createdAt:'2026-10-30T00:00:00.000Z',updatedAt:'2026-10-30T00:01:00.000Z',
    environment:{browser:'test',catalog:'test',build:'test'},record:true,status:'partial',sealed:true,pinned:false,ownerId:'tab-1',leaseUntil:null,
    bytes:size+detailsBytes,detailsBytes,chunkCounts:{video:2,exact:1},chunkBytes:{video:14,exact:27},hasInput:true,
    read:null,expected:null,cards:null,generation:'generation-1',archiveRevision:'revision-1',archive:{state:'pending'}};
  return {index,initial:{captureTime:1,source:'display'},summary:{warning:'부분 저장'},metadata:{duration:2},
    exactFinalization:{verifiedPrefixChunks:0},replayCaseId:'a'.repeat(64),chunks};
}
async function parts(blob:Blob){
  const prefix=new Uint8Array(await blob.slice(0,12).arrayBuffer());
  const length=new DataView(prefix.buffer).getUint32(8,true);
  return {prefix,header:JSON.parse(await blob.slice(12,12+length).text()) as Record<string,unknown>,payload:blob.slice(12+length)};
}
function build(header:unknown,payload:Blob){
  const bytes=new TextEncoder().encode(JSON.stringify(header)),prefix=new Uint8Array(12);
  prefix.set(new TextEncoder().encode(RAW_SESSION_MAGIC));new DataView(prefix.buffer).setUint32(8,bytes.length,true);
  return new Blob([prefix,bytes,payload]);
}

test('preserves original chunk boundaries, trailing incomplete bytes and metadata without claiming replay',async()=>{
  const input=snapshot(),blob=await createRawSessionArchive(input,signal()),opened=await openRawSessionArchive(blob,signal());
  assert.equal(opened.metadata.kind,'raw-session');assert.equal(opened.metadata.replayable,false);
  assert.equal(opened.metadata.index.status,'partial');assert.equal(opened.metadata.index.generation,'generation-1');
  assert.deepEqual(opened.metadata.initial,input.initial);assert.deepEqual(opened.metadata.summary,input.summary);
  assert.deepEqual(opened.metadata.metadata,input.metadata);assert.deepEqual(opened.metadata.exactFinalization,input.exactFinalization);
  assert.equal(opened.metadata.replayCaseId,input.replayCaseId);
  assert.deepEqual(opened.chunks.map(({kind,seq,bytes,sha256})=>({kind,seq,bytes,sha256})),input.chunks.map(({kind,seq,bytes,sha256})=>({kind,seq,bytes,sha256})));
  assert.deepEqual(await Promise.all(opened.chunks.map(part=>part.blob.text())),['video-0','video-1','complete-entry|partial-tail']);
});

test('rejects invalid chunk order, accounting, missing generation, live sessions and wrong digest',async()=>{
  const input=snapshot();
  await assert.rejects(createRawSessionArchive({...input,chunks:[input.chunks[2],input.chunks[0],input.chunks[1]]},signal()));
  await assert.rejects(createRawSessionArchive({...input,chunks:input.chunks.map((c,i)=>i===1?{...c,seq:0}:c)},signal()));
  await assert.rejects(createRawSessionArchive({...input,index:{...input.index,chunkCounts:{video:1,exact:1}}},signal()));
  await assert.rejects(createRawSessionArchive({...input,index:{...input.index,archiveRevision:undefined}},signal()));
  await assert.rejects(createRawSessionArchive({...input,index:{...input.index,status:'open',sealed:false}},signal()));
  await assert.rejects(createRawSessionArchive({...input,chunks:input.chunks.map((c,i)=>i===0?{...c,sha256:'0'.repeat(64)}:c)},signal()),/해시/);
  await assert.rejects(createRawSessionArchive({...input,replayCaseId:'not-a-hash'},signal()));
  await assert.rejects(createRawSessionArchive({...input,metadata:{invalid:NaN}},signal()));
});

test('independent reader rejects forged headers, truncated payload, corrupt bytes and trailing data',async()=>{
  const blob=await createRawSessionArchive(snapshot(),signal()),{header,payload}=await parts(blob);
  await assert.rejects(openRawSessionArchive(blob.slice(0,blob.size-1),signal()),/잘렸|해시/);
  await assert.rejects(openRawSessionArchive(new Blob([blob,'extra']),signal()),/추가 바이트/);
  await assert.rejects(openRawSessionArchive(new Blob(['wrong-magic!',blob.slice(12)]),signal()));
  await assert.rejects(openRawSessionArchive(build({...header,replayable:true},payload),signal()));
  await assert.rejects(openRawSessionArchive(build({...header,unexpected:true},payload),signal()));
  const alteredChunks=(header.chunks as Array<Record<string,unknown>>).map((item,i)=>i?item:{...item,sha256:'0'.repeat(64)});
  await assert.rejects(openRawSessionArchive(build({...header,chunks:alteredChunks},payload),signal()),/해시/);
  const payloadBytes=new Uint8Array(await payload.arrayBuffer());payloadBytes[0]^=1;
  await assert.rejects(openRawSessionArchive(build(header,new Blob([payloadBytes])),signal()),/해시/);
  const invalidLength=new Uint8Array(12);invalidLength.set(new TextEncoder().encode(RAW_SESSION_MAGIC));
  new DataView(invalidLength.buffer).setUint32(8,MAX_RAW_HEADER_BYTES+1,true);
  await assert.rejects(openRawSessionArchive(new Blob([invalidLength]),signal()),/길이/);
  assert.ok(MAX_RAW_ARCHIVE_BYTES>blob.size);
});

test('abort propagates before decoding or generating and empty failure sessions stay visibly raw',async()=>{
  const input=snapshot(),blob=await createRawSessionArchive(input,signal()),controller=new AbortController();controller.abort();
  await assert.rejects(createRawSessionArchive(input,controller.signal),{name:'AbortError'});
  await assert.rejects(openRawSessionArchive(blob,controller.signal),{name:'AbortError'});
  const empty={...input,index:{...input.index,status:'failed' as const,bytes:17,hasInput:false,
    chunkCounts:{video:0,exact:0},chunkBytes:{video:0,exact:0}},chunks:[]};
  const opened=await openRawSessionArchive(await createRawSessionArchive(empty,signal()),signal());
  assert.equal(opened.metadata.index.status,'failed');assert.equal(opened.metadata.replayable,false);assert.equal(opened.chunks.length,0);
});

test('abort during payload verification stops before consuming later chunks',async()=>{
  const original=await createRawSessionArchive(snapshot(),signal()),controller=new AbortController();let reads=0;
  class InterruptibleBlob extends Blob {
    override slice(start?:number,end?:number,contentType?:string):Blob {
      return new InterruptibleBlob([super.slice(start,end,contentType)]);
    }
    override async arrayBuffer():Promise<ArrayBuffer> {
      reads++;
      if(reads===3)controller.abort();
      return super.arrayBuffer();
    }
  }
  await assert.rejects(openRawSessionArchive(new InterruptibleBlob([original]),controller.signal),{name:'AbortError'});
  assert.equal(reads,3,'only prefix, header and first payload chunk were read');
});

test('noncanonical duplicate JSON keys are rejected even when the final value looks valid',async()=>{
  const original=await createRawSessionArchive(snapshot(),signal()),{header,payload}=await parts(original);
  const json=JSON.stringify(header).replace('"kind":"raw-session"','"kind":"raw-session","kind":"raw-session"');
  const bytes=new TextEncoder().encode(json),prefix=new Uint8Array(12);
  prefix.set(new TextEncoder().encode(RAW_SESSION_MAGIC));new DataView(prefix.buffer).setUint32(8,bytes.length,true);
  await assert.rejects(openRawSessionArchive(new Blob([prefix,bytes,payload]),signal()),/정규/);
});

test('untrusted headers cannot falsify or omit source timestamps, environment or sealed ownership fields',async()=>{
  const original=await createRawSessionArchive(snapshot(),signal()),{header,payload}=await parts(original);
  const index=header.index as Record<string,unknown>;
  const mutations:Record<string,unknown>[]=[
    {createdAt:undefined},{createdAt:'not-a-date'},{updatedAt:null},{updatedAt:'invalid'},
    {environment:undefined},{environment:null},{environment:{browser:'a',catalog:'b'}},
    {environment:{browser:0,catalog:'b',build:'c'}},{environment:{browser:'x'.repeat(4097),catalog:'b',build:'c'}},
    {record:undefined},{record:'true'},{pinned:0},{ownerId:undefined},{ownerId:''},{ownerId:'x'.repeat(161)},
    {leaseUntil:undefined},{leaseUntil:0},{read:-1},{expected:'1'},{cards:1.5},
  ];
  for(const mutation of mutations){
    const altered=build({...header,index:{...index,...mutation}},payload);
    await assert.rejects(openRawSessionArchive(altered,signal()),/세션/);
  }
});

test('optional bulk chunk hasher receives immutable blob references and must return matching complete results',async()=>{
  const input=snapshot();let calls=0;
  const hasher=async(blobs:readonly Blob[],received:AbortSignal)=>{
    calls++;assert.equal(received.aborted,false);assert.deepEqual(blobs,input.chunks.map(item=>item.blob));
    return input.chunks.map(item=>item.sha256);
  };
  const result=await createRawSessionArchive(input,signal(),{hashChunks:hasher});
  assert.equal(calls,1);assert.equal((await openRawSessionArchive(result,signal())).chunks.length,3);
  await assert.rejects(createRawSessionArchive(input,signal(),{hashChunks:async()=>[]}),/해시/);
  await assert.rejects(createRawSessionArchive(input,signal(),{hashChunks:async()=>['0'.repeat(64),input.chunks[1].sha256,input.chunks[2].sha256]}),/해시/);
  const aborted=new AbortController();
  await assert.rejects(createRawSessionArchive(input,aborted.signal,{hashChunks:async()=>{
    aborted.abort();return input.chunks.map(item=>item.sha256);
  }}),{name:'AbortError'});
});
