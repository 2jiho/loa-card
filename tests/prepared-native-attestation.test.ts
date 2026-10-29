import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {createPreparedNativeAttestationInbox,parsePreparedNativeAttestation,verifyAttestedPreparedNative,
  type PreparedNativeAttestation,type AuthorizedPreparedNativeAttestation,type PreparedNativeAttestationPort} from '../src/features/card-scanner/prepared-native-attestation';
import {prepareNativeStorage,restoreFrameStorage} from '../src/features/card-scanner/native-frame-storage';
import {NATIVE_YUV_RECIPES,type NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';

const sessionId='test-session',producerId='test-producer',source={sourceFrameId:7,captureTime:1.75};
const uuid=(n=1)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const metadata:NativeYuvFrameMetadata={format:'I420',codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,
  visibleRect:{x:0,y:0,width:2,height:2},rotation:0,flip:false,
  colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}};
const shape=(n=1):PreparedNativeAttestation=>({version:1,kind:'prepared-native-conversion',sessionId,producerId,requestId:n,
  sourceFrameId:7,captureTime:1.75,width:2,height:2,nativeByteLength:6,rgbaByteLength:16,descriptorSha256:'a'.repeat(64),
  recipeId:NATIVE_YUV_RECIPES.bt709.id,recipeSha256:'b'.repeat(64),nativeSha256:'c'.repeat(64),generatedRgbaSha256:'d'.repeat(64),ticketId:uuid(n)});
class PrivatePort {
  onmessage:((event:MessageEvent)=>void)|null=null;
  onmessageerror:((event:MessageEvent)=>void)|null=null;
  starts=0;closes=0;
  start(){this.starts++;}
  close(){this.closes++;}
  emit(value:unknown){this.onmessage?.({data:structuredClone(value)} as MessageEvent);}
  error(){this.onmessageerror?.({} as MessageEvent);}
}
function harness(options:Partial<Parameters<typeof createPreparedNativeAttestationInbox>[1]>={}){
  const port=new PrivatePort(),inbox=createPreparedNativeAttestationInbox(port as PreparedNativeAttestationPort,{sessionId,producerId,...options});
  return {port,inbox};
}
async function fixture(n=1){
  const pixels=Uint8Array.from([16,80,160,235,70,190]),prepared=await prepareNativeStorage(metadata,pixels),storage=prepared.storage;
  return {pixels,prepared,receipt:{...shape(n),descriptorSha256:storage.descriptorSha256,recipeId:storage.recipeId,
    recipeSha256:storage.recipeSha256,nativeSha256:storage.nativeSha256,generatedRgbaSha256:prepared.rgbaHash}};
}
async function authorize(receipt:PreparedNativeAttestation){
  const h=harness();h.port.emit(receipt);const authorized=await h.inbox.take(receipt.ticketId,source,2,2);return {...h,authorized};
}

test('parser returns a detached frozen exact tuple, without granting writer authority',async()=>{
  const original={...shape()},parsed=parsePreparedNativeAttestation(original);original.sourceFrameId=99;
  assert.equal(parsed.sourceFrameId,7);assert.ok(Object.isFrozen(parsed));assert.equal(Reflect.ownKeys(parsed).length,17);
  const pixels=new Uint8Array(6);
  await assert.rejects(verifyAttestedPreparedNative(parsed as AuthorizedPreparedNativeAttestation,{descriptor:metadata,pixels}),/one-shot authority/);
  assert.equal(pixels.byteLength,6,'a public parsed object cannot consume or detach native input');
});

test('tuple parser rejects missing/extra/symbol/accessor fields and non-plain representations',()=>{
  const good=shape();
  for(const key of Object.keys(good)){const missing:Record<string,unknown>={...good};delete missing[key];assert.throws(()=>parsePreparedNativeAttestation(missing));}
  const symbolic={...good,[Symbol('extra')]:true};
  const getter={...good};Object.defineProperty(getter,'requestId',{enumerable:true,get(){throw Error('getter must not execute');}});
  const hidden={...good};Object.defineProperty(hidden,'ticketId',{enumerable:false,value:good.ticketId});
  for(const bad of [null,[],{},new Date(),{...good,extra:1},symbolic,getter,hidden,Object.create(good)])
    assert.throws(()=>parsePreparedNativeAttestation(bad));
  assert.deepEqual(parsePreparedNativeAttestation(Object.assign(Object.create(null),good)),good);
});

