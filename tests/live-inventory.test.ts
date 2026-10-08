import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LiveInventory} from '../src/features/card-scanner/live-inventory';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';
const card:ScannedCard={id:'one',name:'카드',awakening:0,extraCopies:2,countReliable:true,
  confidence:1,review:[],image:'',time:1,observations:1,captureOrder:1};

test('live inventory distinguishes identification from full field confirmation',()=>{
  const live=new LiveInventory();
  live.record(card);
  live.record({...card,id:'two',extraCopies:null,review:['추가 장수 확인']});
  live.record({...card,id:'three',countReliable:false,review:['추가 장수 안정 관측 필요']});
  const result=live.finish([]);
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
  const result=live.finish([]);assert.equal(result.cards[0].extraCopies,9);
  assert.equal('image' in result.cards[0],false);
  assert.notEqual(result.cards[0].review,card.review);
});
