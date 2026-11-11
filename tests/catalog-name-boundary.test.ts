import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildNameAmbiguityIndex,matchCardName} from '../src/features/card-scanner/recognition/card-dictionary';
import {confirmCatalogName} from '../src/features/card-scanner/recognition/name-confidence';
import {unconfirmedCatalogNameReason} from '../src/features/card-scanner/recognition/name-diagnostics';
import type {CatalogName} from '../src/features/card-scanner/recognition/card-dictionary';
const {cards}:{cards:CatalogName[]}=JSON.parse(readFileSync(new URL('../public/scanner/cards.json',import.meta.url),'utf8'));

test('an exact Valtan name reports its catalog overlap without accepting the crop',()=>{
 const result=matchCardName('발탄',cards);
 assert.ok(result);assert.equal(result.card.name,'발탄');assert.equal(result.exact,true);
 assert.equal(result.nameAmbiguous,true,'the longer catalog name must remain a rival');
 assert.equal(confirmCatalogName({...result,rawText:'발탄',complete:true,ocrConfidence:99},true),false);
 assert.match(unconfirmedCatalogNameReason(result),/다른 카드 이름에도 포함/);
 assert.match(unconfirmedCatalogNameReason({exact:false}),/DB 유사 이름만 일치/);
});

test('withheld real catalog names cannot be auto-corrected into another card by text alone',()=>{
 let candidates=0;
 for(const removed of cards){
  const match=matchCardName(removed.name,cards.filter(card=>card.id!==removed.id));
  if(!match)continue;
  candidates++;
  const reading={...match,rawText:removed.name,complete:true,ocrConfidence:100};
  assert.equal(confirmCatalogName(reading,true),false,`${removed.name} -> ${match.card.name}`);
  assert.equal(confirmCatalogName({...reading,ctc:{relativeLikelihood:1,margin:1}},true),false);
 }
 assert.ok(candidates>0,'exercise actual neighboring names');
});

test('exact text inside another card name remains ambiguous even after grade filtering',()=>{
 const full=[{id:'short',name:'하리',rarity:1},{id:'long',name:'하리야',rarity:3},
  {id:'prefix',name:'라제니스를 이끄는 니나브',rarity:4},{id:'ninav',name:'니나브',rarity:4}];
 const index=buildNameAmbiguityIndex(full);
 for(const [text,subset] of [['하리',full.filter(card=>card.rarity===1)],['니나브',full]] as const){
  const match=matchCardName(text,subset,index);assert.ok(match);assert.equal(match.nameAmbiguous,true);
  for(const complete of [true,false])assert.equal(confirmCatalogName({...match,rawText:text,complete,ocrConfidence:100},true),false);
 }
 const long=matchCardName('하리야',full,index);assert.ok(long);assert.equal(long.nameAmbiguous,false);
 assert.equal(confirmCatalogName({...long,ocrConfidence:99},false),true);
});

test('alias overlaps and equal names across grades are checked against the full catalog',()=>{
 const full=[{id:'a',name:'하나',aliases:['가을'],rarity:1},{id:'b',name:'가을밤',rarity:2},
  {id:'c',name:'다른 카드',aliases:['하나'],rarity:3}];
 const index=buildNameAmbiguityIndex(full);
 for(const name of ['하나','가을']){
  const match=matchCardName(name,[full[0]],index);assert.ok(match);assert.equal(match.nameAmbiguous,true);
  assert.equal(confirmCatalogName({...match,ocrConfidence:100},false),false);
 }
 assert.equal(matchCardName('하나',full,index),null,'equal exact names must not choose an arbitrary ID');
 const longer=matchCardName('가을밤',full,index);assert.ok(longer);assert.equal(longer.nameAmbiguous,false);
});

test('the default catalog index is rebuilt if an existing catalog is modified',()=>{
 const mutable=[{id:'a',name:'하리',rarity:1}];
 assert.equal(matchCardName('하리',mutable)?.nameAmbiguous,false);
 mutable.push({id:'b',name:'하리야',rarity:2});
 assert.equal(matchCardName('하리',mutable)?.nameAmbiguous,true);
});

test('an ambiguous exact needs independently strong portrait, not text-assisted relaxed gates',()=>{
 const cards=[{id:'short',name:'도철',rarity:1},{id:'long',name:'혼돈의 도철',rarity:2}];
 const match=matchCardName('도철',cards)!;
 const reading={...match,rawText:'도철',complete:true,ocrConfidence:100};
 assert.equal(confirmCatalogName(reading,true),false);
 const weak={region:'above-badge' as const,upper:.87,lower:.87,correlation:.87,margin:.5,left:.87,right:.87};
 assert.equal(confirmCatalogName({...reading,portrait:weak},true),false);
 const strong={upper:.97,lower:.96,correlation:.965,margin:.4};
 assert.equal(confirmCatalogName({...reading,portrait:strong},false),true);
});

test('exact names and aliases remain candidates; overlapping text needs independent artwork',()=>{
 for(const card of cards)for(const name of [card.name,...(card.aliases??[])]){
  const match=matchCardName(name,cards);
  assert.equal(match?.card.id,card.id);
  assert.ok(match);
  assert.equal(confirmCatalogName({...match,rawText:name,ocrConfidence:95,complete:true},false),!match.nameAmbiguous,name);
  if(match.nameAmbiguous)assert.equal(confirmCatalogName({...match,rawText:name,ocrConfidence:95,
   portrait:{upper:.97,lower:.96,correlation:.965,margin:.4}},false),true,name);
 }
 const correction={exact:false,score:.89,gap:.3,ocrConfidence:95,rawText:'모리나'};
 assert.equal(confirmCatalogName(correction,true),false);
 assert.equal(confirmCatalogName({...correction,portrait:{upper:.97,lower:.96,correlation:.965,margin:.4}},true),true);
 assert.equal(confirmCatalogName({...correction,portrait:{upper:.97,lower:.7,correlation:.835,margin:.4}},true),false);
});
