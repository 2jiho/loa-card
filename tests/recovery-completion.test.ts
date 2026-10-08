import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canSkipRecovery,confirmedReadingCount} from '../src/features/card-scanner/recovery-completion';
import type {RecoveryCompletion} from '../src/features/card-scanner/recovery-completion';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

const card:ScannedCard={id:'a',name:'카드',awakening:0,extraCopies:1,countReliable:true,
 confidence:1,review:[],image:'',time:1,observations:1,captureOrder:20};
function complete():RecoveryCompletion {
 return {expected:2,finalExpected:2,cards:[card,{...card,id:'b',extraCopies:0}],
  latest:new Map([['a',20],['b',10]]),confirmed:new Map([['a',20],['b',10]]),
  pending:0,unresolved:0,dropped:0,inputSettled:true,tailFresh:true};
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
