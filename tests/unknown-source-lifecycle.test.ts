import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UnknownLifecycle,UnknownSourceLifecycle,hashUnknownSourceLifecycle,unknownSourceKey} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS,type UnknownFact} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';

const limits=UNKNOWN_LIFECYCLE_LIMITS;
const seed={version:2 as const,sessionId:'s',origin:'scan' as const,limits};
const key={kind:'group' as const,sessionId:'s',group:4};
const source=(id:string,order=10,frame=1):ObservationSource=>({sessionId:'s',frameId:frame,observationId:id,
  captureOrder:order,captureTime:order/10,phase:'input',slot:0});
const warning=(src:ObservationSource,pending=false):UnknownFact=>({version:1,kind:'upsert',key,source:src,
  captureOrder:src.captureOrder,captureTime:src.captureTime,pending,reason:'이름 확인',location:null});

test('two sources in a fuzzy group remain separate even with identical capture order',()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a'),b=source('b',10,2);
  assert.notEqual(unknownSourceKey(key,a),unknownSourceKey(key,b));
  state.apply(warning(a));state.apply(warning(b));
  assert.equal(state.unresolved(),2);
  const result=state.confirmName(key,'card-a',a,[])!;
  assert.equal(result.retiredVersions.length,1);assert.equal(state.unresolved(),1);
  assert.deepEqual(state.active().map(entry=>entry.source?.observationId),['b']);
  state.confirmName(key,'card-b',b,[]);assert.equal(state.unresolved(),0);
});

test('same source pending failure becomes final once without duplicating',()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a');
  assert.equal(state.apply(warning(a,true)).accepted,true);
  assert.equal(state.apply(warning(a,true)).suppressedReason,'tied');
  assert.equal(state.apply(warning(a,false)).accepted,true);
  assert.equal(state.apply(warning(a,true)).suppressedReason,'tied');
  assert.equal(state.active().length,1);assert.equal(state.active()[0].pending,false);
});

test('late warning is covered only by an exact source proof',()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a',20),b=source('b',10,2);
  state.confirmName(key,'card-a',a,[]);
  assert.equal(state.apply(warning(a)).suppressedReason,'covered');
  assert.equal(state.apply(warning(b)).accepted,true);assert.equal(state.unresolved(),1);
});

test('reviewed identity does not retire an unknown',()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a');state.apply(warning(a));
  for(const review of [['이름 확인'],['카드 식별 확인'],['그림 보조 식별']])assert.equal(state.confirmName(key,'card',a,review),undefined);
  assert.equal(state.unresolved(),1);
});

test('active overflow is explicit and cannot look complete after existing items retire',()=>{
  const state=new UnknownSourceLifecycle({...seed,limits:{...limits,active:1}}),a=source('a'),b=source('b',20,2);
  state.apply(warning(a));assert.equal(state.apply(warning(b)).suppressedReason,'active-limit');
  assert.equal(state.active()[0].source?.observationId,'a');state.confirmName(key,'card',a,[]);
  assert.equal(state.active().length,0);assert.equal(state.unresolved(),1);
  assert.equal(state.snapshot().evidenceLost,true);assert.equal(state.snapshot().complete,false);
});

test('proof overflow cannot remove an existing unknown',()=>{
  const state=new UnknownSourceLifecycle({...seed,limits:{...limits,groups:1}}),a=source('a'),b=source('b',20,2);
  state.confirmName(key,'card-a',a,[]);state.apply(warning(b));
  assert.equal(state.confirmName(key,'card-b',b,[])?.accepted,false);
  assert.equal(state.active().length,1);assert.equal(state.unresolved(),2);
  assert.ok(state.snapshot().losses.includes('proof-limit'));
});

test('two identities for the same source are a permanent unresolved conflict',()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a');
  state.apply(warning(a));state.confirmName(key,'a',a,[]);assert.equal(state.unresolved(),0);
  assert.equal(state.confirmName(key,'b',a,[])?.accepted,false);
  assert.ok(state.snapshot().losses.includes('identity-conflict'));assert.equal(state.unresolved(),1);
  assert.equal(state.confirmName(key,'a',a,[])?.accepted,false);
  assert.equal(state.apply(warning(a)).accepted,true);
});

test('the same exact source cannot certify different cards through different groups',()=>{
  const a=source('a'),other={...key,group:9};
  for(const reverse of [false,true]){
    const events:UnknownFact[]=[],state=new UnknownSourceLifecycle(seed,{onEvent:event=>events.push(event)});
    const claims=reverse?[[other,'b'],[key,'a']] as const:[[key,'a'],[other,'b']] as const;
    for(const [group,card] of claims){
      state.apply({...warning(a),key:group});
      state.confirmName(group,card,a,[]);
    }
    assert.equal(state.snapshot().evidenceLost,true);
    assert.ok(state.snapshot().losses.includes('identity-conflict'));
    assert.ok(state.unresolved()>0,'a conflicting physical source cannot enable completion');
    assert.equal(state.confirmName(key,'a',a,[])?.accepted,false,'a conflict cannot be erased by a retry');
    state.apply({...warning(a),key});
    assert.ok(state.unresolved()>0,'the source remains conflicted after being shown again');
    const replay=new UnknownSourceLifecycle(seed);for(const event of events)replay.apply(event);
    assert.deepEqual(replay.snapshot(),state.snapshot());
  }
});

