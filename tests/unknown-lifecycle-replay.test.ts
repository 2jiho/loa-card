import test from 'node:test';
import assert from 'node:assert/strict';
import {UnknownLifecycle,hashUnknownLifecycle} from '../src/features/card-scanner/unknown-lifecycle';
import {UnknownLifecycleReplay} from '../src/features/card-scanner/unknown-lifecycle-replay';
import {UNKNOWN_LIFECYCLE_LIMITS} from '../src/features/card-scanner/unknown-lifecycle-types';
import type {UnknownFact,UnknownSeed,UnknownUpsert} from '../src/features/card-scanner/unknown-lifecycle-types';

const signal=()=>new AbortController().signal;
const seed:UnknownSeed={version:1,sessionId:'unknown-replay',origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS};
const warning=(group:number,order:number,pending=false):UnknownUpsert=>({
  version:1,kind:'upsert',key:{kind:'group',sessionId:seed.sessionId,group},
  source:{sessionId:seed.sessionId,frameId:order,observationId:`observation-${order}-${group}`,captureOrder:order,
    captureTime:order/10,phase:'input',slot:group%40},
  captureOrder:order,captureTime:order/10,pending,reason:'이름 확인 필요',location:{percent:20,column:1,row:7},
});
const proof=(group:number,order:number,cardId='card-a'):UnknownFact=>({
  version:1,kind:'retire',cause:'confirmed-name',key:{kind:'group',sessionId:seed.sessionId,group},
  proof:{cardId,source:warning(group,order).source!},
});
async function complete(replay:UnknownLifecycleReplay,core:UnknownLifecycle){
  const snapshot=core.snapshot(),hash=await hashUnknownLifecycle(snapshot);
  assert.ok(hash);replay.checkpoint({version:1,complete:true,events:snapshot.facts,hash});return hash;
}

test('live authority and replay preserve stale suppression, latest warning and sticky name conflict',async()=>{
  const replay=new UnknownLifecycleReplay(signal()),core=new UnknownLifecycle(seed);
  replay.seed(seed);
  const facts=[warning(1,10,true),warning(1,30),proof(1,20),warning(2,11),proof(2,12),
    warning(2,10),proof(2,13,'card-b'),proof(2,14),warning(2,15,true)];
  for(const fact of facts){core.apply(fact);replay.accept(fact);}
  const hash=await complete(replay,core),summary=await replay.summary();
  assert.deepEqual(summary,{supported:true,events:facts.length,active:2,pending:1,final:1,
    complete:true,hash,expectedHash:hash,matchesCapturedState:true});
  const second=new UnknownLifecycleReplay(signal());second.seed(seed);facts.forEach(fact=>second.accept(fact));
  second.checkpoint({version:1,complete:true,events:facts.length,hash});
  assert.deepEqual(await second.summary(),summary);
});

test('seedless legacy is explicitly unsupported and later facts invalidate a prior checkpoint',async()=>{
  const legacy=new UnknownLifecycleReplay(signal());
  assert.deepEqual(await legacy.summary(),{supported:false,events:0,active:0,pending:0,final:0,
    complete:false,hash:null,expectedHash:null,matchesCapturedState:null});
  const core=new UnknownLifecycle(seed),replay=new UnknownLifecycleReplay(signal());replay.seed(seed);
  const empty=await complete(replay,core);assert.equal((await replay.summary()).matchesCapturedState,true);
  const fact=warning(1,1);core.apply(fact);replay.accept(fact);
  const changed=await replay.summary();assert.equal(changed.complete,false);assert.equal(changed.expectedHash,null);
  assert.equal(changed.matchesCapturedState,null);assert.notEqual(changed.hash,empty);
  await complete(replay,core);assert.equal((await replay.summary()).matchesCapturedState,true);
  replay.checkpoint({version:1,complete:false,events:1,hash:null});
  assert.equal((await replay.summary()).matchesCapturedState,null);
});

