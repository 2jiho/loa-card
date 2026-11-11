import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UnknownRecoveryClaimReplay,parseUnknownRecoveryClaim,parseUnknownRecoveryClaimSeed,type UnknownRecoveryClaim} from '../src/features/card-scanner/reproduction/unknown-recovery-claim-replay';
import {UnknownLifecycle,UnknownSourceLifecycle,hashUnknownLifecycle,hashUnknownSourceLifecycle,parseUnknownReplaySeed} from '../src/features/card-scanner/session/unknown-lifecycle';
import {UNKNOWN_LIFECYCLE_LIMITS,type UnknownFact} from '../src/features/card-scanner/session/unknown-lifecycle-types';
import type {ObservationSource} from '../src/features/card-scanner/session/observation-execution';

const seed={version:3 as const,sessionId:'s',origin:'scan' as const,limits:UNKNOWN_LIFECYCLE_LIMITS};
const key={kind:'group' as const,sessionId:'s',group:1};
const src=(id:string,frame=1):ObservationSource=>({sessionId:'s',frameId:frame,observationId:id,captureOrder:7,captureTime:5,phase:'input',slot:0});
const warning=(source:ObservationSource):UnknownFact=>({version:1,kind:'upsert',key,source,captureOrder:source.captureOrder,captureTime:source.captureTime,pending:false,reason:'name',location:null});
const rect={x:1,y:1,width:10,height:10};
const claim=(originalSource:ObservationSource,cardId='card-a',recoveryId='recovery'):UnknownRecoveryClaim=>({version:3,kind:'recovery-confirmed',target:{key,originalSource},recovery:{source:{...originalSource,phase:'recovery',frameId:11,observationId:recoveryId},attemptId:2,cardId,review:[]},physical:{sourceFrameId:42,sha256:'a'.repeat(64),width:100,height:100,captureTime:5,originalContent:rect,recoveryContent:rect,originalPreview:rect,recoveryPreview:rect}});

