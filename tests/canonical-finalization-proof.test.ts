import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCanonicalFinalization,CanonicalFinalizationError} from '../src/features/card-scanner/reproduction/canonical-finalization-proof';
import {createCanonicalFinalizationFixture} from './helpers/canonical-finalization-fixture';
import type {CanonicalFixtureEntry} from './helpers/canonical-finalization-fixture';
import type {ExactRecording} from '../src/features/card-scanner/reproduction/exact-recording';
import {RGBA_WINDOW_POLICY} from '../src/features/card-scanner/reproduction/rgba-window-policy';
import {executionSummary,exactReplayFrames} from '../src/features/card-scanner/reproduction/exact-recording-codec';

const signal=()=>AbortSignal.timeout(30_000);
function resequence(entries:readonly CanonicalFixtureEntry[]):CanonicalFixtureEntry[]{
  let seq=0;return entries.map(entry=>entry.header.kind==='event'?{...entry,header:{...entry.header,seq:++seq}}:entry);
}
const remove=(entries:readonly CanonicalFixtureEntry[],type:string)=>resequence(entries.filter(entry=>entry.header.kind!=='event'||entry.header.type!==type));
const changedEvent=(entries:readonly CanonicalFixtureEntry[],type:string,change:(value:Record<string,unknown>)=>unknown)=>
  entries.map(entry=>entry.header.kind==='event'&&entry.header.type===type?{...entry,header:{...entry.header,value:change(entry.header.value as Record<string,unknown>)}}:entry);