test('the same source can confirm the same identity through separate groups',async()=>{
  const a=source('a'),other={...key,group:9};
  const state=new UnknownSourceLifecycle(seed);
  for(const group of [key,other]){
    state.apply({...warning(a),key:group});
    state.confirmName(group,'same-card',a,[]);
    assert.equal(state.confirmName(group,'same-card',a,[])?.accepted,true,'duplicate is idempotent');
  }
  assert.equal(state.unresolved(),0);assert.equal(state.snapshot().complete,true);
  assert.equal(typeof await hashUnknownSourceLifecycle(state.snapshot()),'string');
});

test('different exact sources are not equated by group, frame or capture order',()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a'),b={...source('b'),slot:0};
  state.apply(warning(a));state.apply(warning(b));
  state.confirmName(key,'a',a,[]);state.confirmName(key,'b',b,[]);
  assert.equal(state.unresolved(),0);assert.equal(state.snapshot().complete,true);
});

test('cross-group source conflict is detected even at proof capacity',()=>{
  const state=new UnknownSourceLifecycle({...seed,limits:{...limits,groups:1}}),a=source('a'),other={...key,group:9};
  state.confirmName(key,'a',a,[]);
  assert.equal(state.confirmName(other,'b',a,[])?.accepted,false);
  assert.ok(state.snapshot().losses.includes('identity-conflict'));
  assert.equal(state.unresolved(),1);
});

test('a conflict invalidates all earlier group proofs for the exact same source',async()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a');
  for(const group of [1,2,3])state.confirmName({...key,group},'a',a,[]);
  state.confirmName({...key,group:4},'b',a,[]);
  assert.deepEqual(state.snapshot().proofs.map(proof=>proof.cardId),[null,null,null]);
  assert.equal(state.unresolved(),1);assert.equal(await hashUnknownSourceLifecycle(state.snapshot()),null);
  state.apply({...warning(a),key:{...key,group:2}});
  assert.equal(state.active().length,1,'previously covered warning is no longer suppressed');
});

test('recording sink failure is partial replay evidence, not a made-up live unknown',async()=>{
  const state=new UnknownSourceLifecycle(seed,{onEvent:()=>{throw Error('disk');}}),a=source('a');
  state.confirmName(key,'card',a,[]);
  assert.equal(state.unresolved(),0);assert.equal(state.snapshot().complete,false);
  assert.deepEqual(state.snapshot().losses,['event-sink-failed']);assert.equal(await hashUnknownSourceLifecycle(state.snapshot()),null);
});

test('a rejected event write explicitly marks the record incomplete',async()=>{
  const state=new UnknownSourceLifecycle(seed,{onEvent:()=>false}),a=source('a');
  state.confirmName(key,'card',a,[]);
  assert.equal(state.unresolved(),0);assert.deepEqual(state.snapshot().losses,['event-sink-failed']);
  assert.equal(await hashUnknownSourceLifecycle(state.snapshot()),null);
});

test('timed-out observation remains unresolved until its own successful retry',()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a'),b=source('b',20,2);
  state.apply({...warning(a),reason:'판독 시간 초과'});state.confirmName(key,'other-card',b,[]);
  assert.equal(state.unresolved(),1);state.confirmName(key,'card',a,[]);assert.equal(state.unresolved(),0);
});

test('source hash is independent of insertion order and host locale',async()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('z'),b=source('가',20,2);
  state.apply(warning(a));state.apply(warning(b));
  const snapshot=state.snapshot();
  assert.deepEqual(snapshot.active.map(item=>unknownSourceKey(key,item.source!)),
    snapshot.active.map(item=>unknownSourceKey(key,item.source!)).sort());
  assert.equal(await hashUnknownSourceLifecycle(snapshot),await hashUnknownSourceLifecycle({...snapshot,active:[...snapshot.active].reverse()}));
});

test('state replay and hash preserve distinct source identity and old v1 policy',async()=>{
  const events:UnknownFact[]=[],state=new UnknownSourceLifecycle(seed,{onEvent:event=>events.push(event)});
  const a=source('a'),b=source('b',20,2);state.apply(warning(a));state.apply(warning(b));state.confirmName(key,'b',b,[]);
  const replay=new UnknownSourceLifecycle(seed);for(const event of events)replay.apply(event);
  assert.deepEqual(replay.snapshot(),state.snapshot());
  assert.equal(await hashUnknownSourceLifecycle(replay.snapshot()),await hashUnknownSourceLifecycle(state.snapshot()));
  const legacy=new UnknownLifecycle({version:1,sessionId:'s',origin:'scan',limits});
  legacy.apply(warning(a));legacy.apply(warning(b));assert.equal(legacy.active().length,1);
  legacy.confirmName(key,'b',b,[]);assert.equal(legacy.active().length,0);
  assert.equal(state.active().length,1,'v2 retains the different source');
});

test('reject invalid/cross-session source and malformed or duplicate snapshots',async()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a');state.apply(warning(a));
  assert.throws(()=>state.apply(warning({...a,sessionId:'other'})));
  const snapshot=state.snapshot();
  await assert.rejects(()=>hashUnknownSourceLifecycle({...snapshot,active:[...snapshot.active,...snapshot.active]}));
  await assert.rejects(()=>hashUnknownSourceLifecycle({...snapshot,evidenceLost:true}));
});

test('a supposedly complete snapshot cannot contain conflicting identities for one exact source',async()=>{
  const state=new UnknownSourceLifecycle(seed),a=source('a'),other={...key,group:9};
  state.confirmName(key,'card-a',a,[]);state.confirmName(other,'card-a',a,[]);
  const snapshot=state.snapshot();
  await assert.rejects(()=>hashUnknownSourceLifecycle({...snapshot,
    proofs:snapshot.proofs.map((proof,index)=>index?{...proof,cardId:'card-b'}:proof)}),/conflicting identities/);
});
