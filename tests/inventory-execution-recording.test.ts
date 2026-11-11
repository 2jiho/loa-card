import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {InventoryEvidence,hashInventoryEvidence,inventoryEventData,inventorySeedSnapshot} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';
import {entryParts,executionSummary,fastCompress,packPixels,pixelHash,type ExactEvent} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import {RunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';
import {beginReproduction,createReproductionBundle,openReproduction,createReproductionSessionAccess} from '../src/features/card-scanner/reproduction/scan-reproduction';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction/reproduction-session-store';

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

for(const [version,seedPolicy] of [[2,'prior-run'],[3,'prior-run-v2'],[4,'prior-run-v3'],[5,'prior-run-v3'],[6,'prior-run-v3']] as const) test(`version ${version} prior-run seed survives trace, exact archive and durable session export/import`,async()=>{
  const events:ExactEvent[]=[];
  const emit=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:events.length,type,value});
  const old={...card(source(1),2),awakening:1,manual:['awakening','extraCopies'] as ('awakening'|'extraCopies')[]};
  const countConflictPolicy={version:2 as const,sessionId:'session'};
  const seed={version,seedPolicy,...(version>=5?{consensusPolicy:'recorded-name-v1'}:{}),...(version===6?{countConflictPolicy}:{}),cards:inventorySeedSnapshot([old])};
  emit('inventory-seed',seed);
  const inventory=new InventoryEvidence([old],{seedPolicy,...(version===6?{consensusPolicy:'recorded-name-v1',countConflictPolicy}:{}),onEvent:event=>emit('inventory-event',inventoryEventData(event))});
  const manual=source(20);inventory.acceptIdentity(manual,'a');inventory.confirmName(manual,'a','수동 이름');
  inventory.recordObservation(manual,{...card(manual,3),awakening:2,name:'수동 이름',manual:['name']},1);
  const current=source(30);inventory.acceptIdentity(current,'a');inventory.confirmName(current,'a','카드');
  inventory.recordObservation(current,{...card(current,3),awakening:2},1);
  const hash=await hashInventoryEvidence(inventory.snapshot());emit('inventory-checkpoint',{complete:true,hash});
  assert.deepEqual([inventory.cards.get('a')!.awakening,inventory.cards.get('a')!.extraCopies],[2,3]);
  assert.deepEqual(inventory.evidence.get('a')![0].manual,['awakening','extraCopies']);
  assert.equal(inventory.cards.get('a')!.name,'수동 이름');
  assert.equal(inventory.confirmedNameOrder.get('a'),version===2?30:20);
  const trace=new RunStateTrace();for(const event of events)assert.equal(trace.record(event.type,event.value,event.time),true);
  assert.equal((await replayRunStateTrace(await trace.snapshotBlob(),signal())).inventory.matchesCapturedState,true);

  const pixels=new Uint8Array(16).fill(37),frame=new Blob(entryParts({kind:'frame',id:1,time:0,width:2,height:2,key:true,
    hash:await pixelHash(pixels),codec:'lz4',xor:true},fastCompress(packPixels(pixels,undefined,true))));
  const blob=new Blob([frame,archive(events)]),stats={frames:1,events:events.length,dropped:0,bytes:blob.size,
    peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:''};
  const store=createReproductionSessionStore({dbName:`prior-seed-roundtrip-${version}`});
  const exact={finish:async()=>({blob,stats}),dispose:async()=>{}};
  const run=beginReproduction([old],{browser:'test',catalog:'test',build:'test'},{record:true,store,exact:exact as never});
  const saved=await run.finish(undefined,true);assert.ok(saved?.exact);
  const restored=await createReproductionSessionAccess(store).load(run.id,signal());assert.ok(restored?.exact);
  const opened=await openReproduction(createReproductionBundle(restored),signal());assert.ok(opened.exact);
  assert.equal(opened.metadata.seed[0].manual?.join(','),'awakening,extraCopies');
  const result=await executionSummary(opened.exact,signal(),opened.metadata.exact);
  assert.equal(result.inventory.matchesCapturedState,true);
  assert.equal(result.inventory.hash,hash);
  assert.deepEqual(result.inventoryPolicy,{status:version>=5?'declared':'not-recorded',
    declared:version>=5?'recorded-name-v1':null,producerAuthenticated:false});
});

