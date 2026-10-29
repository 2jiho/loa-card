import test from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalStorageAttestationReplay,parseCanonicalStorageAttestationContract} from '../src/features/card-scanner/canonical-storage-attestation';
import {prepareNativeStorage,rgbaFrameStorage} from '../src/features/card-scanner/native-frame-storage';
import {verifyAttestedPreparedNative,type AuthorizedPreparedNativeAttestation,type PreparedNativeAttestation} from '../src/features/card-scanner/prepared-native-attestation';
import type {ExactEntry,ExactFrame} from '../src/features/card-scanner/exact-recording-codec';
import type {NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';

const sessionId='storage-session',producerId='storage-producer';
const contract={version:1,mode:'prepared-native-attestation-v1',sessionId,producerId} as const;
const event=(type:string,value:unknown):ExactEntry=>({kind:'event',seq:1,time:0,type,value});
const declaration=()=>event('canonical-storage-contract',contract);
const ticket=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const metadata:NativeYuvFrameMetadata={format:'NV12',codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,
  visibleRect:{x:0,y:0,width:2,height:2},rotation:0,flip:false,
  colorSpace:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}};

async function fixture(id=1,time=1.5){
  const pixels=Uint8Array.from([16,80,160,235,70,190]),prepared=await prepareNativeStorage(metadata,pixels),s=prepared.storage;
  const frame:ExactFrame={kind:'frame',id,time,width:2,height:2,key:true,hash:prepared.rgbaHash,canonical:true,storage:s};
  const receipt:PreparedNativeAttestation={version:1,kind:'prepared-native-conversion',sessionId,producerId,requestId:id,sourceFrameId:id,captureTime:time,
    width:2,height:2,nativeByteLength:6,rgbaByteLength:16,descriptorSha256:s.descriptorSha256,recipeId:s.recipeId,recipeSha256:s.recipeSha256,
    nativeSha256:s.nativeSha256,generatedRgbaSha256:prepared.rgbaHash,ticketId:ticket(id)};
  return {frame,receipt,pixels};
}
function entries(f:Awaited<ReturnType<typeof fixture>>){return [declaration(),f.frame,event('canonical-storage-attestation',f.receipt)];}
function replay(values:readonly ExactEntry[]){const value=new CanonicalStorageAttestationReplay();values.forEach(entry=>value.accept(entry));return value;}

test('storage contract has an exact bounded schema and does not accept raster contract or authority fields',()=>{
  assert.deepEqual(parseCanonicalStorageAttestationContract(contract),contract);assert.ok(Object.isFrozen(parseCanonicalStorageAttestationContract(contract)));
  for(const value of [null,[],{}, {version:1},{...contract,version:2},{...contract,mode:'only-requested'},
    {...contract,scope:'all'},{...contract,sessionId:''},{...contract,producerId:'bad identity'},
    {...contract,sessionId:'a'.repeat(129)},{...contract,producerId:'bad\0identity'},
    {...contract,[Symbol('extra')]:true}])assert.throws(()=>parseCanonicalStorageAttestationContract(value));
  const getter={...contract};Object.defineProperty(getter,'sessionId',{enumerable:true,get(){throw Error('must not execute');}});
  assert.throws(()=>parseCanonicalStorageAttestationContract(getter),/data fields/);
});

test('contract/header/receipt may interleave, while every joined native source is verified as metadata only',async()=>{
  const f=await fixture(),values=entries(f);
  for(const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]){
    const state=replay(order.map(i=>values[i])),summary=await state.finalize(true);
    assert.deepEqual(summary,{nativeFrames:1,rgbaFrames:0,attestations:1,scope:'metadata-only',payloadIntegrityVerified:false,privatePortAuthorityRecreated:false,
      supported:true,complete:true,matches:true,verified:1,missingAttestations:0,missingSources:0});
    assert.ok(Object.isFrozen(summary));assert.equal(state.stats.tickets,1);
  }
});

test('nonmonotonic capture clocks do not reorder physical headers or producer requests',async()=>{
  const first=await fixture(1,10),second=await fixture(2,2),state=replay([declaration(),first.frame,
    event('canonical-storage-attestation',first.receipt),second.frame,event('canonical-storage-attestation',second.receipt)]);
  const result=await state.summary(true);assert.equal(result.verified,2);assert.equal(result.matches,true);
  assert.equal(state.stats.lastFrameId,2);assert.equal(state.stats.lastRequestId,2);
});

