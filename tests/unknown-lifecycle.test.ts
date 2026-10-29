import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UnknownLifecycle,hashUnknownLifecycle,parseUnknownFact,parseUnknownSeed,parseUnknownCheckpoint,
  unknownKeyId,unknownVersionId} from '../src/features/card-scanner/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS,type UnknownSeed,type UnknownUpsert,type UnknownFact} from '../src/features/card-scanner/unknown-lifecycle-types';
import type {ObservationSource} from '../src/features/card-scanner/observation-execution';
import {updateUnknown} from '../src/features/card-scanner/unknown-observations';
import {ConfirmedNameGroups} from '../src/features/card-scanner/confirmed-name-groups';

const seed:UnknownSeed={version:1,sessionId:'session',origin:'scan',limits:UNKNOWN_LIFECYCLE_LIMITS};
const key=(group=1)=>({kind:'group' as const,sessionId:'session',group});
function source(order=10):ObservationSource {
  return {sessionId:'session',frameId:order,observationId:`obs-${order}`,captureOrder:order,
    captureTime:order/10,phase:'input',slot:0};
}
function upsert(order=10,pending=false,group=1,reason='이름 확인 필요'):UnknownUpsert {
  return {version:1,kind:'upsert',key:key(group),source:source(order),captureOrder:order,captureTime:order/10,
    pending,reason,location:{percent:30,column:1,row:104}};
}
function lifecycle(limits:Partial<UnknownSeed['limits']>={}) {
  return new UnknownLifecycle({...seed,limits:{...seed.limits,...limits}});
}

test('latest failure survives older proof, exact retired version is returned only when covered',()=>{
  const state=lifecycle();state.apply(upsert(10));state.apply(upsert(30));
  const before=state.active()[0];
  assert.deepEqual(state.confirmName(key(),'a',source(20),[])?.retiredVersions,[]);
  assert.equal(state.active()[0],before);
  const retired=state.confirmName(key(),'a',source(30),[])!;
  assert.deepEqual(retired.retiredVersions,[before]);assert.equal(state.active().length,0);
});

test('proof without warning suppresses delayed candidates but not a fresher failure',()=>{
  const events:UnknownFact[]=[];const state=new UnknownLifecycle(seed,{onEvent:event=>events.push(event)});
  assert.equal(state.confirmName(key(),'a',source(30),[])?.changed,true);
  assert.equal(state.apply(upsert(10)).suppressedReason,'covered');
  assert.equal(state.apply(upsert(30)).suppressedReason,'covered');
  assert.equal(state.apply(upsert(31)).changed,true);
  assert.equal(events.length,4,'suppressed candidates remain replay input facts');
});

test('equal-order failures preserve first final and permit pending to final only',()=>{
  const state=lifecycle();state.apply(upsert(30,false,1,'first'));
  assert.equal(state.apply(upsert(30,true)).suppressedReason,'tied');
  assert.equal(state.apply(upsert(20)).suppressedReason,'older');
  assert.equal(state.apply(upsert(30,false,1,'second')).suppressedReason,'tied');
  assert.equal(state.active()[0].reason,'first');
  assert.equal(state.apply(upsert(40,true)).changed,true);
  assert.equal(state.apply(upsert(40,false)).changed,true);
  assert.equal(state.active()[0].pending,false);
});

test('different observation groups stay separate and uncertain names never retire',()=>{
  const state=lifecycle();state.apply(upsert(10,false,1));state.apply(upsert(10,false,2));
  assert.equal(state.active().length,2);
  assert.equal(state.confirmName(key(),'a',source(100),['이름 확인']),undefined);
  assert.equal(state.confirmName(key(),'a',{...source(),captureOrder:NaN},[]),undefined);
  assert.equal(state.snapshot().facts,2);
  assert.equal(state.confirmName(key(1),'a',source(10),[])?.retiredVersions.length,1);
  assert.equal(state.active()[0].key.kind,'group');
});

test('A to B to A group collision stays ambiguous without reviving already retired warnings',()=>{
  const state=lifecycle();state.apply(upsert(10));state.confirmName(key(),'a',source(20),[]);
  assert.equal(state.active().length,0);
  state.confirmName(key(),'b',source(30),[]);state.confirmName(key(),'a',source(40),[]);
  assert.equal(state.snapshot().proofs[0].state,null);
  assert.equal(state.apply(upsert(10)).changed,true);
  assert.equal(state.active().length,1);
  state.confirmName(key(),'a',source(50),[]);assert.equal(state.active().length,1);
});

