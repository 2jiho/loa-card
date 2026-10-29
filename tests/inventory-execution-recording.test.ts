import test from 'node:test';
import assert from 'node:assert/strict';
import {InventoryEvidence,hashInventoryEvidence,inventoryEventData,inventorySeedSnapshot} from '../src/features/card-scanner/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';
import {entryParts,executionSummary,type ExactEvent} from '../src/features/card-scanner/exact-recording-codec';

const signal=()=>new AbortController().signal;
const archive=(events:ExactEvent[])=>new Blob(events.flatMap(event=>entryParts(event)));
const source=(order:number):InventorySource=>({sessionId:'session',frameId:order,observationId:String(order),
  captureOrder:order,captureTime:order/10,slot:0,frame:`frame-${order}`,phase:'input'});
const card=(input:InventorySource,extraCopies:number|null=1):ScannedCard=>({id:'a',name:'카드',awakening:0,
  extraCopies,countReliable:extraCopies!==null,review:extraCopies===null?['추가 장수 확인']:[],
  confidence:.99,image:'data:image/png;base64,private-pixels',time:input.captureTime,observations:1,
  captureOrder:input.captureOrder,capturePosition:{frame:input.frame,slot:input.slot,stable:true,sort:null}});

async function recording(){
  const events:ExactEvent[]=[];
  const emit=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:events.length,type,value});
  const seed=[card(source(1))];emit('inventory-seed',{version:1,cards:inventorySeedSnapshot(seed)});
  const inventory=new InventoryEvidence(seed,{onEvent:event=>emit('inventory-event',inventoryEventData(event))});
  const latest=source(30);inventory.acceptIdentity(latest,'a');inventory.confirmName(latest,'a');
  inventory.recordObservation(latest,card(latest,null),1);
  // A completed older recovery cannot prove the latest failed fields.
  const old={...source(20),phase:'recovery' as const};inventory.acceptIdentity(old,'a');inventory.confirmName(old,'a');
  inventory.recordObservation(old,card(old,0),1);
  const hash=await hashInventoryEvidence(inventory.snapshot());emit('inventory-checkpoint',{complete:true,hash});
  return {events,inventory,hash,emit};
}

test('exact archive replays actual inventory events including stale proof and explicit zero without pixels',async()=>{
  const {events,inventory,hash}=await recording();
  assert.ok(!JSON.stringify(events).includes('private-pixels'));
  const totals={complete:true,dropped:0,events:events.length,frames:0};
  const result=await executionSummary(archive(events),signal(),totals);
  assert.equal(result.recordingComplete,true);
  assert.deepEqual(result.inventory,{supported:true,events:6,cards:1,hash,expectedHash:hash,matchesCapturedState:true});
  assert.deepEqual(await executionSummary(archive(events),signal(),totals),result);
  assert.equal(inventory.pendingFields()[0].captureOrder,30);
});

test('partial recordings and missing trailing entries cannot report a verified whole execution',async()=>{
  const {events}=await recording();
  const result=await executionSummary(archive(events),signal(),{complete:false,dropped:1,events:events.length,frames:0});
  assert.equal(result.recordingComplete,false);assert.equal(result.inventory.matchesCapturedState,null);
  await assert.rejects(executionSummary(archive(events.slice(0,-1)),signal(),{
    complete:true,dropped:0,events:events.length,frames:0}),/총량/);
  const gap=events.filter((_,index)=>index!==2);
  await assert.rejects(executionSummary(archive(gap),signal(),{complete:true,dropped:0,events:gap.length,frames:0}),/순서/);
});

test('late inventory facts invalidate a stale checkpoint and legacy card summaries remain unsupported',async()=>{
  const {events,emit}=await recording();
  const late=source(40);emit('inventory-event',{version:1,kind:'identity-accepted',source:late,id:'a'});
  const result=await executionSummary(archive(events),signal());
  assert.equal(result.inventory.expectedHash,null);assert.equal(result.inventory.matchesCapturedState,null);
  const legacy=await executionSummary(archive([{kind:'event',seq:1,time:0,type:'card',value:card(source(1))}]),signal());
  assert.equal(legacy.inventory.supported,false);assert.equal(legacy.inventory.matchesCapturedState,null);
});

test('inventory events without an explicit starting state or with corrupted capture provenance are rejected',async()=>{
  const {events}=await recording();
  await assert.rejects(executionSummary(archive(events.slice(1)),signal()),/시작 상태/);
  const damaged=structuredClone(events),event=damaged.find(value=>value.type==='inventory-event'&&
    (value.value as {kind:string}).kind==='observation-recorded')!;
  (event.value as {source:InventorySource}).source={...source(99)};
  await assert.rejects(executionSummary(archive(damaged),signal()),/source\/card mismatch/);
});