test('tuple dimensions, byte lengths, identities, clocks, hashes, recipe and UUID are bounded',()=>{
  for(const change of [{version:2},{kind:'measured'},{width:3},{height:0},{width:8192,height:8192},
    {width:Infinity},{height:NaN},{nativeByteLength:7},{rgbaByteLength:15},{requestId:0},{requestId:.5},
    {sourceFrameId:Number.MAX_SAFE_INTEGER+1},{sourceFrameId:'7'},{captureTime:NaN},{captureTime:Infinity},{captureTime:-1},
    {sessionId:''},{producerId:'a'.repeat(129)},{sessionId:'with space'},{producerId:'line\nbreak'},
    {nativeSha256:'A'.repeat(64)},{descriptorSha256:'x'.repeat(64)},{recipeSha256:'b'.repeat(63)},
    {generatedRgbaSha256:1},{recipeId:'unknown-recipe'},{ticketId:uuid(10).toUpperCase()},
    {ticketId:'00000000-0000-0000-0000-000000000000'},{ticketId:'not-a-uuid'}])
    assert.throws(()=>parsePreparedNativeAttestation({...shape(),...change}),JSON.stringify(change));
  assert.equal(parsePreparedNativeAttestation({...shape(),captureTime:0}).captureTime,0);
});

test('a ready private tuple authorizes one exact source and native verifier transfers ownership',async()=>{
  const f=await fixture(),h=await authorize(f.receipt),alias=new Uint8Array(f.pixels.buffer),expected=f.pixels.slice();
  const promise=verifyAttestedPreparedNative(h.authorized,{descriptor:metadata,pixels:f.pixels});
  assert.equal(alias.byteLength,0);assert.equal(f.pixels.byteLength,0);
  const verified=await promise;
  assert.deepEqual(verified.pixels,expected);assert.equal(verified.pixels.byteOffset,0);assert.equal(verified.pixels.buffer.byteLength,6);
  assert.equal(verified.hash,f.prepared.rgbaHash);assert.deepEqual(verified.storage,f.prepared.storage);
  assert.equal(verified.attestation,h.authorized);assert.ok(Object.isFrozen(verified));assert.ok(Object.isFrozen(verified.storage.descriptor.colorSpace));
  assert.deepEqual(await restoreFrameStorage(verified.storage,2,2,verified.pixels,verified.hash),f.prepared.pixels);
  assert.equal(h.inbox.stats.pending,0);assert.equal(h.inbox.stats.issued,1);assert.equal(h.inbox.stats.spent,1);
  await assert.rejects(h.inbox.take(f.receipt.ticketId,source,2,2),/already taken/);
  await assert.rejects(verifyAttestedPreparedNative(h.authorized,{descriptor:metadata,pixels:new Uint8Array(6)}),/one-shot authority/);
  h.inbox.dispose();
});

test('tuple arriving after a waiter resolves only that private ticket and cleans timer state',async()=>{
  const f=await fixture(),h=harness(),waiting=h.inbox.take(f.receipt.ticketId,source,2,2);
  assert.equal(h.inbox.stats.waiting,1);h.port.emit(f.receipt);
  const authorized=await waiting;assert.equal(authorized.ticketId,f.receipt.ticketId);
  assert.equal(h.inbox.stats.waiting,0);assert.equal(h.inbox.stats.pending,0);assert.equal(h.port.starts,1);
  await verifyAttestedPreparedNative(authorized,{descriptor:metadata,pixels:f.pixels});h.inbox.dispose();
});

