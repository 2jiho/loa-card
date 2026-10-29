import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {merchants,merchantProgress,remainingMerchantCopies,merchantListText,merchantCardIssues} from '../src/features/merchants/merchant-progress';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';
const make=(id:string,awakening=5,extraCopies=0):ScannedCard=>({id,name:id,awakening,extraCopies,countReliable:true,review:[],confidence:1,image:'',time:0,observations:1});

test('card-list references distinguish missing cards from uncertain owned observations without inventing counts',()=>{
 const cards=merchants.flatMap(m=>m.cards).map(c=>make(c.id));
 const absent=cards.pop()!;cards[0].countReliable=false;
 const before=structuredClone(cards),issues=merchantCardIssues(cards);
 assert.deepEqual(issues.map(c=>[c.id,c.missing]),[[cards[0].id,false],[absent.id,true]]);
 assert.deepEqual(cards,before);
 assert.equal(new Set(issues.map(c=>c.id)).size,issues.length);
 assert.equal('extraCopies' in issues[1],false);
 cards.push(absent);cards[0].countReliable=true;
 assert.deepEqual(merchantCardIssues(cards),[]);
});
test('empty inventories do not create a list of presumed missing owned cards',()=>{
 assert.deepEqual(merchantCardIssues([]),[]);
});
test('merchant master contains the 22 documented groups and 133 exact catalog IDs',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../public/scanner/cards.json',import.meta.url),'utf8')).cards as {id:string;name:string}[];
 assert.equal(merchants.length,22);
 const cards=merchants.flatMap(m=>m.cards);assert.equal(cards.length,133);assert.equal(new Set(cards.map(c=>c.id)).size,133);
 for(const card of cards)assert.equal(catalog.find(c=>c.id===card.id)?.name,card.name);
 assert.equal(merchants.find(m=>m.region==='루테란 동부1')?.merchant,'모리스');
 assert.equal(merchants.find(m=>m.region==='루테란 동부2')?.merchant,'버트');
});
test('registered card includes its first copy and awakening consumption',()=>{
 assert.equal(remainingMerchantCopies(make('a',0,0)),15);
 assert.equal(remainingMerchantCopies(make('a',4,2)),3);
 assert.equal(remainingMerchantCopies(make('a',4,5)),0);
 assert.equal(remainingMerchantCopies(make('a',5,0)),0);
});
test('missing, uncertain and impossible observations never allow disabling alerts',()=>{
 assert.equal(remainingMerchantCopies(undefined),null);
 for(const changes of [{awakening:null},{extraCopies:null},{awakening:NaN},{awakening:6},{extraCopies:-1},
  {extraCopies:1},{review:['이름 확인']},{countReliable:false},{countReliable:undefined}])
  assert.equal(remainingMerchantCopies({...make('a'),...changes}),null);
 assert.ok(merchantProgress([]).every(m=>m.status==='unknown'));
});
test('all material secured releases a merchant, one short card keeps it enabled',()=>{
 const cards=merchants[0].cards.map(c=>make(c.id,4,5));
 let group=merchantProgress(cards)[0];assert.equal(group.status,'complete');assert.equal(group.complete,4);
 cards[0].extraCopies=4;group=merchantProgress(cards)[0];assert.equal(group.status,'needed');assert.equal(group.remaining,1);
 cards.pop();group=merchantProgress(cards)[0];assert.equal(group.status,'needed');assert.equal(group.unknown.length,1);
 cards[0].extraCopies=5;assert.equal(merchantProgress(cards)[0].status,'unknown');
});
test('a fully read region is available before other regions, but missing or uncertain cards stay unknown',()=>{
 const cards=merchants[0].cards.map(c=>make(c.id));
 assert.equal(merchantProgress(cards)[0].status,'complete');
 assert.equal(merchantProgress(cards)[1].status,'unknown');
 cards[0].countReliable=false;
 assert.equal(merchantProgress(cards)[0].status,'unknown');
});
test('similar card names and edited display names cannot cross-match IDs',()=>{
 const merchant=merchants.find(m=>m.region==='파푸니카')!;
 const normal=merchant.cards.find(c=>c.name==='쿠크세이튼')!;
 const lost=merchant.cards.find(c=>c.name==='광기를 잃은 쿠크세이튼')!;
 const result=merchantProgress([{...make(normal.id),name:lost.name}]).find(m=>m.id===merchant.id)!;
 assert.equal(result.items.find(c=>c.id===normal.id)?.remaining,0);
 assert.equal(result.items.find(c=>c.id===lost.id)?.remaining,null);
});
test('copy list contains only the selected regional recommendation and exact shortage',()=>{
 const group=merchants[0],cards=group.cards.map(c=>make(c.id));cards[0].awakening=4;cards[0].extraCopies=2;
 const text=merchantListText(merchantProgress(cards),'needed');
 assert.match(text,/아르테미스 \(벤\)/);assert.match(text,/시이라 3장 부족/);assert.match(text,/유디아.*확인 필요/);
});

test('a missing merchant card becomes a registration plus fifteen copies only after inventory completeness',()=>{
 const group=merchants[0],cards=group.cards.slice(1).map(c=>make(c.id));
 assert.equal(merchantProgress(cards)[0].status,'unknown');
 const complete=merchantProgress(cards,true)[0];
 assert.equal(complete.status,'needed');assert.equal(complete.remaining,16);
 assert.equal(complete.items[0].remaining,16);assert.equal(complete.unknown.length,0);
 assert.equal(merchantCardIssues(cards,true).some(c=>c.id===group.cards[0].id),false);
});

test('duplicate rows cannot certify a completed merchant region',()=>{
 const cards=merchants[0].cards.map(c=>make(c.id));cards.push({...cards[0]});
 assert.equal(merchantProgress(cards,true)[0].status,'unknown');
});
