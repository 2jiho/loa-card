import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {UnknownLifecycle,UnknownSourceLifecycle,hashUnknownLifecycle,hashUnknownSourceLifecycle,
  parseUnknownReplaySeed} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS,type UnknownFact} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import {UnknownLifecycleReplay} from '../src/features/card-scanner/reproduction/unknown-lifecycle-replay';
import {UnknownScanSession} from '../src/features/card-scanner/session/unknown-scan-session';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';
import {entryParts,executionSummary,fastCompress,packPixels,pixelHash,type ExactEvent} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import {RunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';
import {beginReproduction,createReproductionBundle,createReproductionSessionAccess,openReproduction} from '../src/features/card-scanner/reproduction/scan-reproduction';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction/reproduction-session-store';

const signal=()=>new AbortController().signal;
const seed={version:2 as const,sessionId:'session',origin:'scan' as const,limits:UNKNOWN_LIFECYCLE_LIMITS};
const key={kind:'group' as const,sessionId:'session',group:1};
const source=(id:number):ObservationSource=>({sessionId:'session',frameId:id,observationId:`obs-${id}`,
  captureOrder:id,captureTime:id/10,phase:'input',slot:0});
const warning=(id:number):UnknownFact=>({version:1,kind:'upsert',key,source:source(id),captureOrder:id,
  captureTime:id/10,pending:false,reason:'이름 확인',location:null});
const proof=(id:number):UnknownFact=>({version:1,kind:'retire',cause:'confirmed-name',key,
  proof:{cardId:'card',source:source(id)}});
const checkpoint=(events:number,hash:string|null,complete=true)=>({version:1,complete,events,hash});
const archive=(events:ExactEvent[])=>new Blob(events.flatMap(event=>entryParts(event)));

test('seed selects distinct v1 and v2 reducers without silently upgrading old groups',async()=>{
  const legacySeed={...seed,version:1 as const},legacy=new UnknownLifecycle(legacySeed);
  const scoped=new UnknownSourceLifecycle(seed);
  const oldReplay=new UnknownLifecycleReplay(signal()),newReplay=new UnknownLifecycleReplay(signal());
  oldReplay.seed(legacySeed);newReplay.seed(seed);
  const events=[warning(1),warning(2),proof(2)];
  for(const event of events){legacy.apply(event);scoped.apply(event);oldReplay.accept(event);newReplay.accept(event);}
  const oldHash=await hashUnknownLifecycle(legacy.snapshot()),newHash=await hashUnknownSourceLifecycle(scoped.snapshot());
  oldReplay.checkpoint(checkpoint(events.length,oldHash));newReplay.checkpoint(checkpoint(events.length,newHash));
  assert.equal((await oldReplay.summary()).active,0,'v1 historical fuzzy group semantics remain intact');
  assert.equal((await newReplay.summary()).active,1,'v2 does not retire another observation');
  assert.equal((await newReplay.summary()).matchesCapturedState,true);
  assert.notEqual(oldHash,newHash);
  assert.throws(()=>parseUnknownReplaySeed({...seed,version:3}));
  assert.throws(()=>parseUnknownReplaySeed({...seed,origin:'legacy-import'}));
});

test('recording-only source loss invalidates replay but never invents live missing evidence',async()=>{
  const events:UnknownFact[]=[];
  const core=new UnknownSourceLifecycle(seed,{onEvent:event=>events.push(event)});
  core.apply(warning(1));assert.equal(core.unresolved(),1);
  core.markIncomplete('event-sink-failed');core.markIncomplete('event-sink-failed');
  assert.equal(core.hasEvidenceLoss(),false);assert.equal(core.unresolved(),1);
  core.confirmName(key,'card',source(1),[]);assert.equal(core.unresolved(),0);
  assert.equal(events.length,1,'the unavailable recorder is not retried');
  assert.equal(core.snapshot().complete,false);assert.equal(await hashUnknownSourceLifecycle(core.snapshot()),null);
  const replay=new UnknownLifecycleReplay(signal());replay.seed(seed);replay.accept(events[0]);
  replay.checkpoint(checkpoint(2,null,false));
  const result=await replay.summary();assert.equal(result.complete,false);assert.equal(result.matchesCapturedState,null);
});

test('source-scoped facts survive compressed trace and durable exact replay without proving missing pixels',async()=>{
  const events:ExactEvent[]=[];
  const emit=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:events.length,type,value});
  emit('unknown-seed',seed);
  const core=new UnknownSourceLifecycle(seed,{onEvent:fact=>emit('unknown-event',fact)});
  core.apply(warning(1));core.apply(warning(2));core.confirmName(key,'card',source(2),[]);
  const hash=await hashUnknownSourceLifecycle(core.snapshot());assert.ok(hash);
  emit('unknown-checkpoint',checkpoint(3,hash));
  const trace=new RunStateTrace();for(const event of events)assert.equal(trace.record(event.type,event.value,event.time),true);
  const traceResult=await replayRunStateTrace(await trace.snapshotBlob(),signal());
  assert.equal(traceResult.unknownLifecycle.active,1);assert.equal(traceResult.unknownLifecycle.matchesCapturedState,true);
  const pixels=new Uint8Array(16).fill(37),frame=new Blob(entryParts({kind:'frame',id:1,time:0,width:2,height:2,key:true,
    hash:await pixelHash(pixels),codec:'lz4',xor:true},fastCompress(packPixels(pixels,undefined,true))));
  const blob=new Blob([frame,archive(events)]),stats={frames:1,events:events.length,dropped:0,bytes:blob.size,
    peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:''};
  const store=createReproductionSessionStore({dbName:'unknown-source-replay-roundtrip'});
  const run=beginReproduction([],{browser:'test',catalog:'test',build:'test'},
    {record:true,store,exact:{finish:async()=>({blob,stats}),dispose:async()=>{}} as never});
  const saved=await run.finish(undefined,true);assert.ok(saved?.exact);
  const restored=await createReproductionSessionAccess(store).load(run.id,signal());assert.ok(restored?.exact);
  const opened=await openReproduction(createReproductionBundle(restored),signal());assert.ok(opened.exact);
  const result=await executionSummary(opened.exact,signal(),opened.metadata.exact);
  assert.equal(result.unknownLifecycle.active,1);assert.equal(result.unknownLifecycle.hash,hash);
  assert.equal(result.unknownLifecycle.matchesCapturedState,true);
  assert.equal(result.acquisitionEvidence?.pixelCoverage!== 'complete',true,'state equality is not physical input coverage');
  const partial=await executionSummary(opened.exact,signal(),{...opened.metadata.exact!,complete:false});
  assert.equal(partial.unknownLifecycle.matchesCapturedState,null);
});

