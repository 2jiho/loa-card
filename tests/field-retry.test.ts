import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fieldRetryIdentity,obsoleteFieldRetry,pruneFieldRetries} from '../src/features/card-scanner/field-retry';
import {consensus} from '../src/features/card-scanner/consensus';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

test('only a completed same or newer observation cancels known field work',()=>{
 const retry={needsIdentity:false,fieldTarget:{id:'a',order:20}};
 assert.equal(obsoleteFieldRetry(retry,new Map()),false);
 assert.equal(obsoleteFieldRetry(retry,new Map([['b',30]])),false);
 assert.equal(obsoleteFieldRetry(retry,new Map([['a',19]])),false);
 assert.equal(obsoleteFieldRetry(retry,new Map([['a',20]])),true);
 assert.equal(obsoleteFieldRetry(retry,new Map([['a',21]])),true);
 for(const needsIdentity of [true,undefined])assert.equal(obsoleteFieldRetry({...retry,needsIdentity},new Map([['a',30]])),false);
 assert.equal(obsoleteFieldRetry({needsIdentity:false},new Map([['a',30]])),false);
 for(const order of [NaN,Infinity,-Infinity]){
  assert.equal(obsoleteFieldRetry({...retry,fieldTarget:{id:'a',order}},new Map([['a',30]])),false);
  assert.equal(obsoleteFieldRetry(retry,new Map([['a',order]])),false);
 }
});
test('field-only identity reuse never promotes uncertain or unrelated names',()=>{
 const knownIdentity={id:'a',review:[],name:'카드'};
 const retry={needsIdentity:false,knownIdentity,fieldTarget:{id:'a',order:20}};
 assert.equal(fieldRetryIdentity(retry),knownIdentity);
 assert.equal(fieldRetryIdentity({...retry,needsIdentity:true}),undefined);
 assert.equal(fieldRetryIdentity({...retry,fieldTarget:{id:'b',order:20}}),undefined);
 assert.equal(fieldRetryIdentity({...retry,knownIdentity:{...knownIdentity,review:['이름 확인']}}),undefined);
 assert.equal(fieldRetryIdentity({...retry,knownIdentity:undefined}),undefined);
});
test('pruning releases only obsolete jobs once and preserves unknown/newer job order',()=>{
 const jobs=[{id:'old',needsIdentity:false,fieldTarget:{id:'a',order:1}},
  {id:'unknown',needsIdentity:true,fieldTarget:undefined},
  {id:'new',needsIdentity:false,fieldTarget:{id:'a',order:3}},
  {id:'same',needsIdentity:false,fieldTarget:{id:'a',order:2}},
  {id:'unread',needsIdentity:false,fieldTarget:{id:'b',order:1}}];
 const released:string[]=[],proof=new Map([['a',2]]);
 assert.equal(pruneFieldRetries(jobs,proof,item=>released.push(item.id)),2);
 assert.deepEqual(released,['old','same']);assert.deepEqual(jobs.map(x=>x.id),['unknown','new','unread']);
 assert.equal(pruneFieldRetries(jobs,proof,item=>released.push(item.id)),0);
 proof.set('a',3);assert.equal(pruneFieldRetries(jobs,proof,item=>released.push(item.id)),1);
 assert.deepEqual(released,['old','same','new']);
});
test('retiring old uncertain fields preserves the newest reliable count/awakening pair',()=>{
 const old:ScannedCard={id:'a',name:'카드',awakening:0,extraCopies:null,countReliable:false,confidence:1,review:['추가 장수 확인'],image:'',time:1,captureOrder:1,observations:1};
 const latest:ScannedCard={...old,awakening:1,extraCopies:9,countReliable:true,review:[],time:3,captureOrder:3};
 const retry={...old,extraCopies:4,countReliable:false};
 const a=consensus([old,latest]),b=consensus([old,latest,retry]);
 assert.deepEqual([a.awakening,a.extraCopies,a.review],[b.awakening,b.extraCopies,b.review]);
 assert.deepEqual([a.awakening,a.extraCopies],[1,9]);
});
