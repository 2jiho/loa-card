import test from 'node:test';
import assert from 'node:assert/strict';
import { unownedInventory } from '../src/inventory-unowned';

const catalog = [
  { id:'b',name:'바루투',rarity:1 }, { id:'a',name:'가디언',rarity:2 }, { id:'c',name:'아만',rarity:4 },
];
const completed = { status:'스캔 완료',expected:1,cards:[{id:'b',review:[],awakening:5,extraCopies:0}],unidentified:[] };

test('completed inventory uses row presence, including zero extra copies, and sorts missing names',()=>{
  const before=structuredClone(catalog);
  assert.deepEqual(unownedInventory(catalog,completed,false)?.map(c=>c.name),['가디언','아만']);
  assert.deepEqual(catalog,before);
});

test('unstarted, incomplete, active, interrupted and unidentified scans cannot assert unowned cards',()=>{
  for(const state of [null,{...completed,expected:null},{...completed,expected:2},
    {...completed,status:'스캔 중지'}, {...completed,unidentified:[{}]},
    {...completed,cards:[{id:'b',review:['이름 확인']}]},
    {...completed,expected:2,cards:[{id:'b',review:[]},{id:'b',review:[]}]}]) {
    assert.equal(unownedInventory(catalog,state,false),null);
  }
  assert.equal(unownedInventory(catalog,completed,true),null);
  assert.equal(unownedInventory([],completed,false),null);
});

test('CSV row absence is explicit unowned evidence without an in-game inventory total',()=>{
  assert.deepEqual(unownedInventory(catalog,{...completed,status:'CSV 불러오기 완료',expected:null},false)?.map(c=>c.id),['a','c']);
});

test('awakening or count review does not turn an identified card into an unowned one',()=>{
  assert.deepEqual(unownedInventory(catalog,{...completed,cards:[{id:'b',review:['장수 확인']}]},false)?.map(c=>c.id),['a','c']);
});

test('complete catalog ownership returns an empty list',()=>{
  assert.deepEqual(unownedInventory(catalog,{...completed,expected:3,cards:catalog.map(c=>({id:c.id,review:[]}))},false),[]);
});

test('identity reviews cannot certify missing catalog entries even when the count matches', () => {
  for (const reason of ['이름 확인', '카드 식별 확인', '그림 보조 식별', '사전 확인']) {
    assert.equal(unownedInventory(catalog, { ...completed, cards: [{ id: 'b', review: [reason] }] }, false), null);
  }
});

test('verified auto-completion tolerates leftover duplicate crops but not partial or ambiguous coverage', () => {
  const state = { ...completed, autoStopped: true, currentRunNames: 1, unidentified: [{}] };
  assert.deepEqual(unownedInventory(catalog, state, false)?.map(c => c.id), ['a', 'c']);
  for (const patch of [{ autoStopped: false }, { currentRunNames: 0 }, { currentRunNames: undefined },
    { expected: 2 }, { cards: [{ id: 'b', review: ['카드 식별 확인'] }] },
    { cards: [{ id: 'outside-catalog', review: [] }] }]) {
    assert.equal(unownedInventory(catalog, { ...state, ...patch }, false), null);
  }
  assert.equal(unownedInventory(catalog, state, true), null);
});
