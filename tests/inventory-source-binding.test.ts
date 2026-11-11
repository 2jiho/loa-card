import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InventoryEvidence, MAX_PENDING_IDENTITY_SOURCES, hashInventoryEvidence, parseInventorySeed,
  replayInventoryEvidence, serializeInventoryEvent, serializeInventorySeed} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventoryEvent,InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';
import {canStopSharing} from '../src/features/card-scanner/session/auto-completion';

const source=(order:number,id=`obs-${order}`):InventorySource=>({sessionId:'session',frameId:order,
  observationId:id,captureOrder:order,captureTime:order/10,phase:'input',slot:0,frame:`frame-${order}`});
const card=(s:InventorySource):ScannedCard=>({id:'card',name:'카드',awakening:0,extraCopies:2,
  confidence:1,review:[],image:'',time:s.captureTime,observations:1,countReliable:true,captureOrder:s.captureOrder,
  capturePosition:{frame:s.frame,slot:s.slot,stable:true,sort:null}});
function record(inv:InventoryEvidence,s:InventorySource) {
  inv.acceptIdentity(s,'card');inv.confirmName(s,'card','카드');return inv.recordObservation(s,card(s),.9);
}
function canStop(inv:InventoryEvidence) {
  return canStopSharing({expected:1,finalExpected:1,cards:inv.project([]),latest:inv.latestIdentityOrder,
    confirmed:inv.confirmedFieldOrder,confirmedNames:inv.confirmedNameOrder,unresolved:0,dropped:0,inputSettled:true,
    fieldChangesSettled:true,headerAvailable:true});
}

test('v4 refuses another source with the same order and requires a newer view',async()=>{
  const events:InventoryEvent[]=[],inv=new InventoryEvidence([],{seedPolicy:'prior-run-v3',onEvent:event=>events.push(event)});
  const a=source(10),b={...a,frameId:11,observationId:'other',frame:'other-frame'};
  inv.acceptIdentity(a,'card');
  assert.equal(inv.confirmName(b,'card','카드').sourceRejected,true);
  assert.equal(inv.recordObservation(b,card(b),.9).sourceRejected,true);
  assert.equal(inv.pendingFields().length,1,'rejected source leaves a visible field to revisit');
  assert.match(inv.pendingFields()[0].reason,/다시 확인/);
  inv.confirmName(a,'card','카드');inv.recordObservation(a,card(a),.9);
  assert.equal(canStop(inv),false,'same-order evidence cannot erase the missing source');
  const replay=replayInventoryEvidence([],events.map(serializeInventoryEvent),{seedPolicy:'prior-run-v3'});
  assert.equal(await hashInventoryEvidence(inv.snapshot()),await hashInventoryEvidence(replay.snapshot()));
  record(inv,source(20));assert.equal(canStop(inv),true,'a separately accepted newer input resolves the debt');
  const parsed=parseInventorySeed(serializeInventorySeed([],'prior-run-v3'));assert.equal(parsed.version,4);
});

test('two distinct inputs with the same capture order remain ambiguous until a newer capture',()=>{
  const inv=new InventoryEvidence([],{seedPolicy:'prior-run-v3'}),a=source(10);
  const b={...a,frameId:11,observationId:'other',frame:'other-frame'};
  record(inv,a);assert.equal(canStop(inv),true);
  const collision=record(inv,b);assert.equal(canStop(inv),false);
  assert.equal(collision.diagnosticResolved,false);assert.equal(inv.pendingFields().length,1);
  assert.deepEqual(inv.snapshot().ambiguousIdentityOrders,[['card',10]]);
  record(inv,source(20));assert.equal(canStop(inv),true);
});

test('independent attempts of the same acquired slot can reuse it without an artificial tie',()=>{
  const inv=new InventoryEvidence([],{seedPolicy:'prior-run-v3'}),a=source(10),retry={...a,observationId:'retry'};
  record(inv,a);record(inv,retry);assert.equal(inv.snapshot().ambiguousIdentityOrders,undefined);
  assert.equal(canStop(inv),true);
});

test('exact duplicate completed events are idempotent but changed data without acceptance is rejected',()=>{
  const inv=new InventoryEvidence([],{seedPolicy:'prior-run-v3'}),s=source(10);
  record(inv,s);assert.equal(canStop(inv),true);
  inv.confirmName(s,'card','카드');inv.recordObservation(s,card(s),.9);
  assert.equal(canStop(inv),true);
  const changed={...card(s),extraCopies:3};
  assert.equal(inv.recordObservation(s,changed,.9).sourceRejected,true);
  assert.equal(canStop(inv),false);
  record(inv,source(20));assert.equal(canStop(inv),true);
});

test('unfinished source identities have a bounded buffer; eviction fails closed',()=>{
  const inv=new InventoryEvidence([],{seedPolicy:'prior-run-v3'});
  for(let i=1;i<=MAX_PENDING_IDENTITY_SOURCES+1;i++)inv.acceptIdentity(source(i),'card');
  assert.equal(inv.snapshot().acceptedIdentitySources?.[0][1].length,MAX_PENDING_IDENTITY_SOURCES);
  const evicted=source(1);assert.equal(inv.confirmName(evicted,'card','카드').sourceRejected,true);
  assert.equal(inv.recordObservation(evicted,card(evicted),.9).sourceRejected,true);
  assert.equal(inv.confirmedNameOrder.size,0);assert.equal(inv.confirmedFieldOrder.size,0);
  record(inv,source(MAX_PENDING_IDENTITY_SOURCES+2));assert.equal(canStop(inv),true);
});

test('out-of-order older accepted work does not certify or displace newer proof',()=>{
  const inv=new InventoryEvidence([],{seedPolicy:'prior-run-v3'}),old=source(10),latest=source(20);
  inv.acceptIdentity(old,'card');record(inv,latest);assert.equal(canStop(inv),true);
  inv.confirmName(old,'card','카드');inv.recordObservation(old,card(old),.9);
  assert.equal(canStop(inv),true);
});
