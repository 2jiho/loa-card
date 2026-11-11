import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CURRENT_INVENTORY_CONSENSUS_POLICY,InventoryEvidence,hashInventoryEvidence,parseInventorySeed,
 inventoryEventData,serializeInventorySeed} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';
import {InventoryEvidenceReplay} from '../src/features/card-scanner/reproduction/inventory-evidence-replay';
import {recordedNameV1Consensus} from '../src/features/card-scanner/recognition/consensus';
import {RunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';

const signal=()=>new AbortController().signal;
const src:InventorySource={sessionId:'scan',frameId:2,observationId:'2',captureOrder:2,captureTime:2,
 phase:'input',slot:0,frame:'scan/frame-2'};
const card:ScannedCard={id:'card',name:'카드',awakening:0,extraCopies:2,confidence:1,review:[],image:'',
 time:2,observations:1,captureOrder:2,countReliable:true,capturePosition:{frame:src.frame,slot:0,stable:true,sort:null}};

test('v5 requires an explicit known policy and leaves v1-v4 encoded seeds unchanged',()=>{
 assert.equal(serializeInventorySeed([]),'{"version":1,"cards":[]}');
 assert.equal(serializeInventorySeed([],'prior-run'),'{"version":2,"seedPolicy":"prior-run","cards":[]}');
 assert.equal(serializeInventorySeed([],'prior-run-v2'),'{"version":3,"seedPolicy":"prior-run-v2","cards":[]}');
 assert.equal(serializeInventorySeed([],'prior-run-v3'),'{"version":4,"seedPolicy":"prior-run-v3","cards":[]}');
 const encoded=serializeInventorySeed([],'prior-run-v3',CURRENT_INVENTORY_CONSENSUS_POLICY);
 assert.deepEqual(parseInventorySeed(encoded),{version:5,seedPolicy:'prior-run-v3',consensusPolicy:'recorded-name-v1',cards:[]});
 for(const bad of [
  {version:5,seedPolicy:'prior-run-v3',cards:[]},
  {version:5,seedPolicy:'prior-run-v3',consensusPolicy:'unknown',cards:[]},
  {version:5,seedPolicy:'prior-run',consensusPolicy:'recorded-name-v1',cards:[]},
  {version:4,seedPolicy:'prior-run-v3',consensusPolicy:'recorded-name-v1',cards:[]},
 ])assert.throws(()=>parseInventorySeed(bad));
 assert.throws(()=>serializeInventorySeed([],undefined,CURRENT_INVENTORY_CONSENSUS_POLICY));
 assert.throws(()=>new InventoryEvidence([],{seedPolicy:'prior-run-v3',consensusPolicy:'unknown' as never}));
 assert.throws(()=>new InventoryEvidence([],{legacyRepeatCandidate:true,consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY}));
});

test('v5 recorded policy preserves v4 reducer state and declares no producer authentication',async()=>{
 const events:unknown[]=[],live=new InventoryEvidence([],{seedPolicy:'prior-run-v3',consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY,
  onEvent:event=>events.push(inventoryEventData(event))});
 live.acceptIdentity(src,card.id);live.confirmName(src,card.id,card.name);live.recordObservation(src,card,1);
 const expected=await hashInventoryEvidence(live.snapshot());
 // This broader end-to-end snapshot also detects changes outside consensus;
 // a policy declaration alone does not freeze the entire inventory reducer.
 assert.equal(expected,'d056a538ea5fd0695451ffb400c4d417070f4b551710adcf34001b73bf7e4207');
 for(const version of [4,5] as const){
  const seed=version===4?{version,seedPolicy:'prior-run-v3',cards:[]}:
   {version,seedPolicy:'prior-run-v3',consensusPolicy:CURRENT_INVENTORY_CONSENSUS_POLICY,cards:[]};
  const inventory=new InventoryEvidenceReplay(signal());inventory.seed(seed);
  for(const event of events)inventory.accept(event);
  inventory.checkpoint({complete:true,hash:expected});
  assert.equal((await inventory.summary()).matchesCapturedState,true);
  assert.deepEqual(inventory.policy(),{status:version===5?'declared':'not-recorded',
   declared:version===5?CURRENT_INVENTORY_CONSENSUS_POLICY:null,producerAuthenticated:false});
  const trace=new RunStateTrace();let clock=0;trace.record('inventory-seed',seed,clock++);
  for(const event of events)trace.record('inventory-event',event,clock++);
  trace.record('inventory-checkpoint',{complete:true,hash:expected},clock++);
  const result=await replayRunStateTrace(await trace.snapshotBlob(),signal());
  assert.equal(result.inventory.matchesCapturedState,true);assert.deepEqual(result.inventoryPolicy,inventory.policy());
 }
});

test('recorded-name-v1 keeps tentative identity fields out of a confirmed card',()=>{
 const tentative:ScannedCard={...card,awakening:4,extraCopies:1,review:['이름 확인'],captureOrder:3,time:3};
 const result=recordedNameV1Consensus([card,tentative]);
 assert.equal(result.card.name,'카드');
 assert.deepEqual([result.card.awakening,result.card.extraCopies],[0,2]);
 assert.deepEqual(result.card.review,[]);
 assert.equal(result.card.nameConfirmedBy,undefined);
});
