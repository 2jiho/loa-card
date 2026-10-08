import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {matchCardName} from '../src/features/card-scanner/card-dictionary';
import {confirmCatalogName} from '../src/features/card-scanner/name-confidence';
import type {CatalogName} from '../src/features/card-scanner/card-dictionary';
const {cards}:{cards:CatalogName[]}=JSON.parse(readFileSync(new URL('../public/scanner/cards.json',import.meta.url),'utf8'));

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

test('registered exact names and aliases remain supported; corrections need independent artwork',()=>{
 for(const card of cards)for(const name of [card.name,...(card.aliases??[])]){
  const match=matchCardName(name,cards);
  assert.equal(match?.card.id,card.id);
  assert.ok(match&&confirmCatalogName({...match,rawText:name,ocrConfidence:95},false));
 }
 const correction={exact:false,score:.89,gap:.3,ocrConfidence:95,rawText:'모리나'};
 assert.equal(confirmCatalogName(correction,true),false);
 assert.equal(confirmCatalogName({...correction,portrait:{upper:.97,lower:.96,correlation:.965,margin:.4}},true),true);
 assert.equal(confirmCatalogName({...correction,portrait:{upper:.97,lower:.7,correlation:.835,margin:.4}},true),false);
});