test('legacy import keys remain separate and have no manufactured capture evidence',()=>{
  const state=new UnknownLifecycle({...seed,origin:'legacy-import'});
  const legacy=(entryId:string):UnknownUpsert=>({...upsert(),key:{kind:'legacy',sessionId:'session',entryId},
    source:null,captureOrder:null,captureTime:null});
  state.apply(legacy('import-0'));state.apply(legacy('import-1'));
  state.confirmName(key(),'a',source(100),[]);
  assert.equal(state.active().length,2);assert.equal(state.active()[0].captureTime,null);
  assert.equal(state.apply(legacy('import-0')).suppressedReason,'tied');
  assert.throws(()=>lifecycle().apply(legacy('import-0')),/import seed/);
});

test('same group number from another session cannot mutate this session',()=>{
  const state=lifecycle();state.apply(upsert());
  const other={...upsert(),key:{...key(),sessionId:'other'},source:{...source(),sessionId:'other'}};
  assert.throws(()=>state.apply(other),/session binding/);
  assert.equal(state.snapshot().facts,1);
  assert.notEqual(unknownKeyId(key()),unknownKeyId({...key(),sessionId:'other'}));
});

test('active cap is a recorded policy rejection and does not fake lifecycle loss',async()=>{
  const events:UnknownFact[]=[];const state=new UnknownLifecycle({...seed,limits:{...seed.limits,active:1}},
    {onEvent:event=>events.push(event)});
  state.apply(upsert(10,false,1));
  assert.equal(state.apply(upsert(20,false,2)).suppressedReason,'active-limit');
  assert.equal(state.snapshot().complete,true);assert.equal(events.length,2);
  assert.match((await hashUnknownLifecycle(state.snapshot()))!,/^[a-f0-9]{64}$/);
  state.confirmName(key(),'a',source(10),[]);assert.equal(state.apply(upsert(20,false,2)).changed,true);
});

test('fact budget stops recording and withdraws equality while latest live warnings still progress',async()=>{
  const events:UnknownFact[]=[],losses:string[]=[];
  const state=new UnknownLifecycle({...seed,limits:{...seed.limits,facts:1}},{onEvent:event=>events.push(event),
    onIncomplete:loss=>losses.push(loss)});
  state.apply(upsert(10));state.apply(upsert(20));state.apply(upsert(30));
  assert.equal(state.active()[0].captureOrder,30);assert.equal(state.snapshot().facts,3);
  assert.equal(events.length,1);assert.deepEqual(losses,['fact-limit']);
  assert.equal(await hashUnknownLifecycle(state.snapshot()),null);
});

test('proof budget never evicts old evidence or suppresses a new unrecorded group',async()=>{
  const state=lifecycle({groups:1});state.confirmName(key(1),'a',source(30),[]);
  state.confirmName(key(2),'b',source(40),[]);
  assert.equal(state.snapshot().proofs.length,1);assert.deepEqual(state.snapshot().losses,['group-limit']);
  assert.equal(state.apply(upsert(20,false,2)).changed,true);
  assert.equal(state.apply(upsert(20,false,1)).suppressedReason,'covered');
  state.confirmName(key(1),'c',source(50),[]);assert.equal(state.snapshot().proofs[0].state,null);
  assert.equal(await hashUnknownLifecycle(state.snapshot()),null);
});

test('event sink failure cannot roll back state or repeatedly flood the failed sink',async()=>{
  let calls=0;const losses:string[]=[];
  const state=new UnknownLifecycle(seed,{onEvent:()=>{calls++;throw new Error('disk failed');},
    onIncomplete:loss=>{losses.push(loss);throw new Error('diagnostic failed');}});
  assert.equal(state.apply(upsert(10)).changed,true);state.apply(upsert(20));
  assert.equal(state.active()[0].captureOrder,20);assert.equal(calls,1);
  assert.deepEqual(losses,['event-sink-failed']);assert.equal(await hashUnknownLifecycle(state.snapshot()),null);
  state.markIncomplete('event-sink-failed');assert.equal(losses.length,1);
});