test('v3 retains actual recovery provenance and targets only its original source',async()=>{
  const a=src('a'),b=src('b',2),state=new UnknownRecoveryClaimReplay(seed);
  const events=[warning(a),warning(b),claim(a)];
  for(const event of events)state.apply(event);
  assert.equal(state.unresolved(),1);
  assert.deepEqual(state.snapshot().state.active.map(entry=>entry.source?.observationId),['b']);
  assert.deepEqual(state.snapshot().claims[0],claim(a));
  assert.equal(state.snapshot().pixelsAuthenticated,false);
  assert.equal(state.snapshot().recognitionAuthenticated,false);
  assert.equal(state.snapshot().liveAuthorization,false);
  assert.equal(state.apply(warning(a))?.suppressedReason,'covered');
  const replay=new UnknownRecoveryClaimReplay(seed);for(const event of [...events,warning(a)])replay.apply(event);
  assert.deepEqual(replay.snapshot(),state.snapshot());assert.equal(await replay.hash(),await state.hash());
});
test('a late warning only inherits a claim for its exact original and group',()=>{
  const a=src('a'),b=src('b',2),state=new UnknownRecoveryClaimReplay(seed);
  state.apply(claim(a));assert.equal(state.apply(warning(a))?.suppressedReason,'covered');
  state.apply(warning(b));state.apply({...warning(a),key:{...key,group:2}} as UnknownFact);
  assert.equal(state.unresolved(),2);
});
test('contradictory identities are a permanent incomplete state',async()=>{
  const a=src('a'),state=new UnknownRecoveryClaimReplay(seed);state.apply(warning(a));
  state.apply(claim(a));state.apply(claim(a,'other','other-recovery'));
  assert.equal(state.snapshot().state.evidenceLost,true);assert.equal(state.snapshot().complete,false);
  assert.equal(await state.hash(),null);assert.ok(state.unresolved()>0);
});
test('one recovery source cannot claim two original inputs',()=>{
  const a=src('a'),b=src('b',2),state=new UnknownRecoveryClaimReplay(seed);state.apply(warning(a));state.apply(warning(b));
  state.apply(claim(a));const second=claim(b);state.apply(second);
  assert.equal(state.snapshot().conflictingRecovery,true);assert.equal(state.snapshot().state.active.length,1);assert.ok(state.unresolved()>0);
});
test('a recovery source cannot be rebound to different physical metadata or contradictory attempt results',()=>{
  const a=src('a'),first=claim(a);
  for(const altered of [
    {...first,physical:{...first.physical,sha256:'b'.repeat(64)}},
    {...first,physical:{...first.physical,sourceFrameId:43}},
    {...first,physical:{...first.physical,originalContent:{...rect,x:2},recoveryContent:{...rect,x:2}}},
    {...first,recovery:{...first.recovery,cardId:'different'}}
  ]){
    const state=new UnknownRecoveryClaimReplay(seed);state.apply(warning(a));state.apply(first);state.apply(altered);
    assert.equal(state.snapshot().conflictingRecovery,true);assert.equal(state.snapshot().complete,false);assert.ok(state.unresolved()>0);
  }
  const retry=new UnknownRecoveryClaimReplay(seed);retry.apply(first);
  retry.apply({...first,recovery:{...first.recovery,attemptId:3}});
  assert.equal(retry.snapshot().conflictingRecovery,false);
});
test('rejected cross-session or malformed facts do not consume event budget',()=>{
  const state=new UnknownRecoveryClaimReplay({...seed,limits:{...seed.limits,facts:1}}),first=claim(src('a'));
  const otherSource={...first.target.originalSource,sessionId:'other'},otherRecovery={...first.recovery.source,sessionId:'other'};
  const other={...first,target:{key:{...key,sessionId:'other'},originalSource:otherSource},recovery:{...first.recovery,source:otherRecovery}};
  assert.throws(()=>state.apply(other));assert.throws(()=>state.apply({...first,physical:{...first.physical,sha256:'bad'}}));
  assert.equal(state.snapshot().events,0);state.apply(first);assert.equal(state.snapshot().complete,true);
});
test('bounded loss does not silently retire an unknown',async()=>{
  const a=src('a'),state=new UnknownRecoveryClaimReplay({...seed,limits:{...seed.limits,facts:1}});
  state.apply(warning(a));state.apply(claim(a));
  assert.equal(state.snapshot().overflow,true);assert.equal(state.snapshot().state.active.length,1);
  assert.ok(state.unresolved()>0);assert.equal(await state.hash(),null);
});
test('malformed or reviewed recovery metadata cannot be normalized into a claim',()=>{
  const c=claim(src('a'));
  for(const input of [{...c,recovery:{...c.recovery,review:['needs review']}},
    {...c,recovery:{...c.recovery,source:{...c.recovery.source,slot:1}}},
    {...c,physical:{...c.physical,sha256:'z'.repeat(64)}},
    {...c,physical:{...c.physical,recoveryContent:{...rect,x:2}}},
    {...c,target:{...c.target,originalSource:{...c.target.originalSource,sessionId:'other'}}}])assert.throws(()=>parseUnknownRecoveryClaim(input));
  assert.throws(()=>parseUnknownRecoveryClaimSeed({...seed,version:2}));
  assert.throws(()=>parseUnknownReplaySeed(seed));
});
test('accessors and non-data objects are rejected before semantic validation or event counting',()=>{
  const c=claim(src('a')),physical={...c.physical};let reads=0;
  Object.defineProperty(physical,'sha256',{enumerable:true,get(){reads++;return reads<3?'a'.repeat(64):'invalid';}});
  assert.throws(()=>parseUnknownRecoveryClaim({...c,physical}));assert.equal(reads,0);
  const source={...c.target.originalSource};Object.defineProperty(source,'slot',{enumerable:true,get(){throw Error('read');}});
  const state=new UnknownRecoveryClaimReplay(seed);
  assert.throws(()=>state.apply({...c,target:{...c.target,originalSource:source}}));
  assert.equal(state.snapshot().events,0);
  const legacy=warning(src('a')) as Extract<UnknownFact,{kind:'upsert'}>;
  assert.throws(()=>state.apply({...legacy,source}));assert.equal(state.snapshot().events,0);
  assert.throws(()=>parseUnknownRecoveryClaimSeed({...seed,limits:Object.create({active:1})}));
});
test('v3 replay leaves prior versions and independent latest fields untouched',async()=>{
  const a=src('a'),v1=new UnknownLifecycle({...seed,version:1}),v2=new UnknownSourceLifecycle({...seed,version:2});
  for(const state of [v1,v2])state.apply(warning(a));
  const v1bytes=JSON.stringify(v1.snapshot()),v2bytes=JSON.stringify(v2.snapshot());
  const v1hash=await hashUnknownLifecycle(v1.snapshot()),v2hash=await hashUnknownSourceLifecycle(v2.snapshot());
  assert.equal(v1hash,'a46ec0c93ad11dc651b24d5bc98a2bcb74a947a9c5c59d5555fdadd62fdd816b');
  assert.equal(v2hash,'7ce0c9eb5d9b66596e94cb2ffb7b2530238eefdfc3c3810df8f622ed74de287c');
  const latest={awakening:{value:3,time:9},copies:{value:4,time:11}};
  const before=structuredClone(latest),experimental=new UnknownRecoveryClaimReplay(seed);
  experimental.apply(warning(a));experimental.apply(claim(a));
  assert.deepEqual(latest,before);
  assert.equal(JSON.stringify(v1.snapshot()),v1bytes);assert.equal(JSON.stringify(v2.snapshot()),v2bytes);
  assert.equal(await hashUnknownLifecycle(v1.snapshot()),v1hash);assert.equal(await hashUnknownSourceLifecycle(v2.snapshot()),v2hash);
});