test('actual MessageChannel endpoint grants authority; JSON and clones of an authorized tuple do not',async()=>{
  const f=await fixture(),channel=new MessageChannel(),inbox=createPreparedNativeAttestationInbox(channel.port1 as unknown as PreparedNativeAttestationPort,{sessionId,producerId});
  try{
    const waiting=inbox.take(f.receipt.ticketId,source,2,2);channel.port2.postMessage(f.receipt);const authorized=await waiting;
    for(const duplicate of [parsePreparedNativeAttestation(authorized),structuredClone(authorized),JSON.parse(JSON.stringify(authorized))])
      await assert.rejects(verifyAttestedPreparedNative(duplicate as AuthorizedPreparedNativeAttestation,{descriptor:metadata,pixels:new Uint8Array(6)}),/one-shot authority/);
    assert.equal((await verifyAttestedPreparedNative(authorized,{descriptor:metadata,pixels:f.pixels})).hash,f.prepared.rgbaHash);
  }finally{inbox.dispose();channel.port2.close();}
});

test('private producer/session mismatch rejects the waiter and closes rather than matching another domain',async()=>{
  for(const change of [{sessionId:'other-session'},{producerId:'other-producer'}]){
    const h=harness(),waiting=assert.rejects(h.inbox.take(uuid(),source,2,2),/producer\/session mismatch/);
    h.port.emit({...shape(),...change});await waiting;
    assert.equal(h.inbox.stats.failed,true);assert.equal(h.inbox.stats.pending,0);assert.equal(h.port.closes,1);
  }
});

test('ticket binding uses exact source ID, time and dimensions before and after waiter registration',async()=>{
  for(const change of [{sourceFrameId:8},{captureTime:1.7500000000000002},{width:4,height:2,nativeByteLength:12,rgbaByteLength:32}]){
    for(const first of ['ready','waiting']){
      const h=harness(),receipt={...shape(),...change};
      if(first==='ready')h.port.emit(receipt);
      const waiting=assert.rejects(h.inbox.take(receipt.ticketId,source,2,2),/binding\/dimensions mismatch/);
      if(first==='waiting')h.port.emit(receipt);await waiting;
      assert.equal(h.inbox.stats.closed,true);assert.equal(h.inbox.stats.issued,0);
    }
  }
});

test('private requests increase across skipped fallback jobs; duplicates, replay and out-of-order fail closed',async()=>{
  for(const second of [{...shape(2),requestId:1},{...shape(2),requestId:.5},{...shape(3),ticketId:uuid(1)}]){
    const h=harness();h.port.emit(shape(1));await h.inbox.take(uuid(1),source,2,2);h.port.emit(second);
    assert.equal(h.inbox.stats.closed,true);assert.equal(h.inbox.stats.pending,0);assert.equal(h.inbox.stats.lastRequestId,1);
  }
  const h=harness();h.port.emit(shape(1));h.port.emit(shape(3));assert.equal(h.inbox.stats.lastRequestId,3);
  assert.equal(h.inbox.stats.pending,2);h.inbox.dispose();
  const out=harness();out.port.emit(shape(2));out.port.emit(shape(1));assert.equal(out.inbox.stats.failed,true);
});

test('128 pending tuples and one matching waiter remain bounded; a 129th pending tuple fails',async()=>{
  const h=harness();for(let n=1;n<=128;n++)h.port.emit(shape(n));
  assert.equal(h.inbox.stats.pending,128);const waiting=h.inbox.take(uuid(129),source,2,2);assert.equal(h.inbox.stats.waiting,1);
  h.port.emit(shape(129));await waiting;assert.equal(h.inbox.stats.pending,128);assert.equal(h.inbox.stats.peakPending,128);
  h.inbox.dispose();
  const full=harness();for(let n=1;n<=129;n++)full.port.emit(shape(n));
  assert.equal(full.inbox.stats.received,128);assert.equal(full.inbox.stats.closed,true);assert.equal(full.inbox.stats.peakPending,128);assert.equal(full.inbox.stats.pending,0);
});