test('changed valid facts mismatch the captured hash even when active and event counts match',async()=>{
  const core=new UnknownLifecycle(seed);core.apply(warning(1,10));
  const hash=await hashUnknownLifecycle(core.snapshot());
  const replay=new UnknownLifecycleReplay(signal());replay.seed(seed);replay.accept({...warning(1,10),reason:'판독 시간 초과'});
  replay.checkpoint({version:1,complete:true,events:1,hash});
  const summary=await replay.summary();assert.equal(summary.active,1);assert.equal(summary.events,1);
  assert.equal(summary.complete,true);assert.equal(summary.matchesCapturedState,false);
});

test('missing, duplicate, malformed and incompatible lifecycle events are rejected without recovery by later seed',async()=>{
  const unseeded=new UnknownLifecycleReplay(signal());assert.throws(()=>unseeded.accept(warning(1,1)),/시작 상태/);
  assert.throws(()=>unseeded.seed(seed),/유효하지/);
  const duplicate=new UnknownLifecycleReplay(signal());duplicate.seed(seed);assert.throws(()=>duplicate.seed(seed),/중복/);
  const unseededCheckpoint=new UnknownLifecycleReplay(signal());
  assert.throws(()=>unseededCheckpoint.checkpoint({version:1,complete:true,events:0,hash:'a'.repeat(64)}),/시작 상태/);
  for(const value of [{...warning(1,1),image:'data:image/png;base64,AAAA'},
    {...warning(1,1),source:{...warning(1,1).source,frame:'extra'}},
    {...warning(1,1),captureOrder:2}, {...warning(1,1),key:{kind:'group',sessionId:'other',group:1}}]){
    const replay=new UnknownLifecycleReplay(signal());replay.seed(seed);assert.throws(()=>replay.accept(value));
    await assert.rejects(replay.summary(),/유효하지/);
  }
});

test('complete checkpoints detect omitted and duplicate facts while incomplete cap checkpoints stay partial',async()=>{
  for(const count of [0,2]){
    const replay=new UnknownLifecycleReplay(signal());replay.seed(seed);replay.accept(warning(1,1));
    assert.throws(()=>replay.checkpoint({version:1,complete:true,events:count,hash:'a'.repeat(64)}),/이벤트 수/);
  }
  const replay=new UnknownLifecycleReplay(signal());replay.seed(seed);replay.accept(warning(1,1));
  replay.checkpoint({version:1,complete:false,events:20_001,hash:null});
  const partial=await replay.summary();assert.equal(partial.events,1);assert.equal(partial.complete,false);
  assert.equal(partial.expectedHash,null);assert.equal(partial.matchesCapturedState,null);
  const cappedSeed={...seed,limits:{...seed.limits,facts:1}},capped=new UnknownLifecycleReplay(signal());
  capped.seed(cappedSeed);capped.accept(warning(1,1));capped.accept(warning(2,2));
  capped.checkpoint({version:1,complete:true,events:2,hash:'a'.repeat(64)});
  const lost=await capped.summary();assert.equal(lost.supported,true);assert.equal(lost.complete,false);
  assert.equal(lost.hash,null);assert.equal(lost.matchesCapturedState,null);
});

test('summary captures one state boundary and cancellation never returns a partial equality',async()=>{
  const controller=new AbortController(),core=new UnknownLifecycle(seed),replay=new UnknownLifecycleReplay(controller.signal);
  replay.seed(seed);const hash=await complete(replay,core);
  const before=replay.summary();replay.accept(warning(1,1));
  const snapshot=await before;assert.equal(snapshot.active,0);assert.equal(snapshot.hash,hash);
  assert.equal(snapshot.matchesCapturedState,true);assert.equal((await replay.summary()).active,1);
  controller.abort();assert.throws(()=>replay.accept(warning(2,2)),{name:'AbortError'});
  await assert.rejects(replay.summary(),{name:'AbortError'});
});