test('v2 active/proof/conflict and recording loss cannot become a complete matching execution',async()=>{
  for(const loss of ['active-limit','proof-limit','identity-conflict','fact-limit','event-sink-failed']){
    const trace=new RunStateTrace();assert.equal(trace.record('unknown-seed',seed,0),true);
    assert.equal(trace.record('unknown-recording-error',{loss},1),false);
    await assert.rejects(replayRunStateTrace(await trace.snapshotBlob(),signal()),/불완전/);
    const events:ExactEvent[]=[{kind:'event',seq:1,time:0,type:'unknown-seed',value:seed},
      {kind:'event',seq:2,time:1,type:'unknown-recording-error',value:{loss}}];
    const result=await executionSummary(archive(events),signal(),{complete:true,dropped:0,events:2,frames:0});
    assert.equal(result.recordingComplete,false);assert.equal(result.unknownLifecycle.matchesCapturedState,null);
  }
});


test('scanner source session sends admitted events to the real state trace and replays the same per-source warnings',async()=>{
  const trace=new RunStateTrace();let time=0;
  const session=new UnknownScanSession({sessionId:'session',recording:{
    record:(type,value)=>trace.record(type,value,time++),
    incomplete:()=>assert.fail('the trace should accept every event'),
  }});
  const first=warning(1),second=warning(2);
  if(first.kind!=='upsert'||second.kind!=='upsert')throw Error('test setup');
  const picture={pixelKey:'same',preview:()=>'',recognition:()=>''};
  session.report(first,picture);session.report(second,picture);
  session.confirmName(key,'card',source(2),[]);
  assert.equal(session.unresolved(),1);
  assert.equal(session.active()[0].source?.observationId,'obs-1');
  assert.equal(await session.checkpoint(),true);
  const replay=await replayRunStateTrace(await trace.snapshotBlob(),signal());
  assert.equal(replay.unknownLifecycle.active,1);
  assert.equal(replay.unknownLifecycle.matchesCapturedState,true);
});