test('version 6 preserves an unresolved count conflict through trace and exact archive replay',async()=>{
  const events:ExactEvent[]=[];
  const emit=(type:string,value:unknown)=>events.push({kind:'event',seq:events.length+1,time:events.length,type,value});
  const countConflictPolicy={version:1 as const,sessionId:'session'};
  const seed={version:6,seedPolicy:'prior-run-v3',consensusPolicy:'recorded-name-v1',countConflictPolicy,cards:[]};
  emit('inventory-seed',seed);
  const inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v3',consensusPolicy:'recorded-name-v1',countConflictPolicy,
    onEvent:event=>emit('inventory-event',inventoryEventData(event))});
  const positive=source(10),empty=source(20);
  for(const [input,value] of [[positive,4],[empty,0]] as const){
    inventory.acceptIdentity(input,'a');inventory.confirmName(input,'a','카드');
    inventory.recordObservation(input,{...card(input,value),countDiagnostics:{maximum:15,reason:'test',readings:[],
      reliability:value?'clear-pattern':'empty-counter'}},1);
  }
  assert.equal(inventory.hasCountConflict('a'),true);
  assert.notEqual(inventory.confirmedFieldOrder.get('a'),20);
  assert.equal(inventory.pendingFields()[0]?.captureOrder,20);
  const hash=await hashInventoryEvidence(inventory.snapshot());emit('inventory-checkpoint',{complete:true,hash});
  const trace=new RunStateTrace();for(const event of events)assert.equal(trace.record(event.type,event.value,event.time),true);
  assert.equal((await replayRunStateTrace(await trace.snapshotBlob(),signal())).inventory.matchesCapturedState,true);
  const result=await executionSummary(archive(events),signal(),{complete:true,dropped:0,events:events.length,frames:0});
  assert.equal(result.inventory.matchesCapturedState,true);assert.equal(result.inventory.hash,hash);
});

test('exact archive replays actual inventory events including stale proof and explicit zero without pixels',async()=>{
  const {events,inventory,hash}=await recording();
  assert.ok(!JSON.stringify(events).includes('private-pixels'));
  const totals={complete:true,dropped:0,events:events.length,frames:0};
  const result=await executionSummary(archive(events),signal(),totals);
  assert.equal(result.recordingComplete,true);
  assert.deepEqual(result.inventory,{supported:true,events:6,cards:1,hash,expectedHash:hash,matchesCapturedState:true});
  assert.deepEqual(result.inventoryPolicy,{status:'not-recorded',declared:null,producerAuthenticated:false});
  assert.deepEqual(await executionSummary(archive(events),signal(),totals),result);
  assert.equal(inventory.pendingFields()[0].captureOrder,30);
});

test('partial recordings and missing trailing entries cannot report a verified whole execution',async()=>{
  const {events}=await recording();
  const result=await executionSummary(archive(events),signal(),{complete:false,dropped:1,events:events.length,frames:0});
  assert.equal(result.recordingComplete,false);assert.equal(result.inventory.matchesCapturedState,null);
  assert.equal(result.inventoryPolicy.status,'not-recorded');
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
  assert.deepEqual(legacy.inventoryPolicy,{status:'no-seed',declared:null,producerAuthenticated:false});
});

test('inventory events without an explicit starting state or with corrupted capture provenance are rejected',async()=>{
  const {events}=await recording();
  await assert.rejects(executionSummary(archive(events.slice(1)),signal()),/시작 상태/);
  const damaged=structuredClone(events),event=damaged.find(value=>value.type==='inventory-event'&&
    (value.value as {kind:string}).kind==='observation-recorded')!;
  (event.value as {source:InventorySource}).source={...source(99)};
  await assert.rejects(executionSummary(archive(damaged),signal()),/source\/card mismatch/);
});
