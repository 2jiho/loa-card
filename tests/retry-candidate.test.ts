import {test} from 'node:test';
import assert from 'node:assert/strict';
import {admitRetryCandidate,replaceRetry,replaceRetryCandidate,retryCandidateIndex} from '../src/features/card-scanner/session/retry-candidate';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import {FreshObservations} from '../src/features/card-scanner/session/fresh-observation';

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

test('a fuzzy group does not replace another source, identity task or card field task',()=>{
  const source:InventorySource={sessionId:'s',frameId:1,observationId:'one',captureOrder:10,captureTime:1,phase:'input',slot:0,frame:'frame-1'};
  const first={group:1,source,needsIdentity:true,feature:new Uint8Array(3240).fill(90)};
  const changed=[{group:2},{source:{...source,sessionId:'other'}},{source:{...source,frameId:2}},
    {source:{...source,observationId:'two'}},{source:{...source,captureOrder:11}},{source:{...source,captureTime:2}},
    {source:{...source,phase:'recovery' as const}},{source:{...source,slot:1}},{source:{...source,frame:'frame-2'}},
    {needsIdentity:false,fieldTarget:{id:'a',order:10}}];
  for(const difference of changed)assert.equal(retryCandidateIndex([first],{...first,...difference}),-1);
  assert.equal(retryCandidateIndex([first],{...first,feature:new Uint8Array(3240)}),0,'features do not define source');
  const field={...first,needsIdentity:false,fieldTarget:{id:'a',order:10}};
  assert.equal(retryCandidateIndex([field],{...field,fieldTarget:{id:'b',order:10}}),-1);
  assert.equal(retryCandidateIndex([field],{...field,fieldTarget:{id:'a',order:11}}),-1);
});

test('full retry queue retains its old source instead of evicting it for a stable new source',()=>{
  const source:InventorySource={sessionId:'s',frameId:1,observationId:'one',captureOrder:1,captureTime:1,phase:'input',slot:0,frame:'one'};
  const old={group:1,source,needsIdentity:true,order:1,stable:false,borderAlignment:.9};
  const next={...old,source:{...source,frameId:2,observationId:'two',captureOrder:2,captureTime:2,frame:'two'},order:2,stable:true};
  const queue=[old],released:typeof old[]=[];
  assert.equal(admitRetryCandidate(queue,next,1,item=>released.push(item)),'full');
  assert.deepEqual(queue,[old]);assert.deepEqual(released,[]);
  assert.equal(admitRetryCandidate(queue,{...old},1,item=>released.push(item)),'present');
  assert.deepEqual(queue,[old]);assert.deepEqual(released,[]);
  assert.equal(admitRetryCandidate(queue,{...old,borderAlignment:1},1,item=>released.push(item)),'replaced');
  assert.deepEqual(released,[old]);assert.equal(queue.length,1);
  assert.throws(()=>admitRetryCandidate(queue,next,-1,item=>released.push(item)),TypeError);
});

test('shared image, preview, execution or observation is not replaced or released',()=>{
  const source:InventorySource={sessionId:'s',frameId:1,observationId:'one',captureOrder:1,captureTime:1,phase:'input',slot:0,frame:'one'};
  for(const key of ['image','previewCanvas','execution','savedObservation'] as const){
    const shared={},old={group:1,source,needsIdentity:true,order:1,stable:false,borderAlignment:.9,[key]:shared};
    const queue=[old],released:typeof old[]=[];
    const candidate={...old,borderAlignment:1,needsIdentity:false,fieldTarget:{id:'a',order:1}};
    assert.equal(admitRetryCandidate(queue,candidate,2,item=>released.push(item)),'ownership-conflict',key);
    assert.deepEqual(queue,[old]);assert.deepEqual(released,[]);
  }
  const savedObservation={},first={group:1,source,needsIdentity:true,order:1,stable:true,borderAlignment:1,savedObservation};
  const later={...first,source:{...source,frameId:2,observationId:'two',captureOrder:2,captureTime:2,frame:'two'},order:2};
  const queue=[first];assert.equal(admitRetryCandidate(queue,later,2,()=>assert.fail()),'queued',
    'an exact saved observation may be referenced by another source');
});