test('real production channels/checkpoints yield a small frozen event-proof receipt for canonical RGBA and window recordings',async()=>{
  for(const codecPolicy of [undefined,RGBA_WINDOW_POLICY]){
    const fixture=await createCanonicalFinalizationFixture({codecPolicy});
    const proof=await verifyCanonicalFinalization(fixture.recording,signal());
    assert.equal(proof.kind,'canonical-finalization-validation');assert.equal(proof.frames,1);
    assert.equal(proof.events,fixture.events.length);assert.equal(proof.bytes,fixture.recording.blob.size);
    assert.equal(proof.raster.uses,1);assert.equal(proof.raster.verified,1);assert.equal(proof.raster.measured,1);
    assert.equal(proof.capturedState.input.settled,true);assert.equal(proof.capturedState.unknown.complete,true);
    assert.equal(proof.capturedState.freshness.complete,true);assert.equal(proof.scope.liveOwnership,'enforced-by-caller');
    assert.equal(proof.capturedState.obstruction.complete,true);assert.match(proof.capturedState.obstruction.hash,/^[a-f0-9]{64}$/);
    assert.equal(proof.scope.payloadPixelsDecoded,false);assert.equal(proof.scope.payloadPixelHashesVerified,false);
    assert.equal(proof.scope.osCaptureTimingReplayed,false);assert.equal(proof.scope.recognitionRecomputed,false);
    assert.ok(Object.isFrozen(proof));assert.ok(Object.isFrozen(proof.capturedState.input));
    assert.ok(new TextEncoder().encode(JSON.stringify(proof)).length<2048);
  }
});
test('fixture capacity bytes are an actual independently hashed unused canonical frame payload',async()=>{
  const fixture=await createCanonicalFinalizationFixture({extraFrameBytes:256*1024});
  assert.equal(fixture.recording.stats.frames,2);assert.ok(fixture.recording.blob.size>256*1024);
  const proof=await verifyCanonicalFinalization(fixture.recording,signal());assert.equal(proof.frames,2);assert.equal(proof.raster.uses,1);
});
test('a recorded ephemeral source gap prevents complete replay and canonical finalization',async()=>{
  const fixture=await createCanonicalFinalizationFixture();
  const gap:CanonicalFixtureEntry={header:{kind:'event',seq:fixture.events.length+1,time:5,type:'canonical-source-gap',
    value:{kind:'ephemeral-unrecorded',sourceFrameId:2,acquisitionFrameId:2,phase:'input',captureTime:3}}};
  const recording=fixture.recordingFrom([...fixture.entries,gap]);
  const summary=await executionSummary(recording.blob,signal(),recording.stats);
  assert.equal(summary.recordingComplete,false,'a complete producer claim cannot fill missing source pixels');
  assert.equal(summary.input.matchesCapturedState,null,'checkpoint equality is not complete replay evidence');
  await assert.rejects(verifyCanonicalFinalization(recording,signal()),(error:unknown)=>
    error instanceof CanonicalFinalizationError&&error.reason==='source-gap');
});
test('a linked acquisition cannot borrow another acquisition source and matching raster receipt',async()=>{
  const fixture=await createCanonicalFinalizationFixture();
  const unrelatedUse=changedEvent(fixture.entries,'canonical-source-use',value=>({...value,acquisitionFrameId:2}));
  const unrelatedReceipt=changedEvent(unrelatedUse,'canonical-raster-receipt',value=>({...value,acquisitionFrameId:2}));
  const recording=fixture.recordingFrom(unrelatedReceipt);
  await assert.rejects(verifyCanonicalFinalization(recording,signal()),/연결|source|입력/i);
  await assert.rejects(async()=>{for await(const _frame of exactReplayFrames(recording.blob,signal()))assert.fail('must reject before yielding');},/연결|원본/);
});
test('an acquisition contract rejects an unexplained unlinked attempt before replay',async()=>{
 const fixture=await createCanonicalFinalizationFixture();
 const contract:CanonicalFixtureEntry={header:{kind:'event',seq:1,time:0,type:'input-acquisition-contract',value:{version:1}}};
 const withContract=resequence([fixture.entries[0],contract,...fixture.entries.slice(1)]);
 const complete=fixture.recordingFrom(withContract);
 assert.equal((await executionSummary(complete.blob,signal(),complete.stats)).acquisitionEvidence?.complete,true);
 const missing=fixture.recordingFrom(remove(withContract,'input-link'));
 const summary=await executionSummary(missing.blob,signal(),missing.stats);
 assert.equal(summary.acquisitionEvidence?.unresolved,1);
 assert.equal(summary.recordingComplete,false);
 await assert.rejects(verifyCanonicalFinalization(missing,signal()));
 await assert.rejects(async()=>{for await(const _frame of exactReplayFrames(missing.blob,signal()))assert.fail('must reject before yielding');},/획득 근거/);
 const ordinary=missing.blob;
 const noncanonical=fixture.recordingFrom(remove(withContract,'input-link').map(entry=>entry.header.kind==='frame'?
  {...entry,header:{...entry.header,canonical:undefined}}:entry));
 assert.ok(ordinary.size>0);
 await assert.rejects(async()=>{for await(const _frame of exactReplayFrames(noncanonical.blob,signal()))assert.fail('must reject before yielding');},/획득 근거/);
});
test('a new contract does not hide failed recovery after normal acquisitions complete',async()=>{
 const fixture=await createCanonicalFinalizationFixture();
 const event=(type:string,value:unknown):CanonicalFixtureEntry=>({header:{kind:'event',seq:1,time:5,type,value}});
 const stamp={inputId:2,captureTime:3,observedAtMs:100};
 const entries=resequence([fixture.entries[0],event('input-acquisition-contract',{version:1}),...fixture.entries.slice(1),
  event('input-admission',{kind:'consider',stamp,gates:{capturing:true,checkingCompletion:true},expected:'verification'}),
  event('input-recovery',{version:1,seq:1,kind:'retained',stamp}),
  event('input-recovery',{version:1,seq:2,kind:'started',inputId:2}),
  event('input-recovery',{version:1,seq:3,kind:'finished',inputId:2,outcome:'error'}),
  event('input-recovery',{version:1,seq:4,kind:'released',inputId:2,reason:'processed',failed:false})]);
 const recording=fixture.recordingFrom(entries),result=await executionSummary(recording.blob,signal(),recording.stats);
 assert.equal(result.acquisitionEvidence?.complete,true,'normal-attempt classification alone is not recovery proof');
 assert.equal(result.input.settled,false);assert.equal(result.recordingComplete,false);
 await assert.rejects(async()=>{for await(const _frame of exactReplayFrames(recording.blob,signal()))assert.fail('must reject before yielding');},/복구 기록/);
});
test('matching checkpoints with unavailable archive totals stay unknown for every state domain',async()=>{
  const fixture=await createCanonicalFinalizationFixture(),{blob,stats}=fixture.recording;
  const complete=await executionSummary(blob,signal(),stats);
  for(const part of [complete.grid,complete.inventory,complete.input,complete.unknownLifecycle,complete.freshness,complete.obstruction])
    assert.equal(part.matchesCapturedState,true);
  const unknown=await executionSummary(blob,signal());
  assert.equal(unknown.recordingComplete,null);
  for(const part of [unknown.grid,unknown.inventory,unknown.input,unknown.unknownLifecycle,unknown.freshness,unknown.obstruction]){
    assert.ok(part.hash);assert.ok(part.expectedHash);assert.equal(part.matchesCapturedState,null);
  }
  const partial=await executionSummary(blob,signal(),{...stats,complete:false,dropped:0});
  for(const part of [partial.grid,partial.inventory,partial.input,partial.unknownLifecycle,partial.freshness,partial.obstruction])
    assert.equal(part.matchesCapturedState,null);
});
test('producer incomplete/loss/error, wrong byte/count totals and missing queue cannot grant omission authority',async()=>{
  const fixture=await createCanonicalFinalizationFixture();
  for(const changes of [{canonical:undefined},{complete:false},{dropped:1},{error:'producer failed'},
    {bytes:fixture.recording.blob.size+1},{frames:2},{events:fixture.events.length+1},{eventQueue:undefined}])
    await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(fixture.entries,changes),signal()));
});
test('event queue failure, pending/inflight work, missing ACK and accepted-count mismatch fail closed',async()=>{
  const fixture=await createCanonicalFinalizationFixture(),base=fixture.recording.stats.eventQueue!;
  for(const change of [{pendingEvents:1},{pendingBytes:1},{inFlightBatches:1},{acknowledgedBatches:0},
    {acceptedEvents:base.acceptedEvents+1},{firstFailure:{}},{peakInFlightBatches:5},{peakPendingBytes:1024*1024+1}])
    await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(fixture.entries,{eventQueue:{...base,...change} as never}),signal()));
});
test('each missing captured-state channel and each absent checkpoint remains unsupported or unverified',async()=>{
  const fixture=await createCanonicalFinalizationFixture();
  for(const type of ['input-admission','input-decision','input-checkpoint','inventory-seed','inventory-checkpoint',
    'grid-command','grid-checkpoint','unknown-seed','unknown-checkpoint','freshness-seed','freshness-checkpoint','obstruction-seed','obstruction-checkpoint'])
    await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(remove(fixture.entries,type)),signal()),undefined,type);
});
test('failed or mismatching captured checkpoints are not replaced by a producer complete boolean',async()=>{
  const fixture=await createCanonicalFinalizationFixture();
  for(const type of ['input-checkpoint','inventory-checkpoint','grid-checkpoint','unknown-checkpoint','freshness-checkpoint','obstruction-checkpoint']){
    for(const mutate of [(value:Record<string,unknown>)=>({...value,hash:'f'.repeat(64)}),
      (value:Record<string,unknown>)=>({...value,error:'checkpoint failed'}),
      (value:Record<string,unknown>)=>{const {hash:_hash,...rest}=value;return {...rest,complete:false};}])
      await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(changedEvent(fixture.entries,type,mutate)),signal()));
  }
});
test('every declared recording-error channel rejects even when a later checkpoint would match',async()=>{
  const fixture=await createCanonicalFinalizationFixture();
  for(const type of ['input-recording-error','unknown-recording-error','freshness-recording-error','obstruction-recording-error','capture-recording-error','media-recording-error']){
    const entries=[...fixture.entries,{header:{kind:'event' as const,seq:fixture.events.length+1,time:5,type,value:{error:'sink loss'}}}];
    await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(entries),signal()),/channel loss/);
  }
});
test('canonical contract, physical source, source use and measured raster receipt are all required',async()=>{
  const fixture=await createCanonicalFinalizationFixture();
  for(const type of ['canonical-raster-contract','canonical-source-use','canonical-raster-receipt'])
    await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(remove(fixture.entries,type)),signal()));
  const noSource=fixture.entries.filter(entry=>entry.header.kind!=='frame');
  await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(noSource),signal()));
  for(const fields of [{sourceFrameId:99},{hash:'b'.repeat(64)},{captureTime:3},{acquisitionFrameId:99}])
    await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(changedEvent(fixture.entries,'canonical-raster-receipt',value=>({...value,...fields}))),signal()));
});
test('an unused noncanonical physical frame and nonincreasing source IDs are not hidden by matching used-source receipts',async()=>{
  const fixture=await createCanonicalFinalizationFixture({extraFrameBytes:4});
  for(const changed of [{canonical:undefined},{id:1}]){
    const entries=fixture.entries.map(entry=>entry.header.kind==='frame'&&entry.header.id===2?
      {...entry,header:{...entry.header,...changed} as never}:entry);
    await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(entries),signal()),/canonical source|중복/);
  }
});
test('event sequence gaps, truncated envelopes and fake JSON proof objects are rejected',async()=>{
  const fixture=await createCanonicalFinalizationFixture();
  const gap=fixture.entries.map(entry=>entry.header.kind==='event'?{...entry,header:{...entry.header,seq:entry.header.seq+1}}:entry);
  await assert.rejects(verifyCanonicalFinalization(fixture.recordingFrom(gap),signal()),/순서/);
  const broken={...fixture.recording,blob:fixture.recording.blob.slice(0,-1)};broken.stats={...broken.stats,bytes:broken.blob.size};
  await assert.rejects(verifyCanonicalFinalization(broken,signal()));
  await assert.rejects(verifyCanonicalFinalization({complete:true,canonical:true,rasterProof:{matches:true},capturedState:true} as never,signal()));
});
test('summary-only proof deliberately does not claim payload decoding or payload SHA verification',async()=>{
  const fixture=await createCanonicalFinalizationFixture();
  const entries=fixture.entries.map(entry=>entry.header.kind==='frame'?{...entry,payload:new Uint8Array(9).fill(255)}:entry);
  const proof=await verifyCanonicalFinalization(fixture.recordingFrom(entries),signal());
  assert.equal(proof.scope.payloadPixelsDecoded,false);assert.equal(proof.scope.payloadPixelHashesVerified,false);
});
test('abort before or during metadata reads never publishes a receipt; recording disposal remains caller-owned',async()=>{
  const fixture=await createCanonicalFinalizationFixture(),controller=new AbortController();controller.abort();
  await assert.rejects(verifyCanonicalFinalization(fixture.recording,controller.signal),{name:'AbortError'});
  const later=new AbortController();let disposed=0;
  class AbortBlob extends Blob {override slice(start=0,end=this.size,type=''){later.abort();return super.slice(start,end,type);}}
  const blob=new AbortBlob([fixture.recording.blob]);
  const recording={blob,stats:{...fixture.recording.stats,bytes:blob.size},dispose:async()=>{disposed++;}};
  await assert.rejects(verifyCanonicalFinalization(recording,later.signal),{name:'AbortError'});assert.equal(disposed,0);
});
test('producer identity mutation during asynchronous validation and accessors fail closed',async()=>{
  const fixture=await createCanonicalFinalizationFixture();let recording:ExactRecording;
  class MutatingBlob extends Blob {override slice(start=0,end=this.size,type=''){
    recording.stats={...recording.stats};return super.slice(start,end,type);
  }}
  const blob=new MutatingBlob([fixture.recording.blob]);recording={blob,stats:{...fixture.recording.stats,bytes:blob.size},dispose:async()=>{}};
  await assert.rejects(verifyCanonicalFinalization(recording,signal()),(error:unknown)=>error instanceof CanonicalFinalizationError&&error.reason==='changed');
  let invoked=0;const accessor=Object.defineProperty({...fixture.recording},'stats',{get(){invoked++;return fixture.recording.stats;}});
  await assert.rejects(verifyCanonicalFinalization(accessor,signal()));assert.equal(invoked,0);
});
test('abort ends an unresponsive bounded Blob read without waiting for native completion', {timeout:1000},async()=>{
  const fixture=await createCanonicalFinalizationFixture(),controller=new AbortController();
  let posted!:()=>void;const started=new Promise<void>(resolve=>{posted=resolve;});
  class HangingBlob extends Blob {override slice(start=0,end=this.size,type=''){
    assert.ok(end-start<=1024*1024);const part=super.slice(start,end,type);
    Object.defineProperty(part,'arrayBuffer',{value:()=>{posted();return new Promise<ArrayBuffer>(()=>{});}});return part;
  }}
  const blob=new HangingBlob([fixture.recording.blob]),recording={...fixture.recording,blob,stats:{...fixture.recording.stats,bytes:blob.size}};
  const pending=verifyCanonicalFinalization(recording,controller.signal);await started;controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
});
test('late native read failure after abort stays observed and cannot publish a receipt', {timeout:1000},async()=>{
  const fixture=await createCanonicalFinalizationFixture(),controller=new AbortController();
  let posted!:()=>void,rejectRead!:(error:Error)=>void;
  const started=new Promise<void>(resolve=>{posted=resolve;}),read=new Promise<ArrayBuffer>((_resolve,reject)=>{rejectRead=reject;});
  class LateBlob extends Blob {override slice(start=0,end=this.size,type=''){
    const part=super.slice(start,end,type);Object.defineProperty(part,'arrayBuffer',{value:()=>{posted();return read;}});return part;
  }}
  const blob=new LateBlob([fixture.recording.blob]);let published=false;
  const pending=verifyCanonicalFinalization({...fixture.recording,blob,stats:{...fixture.recording.stats,bytes:blob.size}},controller.signal)
    .then(()=>{published=true;});
  await started;controller.abort();await assert.rejects(pending,{name:'AbortError'});
  rejectRead(Error('late native failure'));await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(published,false);
});