test('lifetime ticket issuance caps at 10000 while spent/request counters never reset',async()=>{
  const h=harness({maxPendingTuples:1});
  for(let n=1;n<=10_000;n++){h.port.emit(shape(n));await h.inbox.take(uuid(n),source,2,2);}
  assert.equal(h.inbox.stats.received,10_000);assert.equal(h.inbox.stats.issued,10_000);assert.equal(h.inbox.stats.spent,10_000);
  assert.equal(h.inbox.stats.pending,0);assert.equal(h.inbox.stats.lastRequestId,10_000);assert.equal(h.inbox.stats.peakPending,1);
  h.port.emit(shape(10_001));assert.equal(h.inbox.stats.closed,true);assert.match(h.inbox.stats.error,/issued ticket limit/);
  assert.equal(h.inbox.stats.received,10_000);assert.equal(h.inbox.stats.lastRequestId,10_000);
});

test('only one unresolved take is retained, with a finite missing-ticket deadline',async()=>{
  const h=harness({timeoutMs:5}),first=assert.rejects(h.inbox.take(uuid(),source,2,2),/wait timeout/);
  await assert.rejects(h.inbox.take(uuid(2),source,2,2),/only one/);assert.equal(h.inbox.stats.waiting,1);
  await first;assert.equal(h.inbox.stats.waiting,0);assert.equal(h.inbox.stats.closed,true);assert.equal(h.port.closes,1);
  h.port.emit(shape());assert.equal(h.inbox.stats.received,0);
});

test('dispose, abort and port errors reject waiters and revoke previously granted but unused authority',async()=>{
  for(const cause of ['dispose','abort','message-error']){
    const f=await fixture(),h=harness(),signal=new AbortController();h.port.emit(f.receipt);
    const authorized=await h.inbox.take(f.receipt.ticketId,source,2,2),pending=assert.rejects(h.inbox.take(uuid(2),source,2,2,signal.signal));
    if(cause==='dispose')h.inbox.dispose(Error('owner disposed'));
    else if(cause==='abort')signal.abort(Error('owner aborted'));
    else h.port.error();
    await pending;assert.equal(h.inbox.stats.waiting,0);assert.equal(h.inbox.stats.pending,0);assert.equal(h.port.closes,1);
    await assert.rejects(verifyAttestedPreparedNative(authorized,{descriptor:metadata,pixels:f.pixels}),/one-shot authority/);
    h.inbox.dispose();assert.equal(h.port.closes,1);
  }
});

test('an already-aborted take, malformed private message and private port start error cannot wait forever',async()=>{
  const h=harness(),signal=new AbortController();signal.abort(Error('already aborted'));
  await assert.rejects(h.inbox.take(uuid(),source,2,2,signal.signal),/already aborted/);assert.equal(h.inbox.stats.closed,true);
  const malformed=harness(),waiting=assert.rejects(malformed.inbox.take(uuid(),source,2,2),/unexpected or missing field/);
  malformed.port.emit({kind:'prepared-native-conversion'});await waiting;
  const port=new PrivatePort();port.start=()=>{throw Error('start error');};
  assert.throws(()=>createPreparedNativeAttestationInbox(port as PreparedNativeAttestationPort,{sessionId,producerId}),/start error/);
  assert.equal(port.closes,1);
});

test('configuration cannot exceed existing ticket/wait bounds or take over an occupied endpoint',()=>{
  for(const options of [{maxPendingTuples:0},{maxPendingTuples:129},{maxPendingTuples:1.5},{timeoutMs:0},{timeoutMs:30_001},
    {timeoutMs:Infinity},{sessionId:''},{producerId:'with space'}])assert.throws(()=>harness(options));
  const port=new PrivatePort();port.onmessage=()=>{};
  assert.throws(()=>createPreparedNativeAttestationInbox(port as PreparedNativeAttestationPort,{sessionId,producerId}),/unused private port/);
});

