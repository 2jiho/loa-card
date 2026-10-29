import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replaceRetry,replaceRetryCandidate,retryCandidateIndex} from '../src/features/card-scanner/retry-candidate';
import {FreshObservations} from '../src/features/card-scanner/fresh-observation';

test('late older retry cannot replace newer capture regardless of finishing order',()=>{
  const old={order:10,stable:true,borderAlignment:1},latest={order:20,stable:true,borderAlignment:.95};
  const queue=[latest],released:typeof old[]=[];
  assert.equal(replaceRetryCandidate(queue,0,old,item=>released.push(item)),false);
  assert.equal(queue[0],latest);assert.equal(released.length,0);
  assert.equal(replaceRetry(latest,{...latest,stable:false,order:30}),false);
  assert.equal(replaceRetry(latest,{...latest,borderAlignment:1}),true);
});

test('replaced retry finishes its saved observation so fresh input can reopen it',()=>{
  const fresh=new FreshObservations<object>(),saved={},next={};
  const old={order:10,stable:true,borderAlignment:.9,saved},replacement={order:20,stable:true,borderAlignment:1,saved:next};
  fresh.remember(1,'old',0,saved);const queue=[old];
  assert.equal(replaceRetryCandidate(queue,0,replacement,item=>fresh.finish(item.saved)),true);
  assert.equal(fresh.retry(1,'new',1,true,()=>false),true);
  fresh.remember(1,'latest',1,next);
  assert.equal(fresh.retry(1,'changed',2,true,()=>false),false,'active replacement still blocks duplicate work');
});

test('identical compressed features cannot replace retry work belonging to another observation group',()=>{
  const vector=new Uint8Array(3240).fill(90),first={group:1,feature:vector},second={group:2,feature:vector.slice()};
  assert.equal(retryCandidateIndex([first],second),-1);
  assert.equal(retryCandidateIndex([first,second],{...second,feature:new Uint8Array(3240)}),1);
});
