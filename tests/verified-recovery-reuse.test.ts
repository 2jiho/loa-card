import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InventoryEvidence,replayInventoryEvidence,hashInventoryEvidence,type InventoryEvent,type InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import {canReuseVerifiedRecovery,exactSourceSavedObservation,sourceObservationFrame,type SavedAcquisition,type SavedObservation} from '../src/features/card-scanner/acquisition/saved-acquisition';
import {canStopSharing} from '../src/features/card-scanner/session/auto-completion';
import {CandidateQueue} from '../src/features/card-scanner/acquisition/candidate-queue';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';

const binding={sourceFrameId:7,captureTime:1,width:100,height:100,hash:'a'.repeat(64)};
const frame=sourceObservationFrame('scan',7,17);
const original:InventorySource={sessionId:'scan',frameId:17,observationId:'original',captureOrder:137,captureTime:1,phase:'input',slot:0,frame};
const recovered:InventorySource={...original,frameId:99,observationId:'recovery',phase:'recovery'};
const cell={slot:0,content:{x:10,y:10,width:40,height:60},preview:{x:8,y:8,width:44,height:64},
  quality:{usable:true,reason:'',sharpness:1}} as SavedAcquisition['cells'][number];
const identity={id:'card',name:'카드',review:[] as string[]};
const card:ScannedCard={...identity,awakening:0,extraCopies:1,confidence:.95,image:'',time:1,observations:1,
  captureOrder:137,capturePosition:{frame,slot:0,stable:true,sort:null},countReliable:true};
function fixture(){
 const observation={order:137,frame,stable:true,identity} as SavedObservation;
 const saved={width:100,height:100,layout:{scale:1} as SavedAcquisition['layout'],cells:[cell],observations:[observation],
  rasterReceipt:{version:1,kind:'measured',...binding,acquisitionFrameId:17}} as SavedAcquisition;
 return {observation,saved};
}
function filled(events?:InventoryEvent[]){
 const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',...(events?{onEvent:event=>events.push(event)}:{})});
 inventory.acceptIdentity(original,card.id);inventory.confirmName(original,card.id,card.name);inventory.recordObservation(original,card,.9);
 return inventory;
}
function completion(inventory:InventoryEvidence){return {expected:1,finalExpected:1,cards:inventory.project([]),
 latest:inventory.latestIdentityOrder,confirmed:inventory.confirmedFieldOrder,confirmedNames:inventory.confirmedNameOrder,
 unresolved:0,dropped:0,inputSettled:true,fieldChangesSettled:true,headerAvailable:true};}

test('verified recovery queued before the original completes reuses its actual current proof without a tie',async()=>{
 const {observation,saved}=fixture();
 // The crop was queued before this original became fully confirmed.
 const verified=exactSourceSavedObservation(saved,binding,cell);
 assert.equal(verified,observation);
 const queue=new CandidateQueue<{group:number;verified:SavedObservation|undefined;saved:SavedObservation;source:InventorySource}>(1,()=>{});
 assert.equal(queue.push({group:1,verified,saved:observation,source:recovered}),true);
 assert.equal(queue.length,1);
 const events:InventoryEvent[]=[],inventory=filled(events),before=await hashInventoryEvidence(inventory.snapshot());
 assert.equal(canStopSharing(completion(inventory)),true);
 const candidate=queue.shift();assert.ok(candidate);
 assert.equal(canReuseVerifiedRecovery({...candidate,identity,inventory,
  freshnessSettled:true,obstructionNeedsProof:false}),true);
 // The scanner takes the existing-proof branch and does not append a new
 // identity acceptance for this second acquisition of the same original.
 assert.equal(await hashInventoryEvidence(inventory.snapshot()),before);
 assert.equal(canStopSharing(completion(inventory)),true);
 const replay=replayInventoryEvidence([],events,{seedPolicy:'prior-run-v3'});
 assert.equal(await hashInventoryEvidence(replay.snapshot()),before);
 const oldPath=filled();oldPath.acceptIdentity(recovered,card.id);oldPath.confirmName(recovered,card.id,card.name);
 assert.equal(canStopSharing(completion(oldPath)),false,'the previous path revoked an already confirmed source');
});

test('a claimed frame, changed source hash, geometry, fields, identity or outstanding debt cannot reuse proof',()=>{
 const {observation,saved}=fixture(),inventory=filled();
 const good=exactSourceSavedObservation(saved,binding,cell);
 const check=(value:Partial<Parameters<typeof canReuseVerifiedRecovery>[0]>)=>canReuseVerifiedRecovery({
  verified:good,saved:observation,identity,source:recovered,inventory,freshnessSettled:true,obstructionNeedsProof:false,...value});
 assert.equal(check({verified:exactSourceSavedObservation(saved,{...binding,hash:'b'.repeat(64)},cell)}),false);
 assert.equal(check({verified:exactSourceSavedObservation(saved,binding,{...cell,content:{...cell.content,x:11}})}),false);
 assert.equal(check({verified:undefined}),false,'a replay claim or matching frame string is not verification');
 assert.equal(check({saved:{...observation}}),false,'the verified observation must be the one consumed');
 assert.equal(check({identity:{...identity,id:'other'}}),false);
 assert.equal(check({identity:{...identity,review:['이름 확인']}}),false);
 assert.equal(check({source:{...recovered,slot:1}}),false);
 assert.equal(check({source:{...recovered,phase:'input'}}),false);
 assert.equal(check({freshnessSettled:false}),false);
 assert.equal(check({obstructionNeedsProof:true}),false);
 const newer={...original,frameId:18,observationId:'newer',captureOrder:138,captureTime:2,frame:'scan/source/8'};
 inventory.acceptIdentity(newer,card.id);
 assert.equal(check({}),false,'a later unresolved input makes the original stale');
});

test('equal-order different inputs and newer failed fields cannot use the earlier proof',()=>{
 const {observation,saved}=fixture(),verified=exactSourceSavedObservation(saved,binding,cell);
 const run=(inventory:InventoryEvidence)=>canReuseVerifiedRecovery({verified,saved:observation,identity,source:recovered,
  inventory,freshnessSettled:true,obstructionNeedsProof:false});
 const tied=filled();tied.acceptIdentity({...original,frameId:18,observationId:'different',frame:'scan/source/8'},card.id);
 assert.equal(run(tied),false);
 const failed=filled(),later={...original,frameId:18,observationId:'later',captureOrder:138,captureTime:2,frame:'scan/source/8'};
 failed.acceptIdentity(later,card.id);failed.confirmName(later,card.id,card.name);
 failed.recordObservation(later,{...card,time:2,captureOrder:138,capturePosition:{frame:later.frame,slot:0,stable:true,sort:null},
  awakening:null,extraCopies:null,countReliable:false,review:['각성 확인']},.9);
 assert.equal(run(failed),false);
});