test('snapshots are detached frozen and canonical while active display order remains insertion order',async()=>{
  const state=lifecycle();const fact=upsert(30,false,3);state.apply(fact);state.apply(upsert(10,false,1));
  fact.source!.captureOrder; // caller object is not used as mutable authority
  (fact.location as {row:number}).row=8;
  assert.equal(state.active()[0].location?.row,104);
  assert.deepEqual(state.active().map(entry=>entry.key.kind==='group'?entry.key.group:0),[3,1]);
  const snapshot=state.snapshot();assert.deepEqual(snapshot.active.map(entry=>entry.ordinal),[1,0]);
  assert.ok(Object.isFrozen(snapshot.active[0].source));
  assert.throws(()=>{(snapshot.active as unknown[]).push('fake');});
  const reordered={...snapshot,active:[...snapshot.active].reverse(),proofs:[...snapshot.proofs].reverse()};
  assert.equal(await hashUnknownLifecycle(snapshot),await hashUnknownLifecycle(reordered));
  const version=unknownVersionId(state.active()[0]);
  assert.equal(version,unknownVersionId({...state.active()[0],reason:'다른 진단'}));
  assert.notEqual(version,unknownVersionId({...state.active()[0],pending:true}));
});

test('strict parsers reject malformed, oversized, coerced and extra evidence',()=>{
  assert.throws(()=>parseUnknownSeed({...seed,extra:1}));
  assert.throws(()=>parseUnknownSeed({...seed,limits:{...seed.limits,groups:10_001}}));
  assert.doesNotThrow(()=>parseUnknownSeed({...seed,limits:{active:0,facts:0,groups:0}}));
  const bad:unknown[]=[{...upsert(),source:{...source(),frame:'extra'}},{...upsert(),source:null},
    {...upsert(),captureOrder:11},{...upsert(),captureTime:NaN},{...upsert(),pending:1},
    {...upsert(),reason:'a'.repeat(257)},{...upsert(),image:'data:image/png'},
    {...upsert(),location:{percent:101,column:1}},{...upsert(),location:{percent:20,column:11}},
    {...upsert(),location:{percent:20,column:1,row:0}},{...upsert(),key:{...key(),group:-1}},
    {...upsert(),source:{...source(),slot:40}},{...upsert(),source:{...source(),sessionId:'other'}}];
  for(const value of bad)assert.throws(()=>parseUnknownFact(value));
  assert.throws(()=>parseUnknownCheckpoint({version:1,complete:true,events:1,hash:null}));
  assert.throws(()=>parseUnknownCheckpoint({version:1,complete:false,events:1,hash:'a'.repeat(64)}));
  assert.doesNotThrow(()=>parseUnknownCheckpoint({version:1,complete:false,events:20_001,hash:null}));
});

test('ordered common reducer equals former helpers through mixed retries, confirmations and conflicts',async()=>{
  const state=lifecycle();const names=new ConfirmedNameGroups();
  const old:{group:number;captureOrder:number;pending:boolean;reason:string}[]=[],vectors:Uint8Array[]=[];
  const vector=new Uint8Array(1),facts:UnknownFact[]=[];
  // A deterministic mixed stream exercises suppressed and accepted candidates.
  let random=412;
  for(let i=0;i<3000;i++) {
    random=(Math.imul(random,1664525)+1013904223)>>>0;
    const group=random%20,order=(random>>>5)%100,pending=!!(random&1024);
    if(random%4!==0) {
      const fact=upsert(order,pending,group,`reason-${i}`);facts.push(fact);
      state.apply(fact);
      if(!names.covers(group,order))updateUnknown(old,vectors,{group,captureOrder:order,pending,reason:fact.reason},vector);
    } else {
      const cardId=`card-${random%3}`;names.confirm(group,cardId,order,[]);
      const fact:UnknownFact={version:1,kind:'retire',cause:'confirmed-name',key:key(group),proof:{cardId,source:source(order)}};
      facts.push(fact);state.apply(fact);
      for(let index=old.length-1;index>=0;index--)if(names.covers(old[index].group,old[index].captureOrder)) {
        old.splice(index,1);vectors.splice(index,1);
      }
    }
    assert.deepEqual(state.active().map(entry=>({group:entry.key.kind==='group'?entry.key.group:-1,
      captureOrder:entry.captureOrder,pending:entry.pending,reason:entry.reason})),old);
  }
  const replay=lifecycle();facts.forEach(fact=>replay.apply(fact));
  assert.deepEqual(replay.snapshot(),state.snapshot());
  assert.equal(await hashUnknownLifecycle(replay.snapshot()),await hashUnknownLifecycle(state.snapshot()));
});
