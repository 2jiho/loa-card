import test from 'node:test';
import assert from 'node:assert/strict';
import {RunStateTrace,replayRunStateTrace} from '../dev/run-state-trace';
import {entryParts,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import {FreshnessEvidence,hashFreshnessEvidence} from '../src/features/card-scanner/freshness-evidence';
import {FRESHNESS_EVIDENCE_LIMITS} from '../src/features/card-scanner/freshness-evidence-types';
import {InventoryEvidence,inventoryEventData} from '../src/features/card-scanner/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';

const signal=()=>AbortSignal.timeout(30_000);
const source:InventorySource={sessionId:'fresh-recording',frameId:1,observationId:'first',captureOrder:10,
  captureTime:1,phase:'input',slot:0,frame:'logical-source'};
const binding={key:'logical-observation',order:10,frame:source.frame,stable:true};
const useSource={sessionId:source.sessionId,frameId:source.frameId,observationId:source.observationId,
  captureOrder:source.captureOrder,captureTime:source.captureTime,phase:source.phase,slot:source.slot};
const seed={version:1 as const,sessionId:source.sessionId,limits:FRESHNESS_EVIDENCE_LIMITS};
const card:ScannedCard={id:'known',name:'검증 카드',awakening:0,extraCopies:0,countReliable:true,
  confidence:1,review:[],time:1,observations:1,image:'',captureOrder:10,
  capturePosition:{frame:source.frame,slot:0,stable:true,sort:null}};
interface Event {readonly kind:'event';readonly seq:number;readonly time:number;readonly type:string;readonly value:unknown}
const archive=(events:readonly Event[])=>new Blob(events.flatMap(event=>entryParts(event)));
const totals=(events:readonly Event[])=>({complete:true,dropped:0,events:events.length,frames:0});

async function recorded() {
  const events:Event[]=[],trace=new RunStateTrace();
  const record=(type:string,value:unknown)=>{
    const event={kind:'event' as const,seq:events.length+1,time:events.length/100,type,value};
    assert.equal(trace.record(type,value,event.time),true);events.push(event);
  };
  const inventory=new InventoryEvidence([],{onEvent:event=>record('inventory-event',inventoryEventData(event))});
  record('inventory-seed',{version:1,cards:[]});record('freshness-seed',seed);
  const freshness=new FreshnessEvidence(seed,{confirmedFields:()=>inventory.confirmedFieldOrder,
    onEvent:fact=>record('freshness-event',fact)});
  freshness.apply({version:1,kind:'accepted',group:1,time:1,source:useSource,binding,pixelKey:'original',fieldRevision:'revision',requiresProof:true});
  freshness.apply({version:1,kind:'identity-linked',binding,source:useSource,pixelKey:'original',id:card.id,review:[]});
  inventory.acceptIdentity(source,card.id);
  assert.deepEqual(freshness.guard('capture'),{unresolved:1,settled:false});
  inventory.recordObservation(source,card,1);
  assert.deepEqual(freshness.guard('final'),{unresolved:0,settled:true});
  const snapshot=freshness.snapshot(),hash=await hashFreshnessEvidence(snapshot);
  record('freshness-checkpoint',{version:1,complete:true,events:snapshot.facts,hash});
  return {events,trace,hash,record};
}

test('dev trace and exact recording replay the same source debt against ordered inventory proof',async()=>{
  const {events,trace,hash}=await recorded();
  const dev=await replayRunStateTrace(await trace.snapshotBlob(),signal());
  const exact=await executionSummary(archive(events),signal(),totals(events));
  for(const state of [dev.freshness,exact.freshness]) {
    assert.equal(state.supported,true);assert.equal(state.complete,true);
    assert.equal(state.unresolved,0);assert.equal(state.hash,hash);assert.equal(state.expectedHash,hash);
    assert.equal(state.matchesCapturedState,true);
  }
  assert.deepEqual(dev.freshness,exact.freshness);
});

test('later freshness or inventory events invalidate the captured freshness checkpoint in both readers',async()=>{
  for(const next of [
    {type:'freshness-event',value:{version:1,kind:'settle'}},
    {type:'inventory-event',value:{version:1,kind:'identity-accepted',source:{...source,observationId:'new',captureOrder:20},id:card.id}},
  ]) {
    const {events,trace,record}=await recorded();record(next.type,next.value);
    const dev=await replayRunStateTrace(await trace.snapshotBlob(),signal());
    const exact=await executionSummary(archive(events),signal(),totals(events));
    for(const result of [dev.freshness,exact.freshness]) {
      assert.equal(result.complete,false);assert.equal(result.expectedHash,null);assert.equal(result.matchesCapturedState,null);
    }
  }
});

test('old archives with only final counts do not gain a fictional freshness channel',async()=>{
  const trace=new RunStateTrace();assert.equal(trace.record('inventory-seed',{version:1,cards:[]},0),true);
  const dev=await replayRunStateTrace(await trace.snapshotBlob(),signal());
  const events:Event[]=[{kind:'event',seq:1,time:0,type:'card',value:{...card,unresolvedFieldChanges:0}}];
  const exact=await executionSummary(archive(events),signal(),totals(events));
  for(const result of [dev.freshness,exact.freshness]) {
    assert.equal(result.supported,false);assert.equal(result.hash,null);assert.equal(result.matchesCapturedState,null);
  }
});

test('a forged settled guard cannot replace the actual identity and field-proof sequence',async()=>{
  const {events}=await recorded(),index=events.findIndex(event=>event.type==='freshness-event'&&
    (event.value as {kind?:string}).kind==='guard-check');
  const forged=events.map((event,i)=>i===index?{...event,value:{...(event.value as object),unresolved:0,settled:true}}:event);
  await assert.rejects(executionSummary(archive(forged),signal(),totals(forged)));
  const trace={version:1,complete:true,dropped:0,events:forged.map(({kind:_kind,...event})=>event)};
  await assert.rejects(replayRunStateTrace(new Blob([JSON.stringify(trace)]),signal()));
});

test('freshness sink loss makes recording partial and never certifies the retained prefix',async()=>{
  const {events,trace}=await recorded();
  assert.equal(trace.record('freshness-recording-error',{loss:'event-sink-failed'},1),false);
  await assert.rejects(replayRunStateTrace(await trace.snapshotBlob(),signal()),/불완전/);
  const all=[...events,{kind:'event' as const,seq:events.length+1,time:1,type:'freshness-recording-error',value:{loss:'event-sink-failed'}}];
  const result=await executionSummary(archive(all),signal(),totals(all));
  assert.equal(result.recordingComplete,false);assert.equal(result.freshness.complete,false);
  assert.equal(result.freshness.matchesCapturedState,null);
});