test('legacy undeclared frames stay unsupported, including metadata beyond the new 10000-source bound',async()=>{
  const state=new CanonicalStorageAttestationReplay();
  for(let id=1;id<=10_001;id++)state.accept({kind:'frame',id,time:0,width:2,height:2,key:true,hash:'a'.repeat(64)});
  assert.equal(state.stats.frames,10_000);const summary=await state.summary(true);
  assert.equal(summary.supported,false);assert.equal(summary.matches,null);assert.equal(summary.complete,false);
  const later=new CanonicalStorageAttestationReplay();
  for(let id=1;id<=10_001;id++)later.accept({kind:'frame',id,time:0,width:2,height:2,key:true,hash:'a'.repeat(64)});
  assert.throws(()=>later.accept(declaration()),/metadata limit/);
});

test('a receipt without a declaration cannot be interpreted as an attested recording',async()=>{
  const f=await fixture();await assert.rejects(replay([f.frame,event('canonical-storage-attestation',f.receipt)]).summary(false),/without declared contract/);
});

test('native sources cannot hide a missing receipt, including unused backup headers',async()=>{
  const first=await fixture(1),second=await fixture(2),values=[...entries(first),second.frame];
  const partial=await replay(values).summary(false);
  assert.equal(partial.verified,1);assert.equal(partial.nativeFrames,2);assert.equal(partial.missingAttestations,1);assert.equal(partial.matches,null);assert.equal(partial.complete,false);
  await assert.rejects(replay(values).summary(true),/missing source attestations/);
  const empty=await replay([declaration(),first.frame]).summary(false);assert.equal(empty.missingAttestations,1);assert.equal(empty.matches,null);
});

test('partial dangling receipts remain explicitly incomplete; complete claims require their exact physical header',async()=>{
  const f=await fixture(),values=[declaration(),event('canonical-storage-attestation',f.receipt)];
  const partial=await replay(values).summary(false);assert.equal(partial.missingSources,1);assert.equal(partial.verified,0);assert.equal(partial.matches,null);
  await assert.rejects(replay(values).summary(true),/missing source attestations/);
  const other=await fixture(2,1.5),wrong=replay([declaration(),other.frame,event('canonical-storage-attestation',f.receipt)]);
  const mismatch=await wrong.summary(false);assert.equal(mismatch.missingSources,1);assert.equal(mismatch.missingAttestations,1);assert.equal(mismatch.matches,null);
});

test('canonical RGBA fallback is allowed but receives no native attestation or pixel-integrity claim',async()=>{
  const f=await fixture(),rgba:ExactFrame={...f.frame,id:2,storage:rgbaFrameStorage(2,2)},state=replay([...entries(f),rgba]);
  const summary=await state.summary(true);assert.equal(summary.nativeFrames,1);assert.equal(summary.rgbaFrames,1);assert.equal(summary.verified,1);assert.equal(summary.matches,true);
  const onlyRgba=await replay([declaration(),rgba]).summary(true);assert.equal(onlyRgba.complete,true);assert.equal(onlyRgba.matches,null);assert.equal(onlyRgba.verified,0);
  await assert.rejects(replay([declaration(),{...f.frame,storage:rgbaFrameStorage(2,2)},event('canonical-storage-attestation',f.receipt)]).summary(true),/requires native storage/);
  for(const change of [{canonical:undefined},{storage:undefined}])
    await assert.rejects(replay([declaration(),{...f.frame,...change},event('canonical-storage-attestation',f.receipt)]).summary(true),/canonical stored source/);
});

test('duplicate contract, source, ticket and non-increasing producer requests fail instead of adding confirmations',async()=>{
  const f=await fixture(),other=await fixture(2),state=replay(entries(f));
  assert.throws(()=>state.accept(declaration()),/duplicate contract/);
  assert.throws(()=>state.accept(f.frame),/physical source/);
  for(const receipt of [{...f.receipt,requestId:2,ticketId:ticket(2)}, {...other.receipt,ticketId:f.receipt.ticketId},
    {...other.receipt,requestId:1}])assert.throws(()=>replay(entries(f)).accept(event('canonical-storage-attestation',receipt)),/duplicate|replayed|non-increasing/);
  const reversed=replay([declaration(),other.frame]);assert.throws(()=>reversed.accept(f.frame),/non-increasing physical source/);
});

test('session and producer domains match even when the contract follows the receipts',async()=>{
  const f=await fixture();
  for(const change of [{sessionId:'other-session'},{producerId:'other-producer'}]){
    assert.throws(()=>replay([declaration()]).accept(event('canonical-storage-attestation',{...f.receipt,...change})),/producer\/session mismatch/);
    await assert.rejects(replay([f.frame,event('canonical-storage-attestation',{...f.receipt,...change}),declaration()]).summary(true),/producer\/session mismatch/);
  }
});

