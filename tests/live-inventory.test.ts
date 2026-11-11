import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LiveInventory,type LiveInventoryProof} from '../src/features/card-scanner/session/live-inventory';
import {InventoryEvidence,type InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {ScannedCard} from '../src/features/card-scanner/recognition/recognizer';
const card:ScannedCard={id:'one',name:'카드',awakening:0,extraCopies:2,countReliable:true,
  confidence:1,review:[],image:'',time:1,observations:1,captureOrder:1};
const proof=(...cards:ScannedCard[]):LiveInventoryProof=>({cards:new Map(cards.map(c=>[c.id,c])),
  latest:new Map(cards.map(c=>[c.id,c.captureOrder??0])),confirmedNames:new Map(cards.map(c=>[c.id,c.captureOrder??0])),
  confirmedFields:new Map(cards.filter(c=>c.countReliable===true).map(c=>[c.id,c.captureOrder??0]))});

test('live inventory distinguishes identification from full field confirmation',()=>{
  const live=new LiveInventory();
  live.record(card);
  live.record({...card,id:'two',extraCopies:null,review:['추가 장수 확인']});
  live.record({...card,id:'three',countReliable:false,review:['추가 장수 안정 관측 필요']});
  const result=live.finish([],proof(card,{...card,id:'two',extraCopies:null,review:['추가 장수 확인']},
    {...card,id:'three',countReliable:false,review:['추가 장수 안정 관측 필요']}));
  assert.equal(result.identified,3);assert.equal(result.confirmed,1);
  assert.equal(result.cards.find(c=>c.id==='two')?.extraCopies,null);
  assert.ok(result.cards.find(c=>c.id==='three')?.review.some(r=>r.includes('장수')));
});
test('tail work after sharing cannot improve or add to a sealed live snapshot',()=>{
  const live=new LiveInventory();live.record({...card,extraCopies:null,review:['추가 장수 확인']});
  const result=live.finish([]),before=JSON.stringify(result);
  live.record({...card,extraCopies:15,captureOrder:99});live.record({...card,id:'late'});
  assert.equal(live.finish([]),result);assert.equal(JSON.stringify(result),before);
  assert.equal(result.identified,1);assert.equal(result.confirmed,0);
});
test('live field values use capture chronology and snapshots contain no images or inherited inventory',()=>{
  const live=new LiveInventory();
  assert.deepEqual(new LiveInventory().finish([]),{identified:0,confirmed:0,cards:[]});
  live.record({...card,extraCopies:9,captureOrder:20});live.record({...card,extraCopies:3,captureOrder:10});
  const result=live.finish([],proof({...card,extraCopies:9,captureOrder:20}));assert.equal(result.cards[0].extraCopies,9);
  assert.equal('image' in result.cards[0],false);
  assert.notEqual(result.cards[0].review,card.review);
});
test('without source-bound proof a legacy caller cannot claim a confirmed live result',()=>{
  const live=new LiveInventory();live.record(card);
  const result=live.finish([]);
  assert.equal(result.identified,1);assert.equal(result.confirmed,0);assert.equal(result.cards[0].countReliable,false);
  assert.ok(result.cards[0].review.includes('최신 각성·장수 확인'));
});
test('a later unconfirmed field cannot inherit an older reliable live reading',()=>{
  const live=new LiveInventory(),inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v2'});
  const source=(n:number):InventorySource=>({sessionId:'s',frameId:n,observationId:String(n),captureOrder:n,
    captureTime:n,slot:0,frame:`f${n}`,phase:'input'});
  for(const n of [1,2]){
    const src=source(n),observation:ScannedCard={...card,extraCopies:n===1?2:null,countReliable:n===1,
      review:n===1?[]:['추가 장수 확인'],time:n,captureOrder:n,
      capturePosition:{frame:src.frame,slot:src.slot,stable:true,sort:null}};
    live.record(observation);inventory.acceptIdentity(src,card.id);inventory.confirmName(src,card.id,observation.name);
    inventory.recordObservation(src,observation,1);
  }
  const result=live.finish([],{cards:inventory.cards,latest:inventory.latestIdentityOrder,
    confirmedNames:inventory.confirmedNameOrder,confirmedFields:inventory.confirmedFieldOrder});
  assert.equal(result.identified,1);assert.equal(result.confirmed,0);
  assert.ok(result.cards[0].review.includes('최신 각성·장수 확인'));assert.equal(result.cards[0].countReliable,false);
});
test('proof for a different displayed value or name cannot certify the live card',()=>{
  for(const change of [{extraCopies:3},{name:'다른 카드'}]){
    const live=new LiveInventory();live.record(card);
    const result=live.finish([],proof({...card,...change}));
    assert.equal(result.confirmed,0);assert.ok(result.cards[0].review.length>0);
  }
});
test('an accepted newer identity awaiting a reader makes the older live card unconfirmed',()=>{
  const live=new LiveInventory(),inventory=new InventoryEvidence([],{seedPolicy:'prior-run-v2'});
  const source=(n:number):InventorySource=>({sessionId:'s',frameId:n,observationId:String(n),captureOrder:n,
    captureTime:n,slot:0,frame:`f${n}`,phase:'input'});
  const first=source(1),observation:ScannedCard={...card,capturePosition:{frame:first.frame,slot:0,stable:true,sort:null}};
  live.record(observation);inventory.acceptIdentity(first,card.id);inventory.confirmName(first,card.id,observation.name);
  inventory.recordObservation(first,observation,1);
  inventory.acceptIdentity(source(2),card.id); // Reader has not published fields yet.
  const result=live.finish([],{cards:inventory.cards,latest:inventory.latestIdentityOrder,
    confirmedNames:inventory.confirmedNameOrder,confirmedFields:inventory.confirmedFieldOrder});
  assert.equal(result.confirmed,0);assert.ok(result.cards[0].review.includes('최신 이름 확인'));
  assert.ok(result.cards[0].review.includes('최신 각성·장수 확인'));
});
