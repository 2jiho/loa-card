import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canSkipRecovery,canFinishVerifiedCapture,confirmedReadingCount} from '../src/features/card-scanner/session/recovery-completion';
import type {RecoveryCompletion} from '../src/features/card-scanner/session/recovery-completion';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

const card:ScannedCard={id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,
 confidence:1,review:[],image:'',time:1,observations:1,captureOrder:20};
function complete():RecoveryCompletion {
 return {expected:2,finalExpected:2,cards:[card,{...card,id:'b',extraCopies:0}],
  latest:new Map([['a',20],['b',10]]),confirmed:new Map([['a',20],['b',10]]),
  pending:0,unresolved:0,dropped:0,inputSettled:true,tailFresh:true,fieldChangesSettled:true};
}

test('reading progress excludes seeds, stale proofs and incomplete fields without counting duplicates',()=>{
 const input=complete();
 assert.equal(confirmedReadingCount(input),2);
 assert.equal(confirmedReadingCount({...input,latest:new Map(),confirmed:new Map()}),0);
 assert.equal(confirmedReadingCount({...input,latest:new Map([['a',21],['b',10]])}),1);
 assert.equal(confirmedReadingCount({...input,cards:[...input.cards,card]}),2);
 for(const change of [{awakening:null},{extraCopies:null},{countReliable:false},{review:['장수 확인']},{awakening:4,extraCopies:10}])
  assert.equal(confirmedReadingCount({...input,cards:[{...card,...change},input.cards[1]]}),1);
});
test('all freshly confirmed cards including zero extras can finish without replay',()=>{
 assert.equal(canSkipRecovery(complete()),true);
});

test('an absent or invalid freshness guard cannot skip saved-input recovery',()=>{
 for(const fieldChangesSettled of [undefined,null,false,0,'true']){
  const current={...complete(),fieldChangesSettled} as RecoveryCompletion;
  assert.equal(canSkipRecovery(current),false,String(fieldChangesSettled));
  assert.equal(canFinishVerifiedCapture(current,true),false,String(fieldChangesSettled));
 }
});

test('automatic stop does not skip recovery while unmatched crops remain',()=>{
 const input={...complete(),unresolved:5};
 assert.equal(canSkipRecovery(input),false);
 assert.equal(canFinishVerifiedCapture(input,false),false,'manual stop still needs recovery');
 assert.equal(canFinishVerifiedCapture(input,true),false);
 assert.equal(input.unresolved,5,'unmatched inputs remain reviewable, never silently discarded');
 assert.equal(canFinishVerifiedCapture({...input,unresolved:0},true),true,'freshly resolved input may finish');
 for(const change of [{expected:3},{finalExpected:3},{confirmed:new Map<string,number>()},
  {latest:new Map([['a',21],['b',10]])},{pending:1},{dropped:1},{inputSettled:false},{tailFresh:false},
  {cards:[{...card,extraCopies:null},input.cards[1]]}])
  assert.equal(canFinishVerifiedCapture({...input,...change},true),false);
});
test('matching saved inventory is not a fresh scan',()=>{
 assert.equal(canSkipRecovery({...complete(),latest:new Map()}),false);
 assert.equal(canSkipRecovery({...complete(),confirmed:new Map([['a',20]])}),false);
 assert.equal(canSkipRecovery({...complete(),latest:new Map([['a',20],['old',10]])}),false);
});
test('a newer uncertain reading blocks completion even if old consensus has no review',()=>{
 assert.equal(canSkipRecovery({...complete(),latest:new Map([['a',21],['b',10]])}),false);
});
test('pending or unresolved work and acquisition loss keep recovery enabled',()=>{
 for(const field of ['pending','unresolved','dropped'] as const)
  assert.equal(canSkipRecovery({...complete(),[field]:1}),false,field);
 for(const field of ['inputSettled','tailFresh'] as const)
  assert.equal(canSkipRecovery({...complete(),[field]:false}),false,field);
 for(const field of ['pending','unresolved','dropped'] as const)
  for(const invalid of [NaN,Infinity,-1,undefined])
   assert.equal(canSkipRecovery({...complete(),[field]:invalid}),false,`${field} must be a known zero`);
});
test('missing changed and invalid totals never certify completion',()=>{
 for(const expected of [null,0,-1,1,3,2.5,NaN,Infinity])assert.equal(canSkipRecovery({...complete(),expected}),false);
 for(const finalExpected of [null,0,1,3,NaN])assert.equal(canSkipRecovery({...complete(),finalExpected}),false);
 assert.equal(canSkipRecovery({...complete(),cards:[card,card]}),false);
});
test('names and every field require explicit confirmation',()=>{
 for(const change of [{awakening:null},{extraCopies:null},{countReliable:false},{countReliable:undefined},{review:['이름 확인']},
   {awakening:NaN},{extraCopies:NaN},{awakening:6},{extraCopies:-1},{awakening:5,extraCopies:1}])
  assert.equal(canSkipRecovery({...complete(),cards:[{...card,...change},{...card,id:'b'}]}),false);
 for(const value of [NaN,Infinity,-Infinity])
  assert.equal(canSkipRecovery({...complete(),confirmed:new Map([['a',value],['b',10]])}),false);
});

test('verified automatic stop tolerates a transient missing layout only with a recent header',async()=>{
 const {freshCaptureTail}=await import('../src/features/card-scanner/session/recovery-completion');
 assert.equal(freshCaptureTail(false,true,12.67,13.09),true);
 assert.equal(freshCaptureTail(false,false,12.67,13.09),false);
 assert.equal(freshCaptureTail(true,false,12.67,13.09),true);
 for(const last of [-Infinity,NaN,10,14])assert.equal(freshCaptureTail(false,true,last,13.09),false);
 assert.equal(freshCaptureTail(false,true,12.67,undefined),false);
 const input={...complete(),unresolved:0,tailFresh:freshCaptureTail(false,true,12.67,13.09)};
 assert.equal(canFinishVerifiedCapture(input,true),true);
 for(const change of [{pending:1},{dropped:1},{confirmed:new Map<string,number>()}])
  assert.equal(canFinishVerifiedCapture({...input,...change},true),false);
});