test('source time/dimensions, native/recipe/descriptor hashes and generated RGBA hash join exactly',async()=>{
  const f=await fixture();
  for(const change of [{captureTime:1.5000000000000002},{width:4,height:2,nativeByteLength:12,rgbaByteLength:32},
    {nativeSha256:'a'.repeat(64)},{descriptorSha256:'a'.repeat(64)},{recipeSha256:'a'.repeat(64)},{generatedRgbaSha256:'a'.repeat(64)}])
    await assert.rejects(replay([declaration(),f.frame,event('canonical-storage-attestation',{...f.receipt,...change})]).summary(false),/metadata mismatch/);
  const missing={...f.receipt} as Record<string,unknown>;delete missing.ticketId;
  assert.throws(()=>replay([declaration(),f.frame]).accept(event('canonical-storage-attestation',missing)),/missing field/);
});

test('matching forged descriptor/recipe hash fields cannot bypass canonical metadata SHA recomputation',async()=>{
  const f=await fixture();
  for(const key of ['descriptorSha256','recipeSha256'] as const){
    const frame={...f.frame,storage:{...f.frame.storage!,[key]:'a'.repeat(64)}},receipt={...f.receipt,[key]:'a'.repeat(64)};
    await assert.rejects(replay([declaration(),frame,event('canonical-storage-attestation',receipt)]).summary(true),/canonical descriptor\/recipe hash mismatch/);
  }
  const storage=structuredClone(f.frame.storage!);
  assert.equal(storage.kind,'native-yuv420');if(storage.kind!=='native-yuv420')throw Error('fixture');
  storage.descriptor.format='I420';
  await assert.rejects(replay([declaration(),{...f.frame,storage},event('canonical-storage-attestation',f.receipt)]).summary(true),/canonical descriptor\/recipe hash mismatch/);
});

test('validator owns immutable metadata snapshots, without source buffers or authorization issuance',async()=>{
  const f=await fixture(),frame=structuredClone(f.frame),receipt={...f.receipt},state=replay([declaration(),frame,event('canonical-storage-attestation',receipt)]);
  frame.time=77;receipt.captureTime=77;receipt.generatedRgbaSha256='a'.repeat(64);
  assert.equal((await state.summary(true)).matches,true);
  await assert.rejects(verifyAttestedPreparedNative(f.receipt as AuthorizedPreparedNativeAttestation,{descriptor:metadata,pixels:f.pixels}),/one-shot authority/);
  assert.equal(f.pixels.byteLength,6,'metadata validation never takes native buffer ownership');
  assert.equal(state.stats.frames,1);assert.equal(state.stats.receipts,1);assert.equal(state.stats.tickets,1);
});

test('matching claimed native/pixel hashes remain metadata joins, not actual payload verification',async()=>{
  const f=await fixture(),claimedNative='a'.repeat(64),claimedRgba='b'.repeat(64),frame={...f.frame,hash:claimedRgba,
    storage:{...f.frame.storage!,nativeSha256:claimedNative}},receipt={...f.receipt,nativeSha256:claimedNative,generatedRgbaSha256:claimedRgba};
  const summary=await replay([declaration(),frame,event('canonical-storage-attestation',receipt)]).summary(true);
  assert.equal(summary.matches,true);assert.equal(summary.scope,'metadata-only');assert.equal(summary.payloadIntegrityVerified,false);assert.equal(summary.privatePortAuthorityRecreated,false);
});

test('10000 receipt metadata limit is independent from source header count',async()=>{
  const f=await fixture(),state=replay([declaration()]);
  for(let id=1;id<=10_000;id++)state.accept(event('canonical-storage-attestation',{...f.receipt,sourceFrameId:id,requestId:id,ticketId:ticket(id)}));
  assert.equal(state.stats.receipts,10_000);assert.equal(state.stats.frames,0);assert.equal(state.stats.tickets,10_000);
  assert.throws(()=>state.accept(event('canonical-storage-attestation',{...f.receipt,sourceFrameId:10_001,requestId:10_001,ticketId:ticket(10_001)})),/receipt metadata limit/);
});

test('finalization is immutable, abortable, and cannot change the recording completion claim',async()=>{
  const f=await fixture(),state=replay(entries(f)),first=state.finalize(true);
  assert.equal(state.summary(true),first);assert.throws(()=>state.accept(event('unrelated',{})),/already finalizing/);
  await assert.rejects(state.summary(false),/completion flag changed/);await first;
  const controller=new AbortController(),aborted=new CanonicalStorageAttestationReplay(controller.signal);
  entries(f).forEach(entry=>aborted.accept(entry));const checking=aborted.summary(true);controller.abort(Error('metadata verification aborted'));
  await assert.rejects(checking,/metadata verification aborted/);
});
