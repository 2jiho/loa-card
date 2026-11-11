import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createPortraitMatcher} from '../src/features/card-scanner/recognition/portrait-matcher';
import {parsePortraitDiagnostics} from '../src/features/card-scanner/recognition/portrait-diagnostics';
const json=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const {cards}=json('../public/scanner/cards.json'),original=json('../public/scanner/artwork-details.json'),screen=json('../public/scanner/screen-artwork-details.json');
const provenance=json('../public/scanner/artwork-provenance.json');
test('screen references contain only known identities and fixed portrait pixels',()=>{
 assert.equal(screen.version,1);assert.equal(screen.source.set,'screenshots-1');assert.match(screen.source.sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(screen.region,{normalizedWidth:24,normalizedHeight:32,x:2,y:9,width:20,height:10});
 assert.equal(Object.keys(screen.cards).length,screen.source.cards);
 const ids=new Set(cards.map((c:{id:string})=>c.id));for(const [id,data] of Object.entries(screen.cards)){assert.ok(ids.has(id));assert.equal(Buffer.from(data as string,'base64').length,200);}
 for(const [id,data] of Object.entries(original)){assert.ok(ids.has(id));assert.equal(Buffer.from(data as string,'base64').length,200);}
 // Display-only mappings are not recognition references. Verified mappings may
 // later be promoted, so do not require any particular card to remain missing.
 for(const entry of provenance.cards.filter((card:{usage?:string})=>card.usage==='display-only'))
  assert.equal(Object.hasOwn(original,entry.id),false,`${entry.id} is display-only`);
});

test('screenshot regression portraits retain known cards without false identities',()=>{
 // This set was used in earlier tuning; it is a regression set, not independent accuracy evidence.
 const fixture=json('./fixtures/screen-portrait-regression.json'),match=createPortraitMatcher(cards,original,screen.cards);
 assert.equal(fixture.rows.length,400);let accepted=0,empty=0;
 for(const row of fixture.rows){
  const gray=Uint8Array.from(Buffer.from(row.gray,'base64'));assert.equal(gray.length,768);
  const result=match(gray);
  if(row.expected===null){empty++;assert.equal(result,null,`empty ${row.page}/${row.slot}`);}
  else if(result){accepted++;assert.equal(result.card.id,row.expected,`wrong identity ${row.page}/${row.slot}`);}
 }
 assert.equal(empty,16);assert.ok(accepted>=375,`accepted only ${accepted} of 384 owned cards`);
});
test('multiple views of one card do not compete as different identities',()=>{
 const card=cards.find((c:{name:string})=>c.name==='가디언 루'),sample=json('./fixtures/artwork-detail-samples.json').find((s:{expected:string})=>s.expected==='가디언 루');
 const gray=Uint8Array.from(Buffer.from(sample.gray,'base64'));
 assert.equal(createPortraitMatcher(cards,original,{[card.id]:original[card.id]})(gray)?.card.id,card.id);
 assert.equal(createPortraitMatcher([card],original,screen.cards)(gray),null,'two views are not two competing identities');
 const tied={...card,id:'tied'};
 assert.equal(createPortraitMatcher([card,tied],{[card.id]:original[card.id],tied:original[card.id]},
  {[card.id]:screen.cards[card.id],tied:screen.cards[card.id]})(gray),null,'different identities with tied pictures remain ambiguous');
});
test('overlapping-name competitors must have independent usable references',()=>{
 const short=cards.find((c:{name:string})=>c.name==='발탄'),long=cards.find((c:{name:string})=>c.name==='찢겨진 발탄');
 const other=cards.find((c:{name:string})=>c.name==='가디언 루'),regression=json('./fixtures/screen-portrait-regression.json');
 const sample=regression.rows.find((row:{expected:string|null})=>row.expected===short.id);
 const gray=Uint8Array.from(Buffer.from(sample.gray,'base64'));
 const noLongOriginal={...original},noLongScreen={...screen.cards};
 delete noLongOriginal[long.id];delete noLongScreen[long.id];
 let diagnostic:unknown;
 assert.equal(createPortraitMatcher(cards,noLongOriginal,noLongScreen)(gray,undefined,value=>{diagnostic=value;}),null,'missing competitor reference');
 assert.equal((diagnostic as {reason:string}).reason,'missing-competitor-reference');
 assert.ok(parsePortraitDiagnostics([{source:'computed',mode:'visual',diagnostic}]));
 // Synthetic feature replacement tests the acceptance contract; it does not
 // claim the unrelated card artwork is the real missing competitor artwork.
 const distinct={...noLongOriginal,[long.id]:original[other.id]};
 assert.equal(createPortraitMatcher(cards,distinct,noLongScreen)(gray)?.card.id,short.id,'an independently different competing reference can allow the short card');
 const tied={...noLongOriginal,[long.id]:screen.cards[short.id]};
 assert.equal(createPortraitMatcher(cards,tied,noLongScreen)(gray),null,'the same artwork cannot decide two IDs');
});
test('supplemental portraits do not invent an identity for empty backs or flat rasters',()=>{
 const match=createPortraitMatcher(cards,original,screen.cards),samples=json('./fixtures/artwork-detail-samples.json');
 for(const sample of samples.filter((s:{expected:string|null})=>!s.expected))assert.equal(match(Uint8Array.from(Buffer.from(sample.gray,'base64'))),null);
 assert.equal(match(new Uint8Array(768).fill(40)),null);
});