test('native content, descriptor, recipe and authenticated hash tampering burn the one-shot ticket',async()=>{
  for(const kind of ['native-bytes','descriptor-format','descriptor-profile','descriptor-hash','recipe-hash','native-hash','recipe-id']){
    const f=await fixture(),receipt={...f.receipt},descriptor=structuredClone(metadata),pixels=f.pixels;
    if(kind==='native-bytes')pixels[0]^=1;
    if(kind==='descriptor-format')descriptor.format='NV12';
    if(kind==='descriptor-profile')descriptor.colorSpace={primaries:'smpte170m',transfer:'smpte170m',matrix:'smpte170m',fullRange:false};
    if(kind==='descriptor-hash')receipt.descriptorSha256='a'.repeat(64);
    if(kind==='recipe-hash')receipt.recipeSha256='b'.repeat(64);
    if(kind==='native-hash')receipt.nativeSha256='c'.repeat(64);
    if(kind==='recipe-id')receipt.recipeId=NATIVE_YUV_RECIPES.smpte170m.id;
    const h=await authorize(receipt);
    await assert.rejects(verifyAttestedPreparedNative(h.authorized,{descriptor,pixels}),/hash mismatch|recipe binding mismatch/);
    await assert.rejects(verifyAttestedPreparedNative(h.authorized,{descriptor:metadata,pixels:new Uint8Array(6)}),/one-shot authority/);
    h.inbox.dispose();
  }
});

test('native verifier rejects shared/resizable/detached/padded inputs and unsupported or extended metadata',async()=>{
  const detached=new Uint8Array(6);structuredClone(detached.buffer,{transfer:[detached.buffer]});
  const invalidPixels=[new Uint8Array(5),new Uint8Array(8).subarray(0,6),new Uint8Array(8).subarray(1,7),
    new Uint8Array(new SharedArrayBuffer(6)),new Uint8Array(new ArrayBuffer(6,{maxByteLength:12})),detached];
  for(const pixels of invalidPixels){const f=await fixture(),h=await authorize(f.receipt);
    await assert.rejects(verifyAttestedPreparedNative(h.authorized,{descriptor:metadata,pixels}),/owned fixed whole/);h.inbox.dispose();}
  for(const change of [{rotation:90},{flip:true},{visibleRect:{x:1,y:0,width:2,height:2}},{displayWidth:4},
    {colorSpace:{...metadata.colorSpace,fullRange:true}},{format:'RGBA'},{extra:true}]){
    const f=await fixture(),h=await authorize(f.receipt);
    await assert.rejects(verifyAttestedPreparedNative(h.authorized,{descriptor:{...metadata,...change},pixels:f.pixels}));h.inbox.dispose();
  }
});

test('metadata getters cannot mutate native input during canonical validation',async()=>{
  const f=await fixture(),h=await authorize(f.receipt),descriptor={...metadata};let invoked=false;
  Object.defineProperty(descriptor,'format',{enumerable:true,get(){invoked=true;f.pixels[0]^=1;return 'I420';}});
  await assert.rejects(verifyAttestedPreparedNative(h.authorized,{descriptor,pixels:f.pixels}),/data fields/);
  assert.equal(invoked,false);assert.equal(f.pixels.byteLength,6);h.inbox.dispose();
});

test('disposing or aborting during native hash validation rejects without returning a verified payload',async()=>{
  const f=await fixture(),h=await authorize(f.receipt),verification=verifyAttestedPreparedNative(h.authorized,{descriptor:metadata,pixels:f.pixels});
  const rejected=assert.rejects(verification,/disposed during verification/);h.inbox.dispose();await rejected;
  const g=await fixture(),other=await authorize(g.receipt),signal=new AbortController();
  const verifying=verifyAttestedPreparedNative(other.authorized,{descriptor:metadata,pixels:g.pixels},signal.signal);
  const aborted=assert.rejects(verifying,/hash aborted/);signal.abort(Error('hash aborted'));await aborted;other.inbox.dispose();
});

test('generated RGBA hash remains authenticated producer evidence, never a newly measured writer raster',async()=>{
  const f=await fixture(),claimedHash='e'.repeat(64),h=await authorize({...f.receipt,generatedRgbaSha256:claimedHash});
  const verified=await verifyAttestedPreparedNative(h.authorized,{descriptor:metadata,pixels:f.pixels});
  assert.equal(verified.hash,claimedHash,'this helper does not redo RGBA conversion and cannot correct a lying trusted producer');
  await assert.rejects(restoreFrameStorage(verified.storage,2,2,verified.pixels,verified.hash),/generated RGBA hash mismatch/);
  assert.equal('rasterReceipt' in verified,false);assert.equal('rgba' in verified,false);h.inbox.dispose();
});
