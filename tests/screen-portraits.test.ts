import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createPortraitMatcher} from '../src/features/card-scanner/portrait-matcher';
const json=(p:string)=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const {cards}=json('../public/scanner/cards.json'),original=json('../public/scanner/artwork-details.json'),screen=json('../public/scanner/screen-artwork-details.json');
test('screen references contain only known identities and fixed portrait pixels',()=>{
 assert.equal(screen.version,1);assert.equal(screen.source.set,'screenshots-1');assert.match(screen.source.sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(screen.region,{normalizedWidth:24,normalizedHeight:32,x:2,y:9,width:20,height:10});
 assert.equal(Object.keys(screen.cards).length,384);assert.equal(screen.source.cards,384);
 const ids=new Set(cards.map((c:{id:string})=>c.id));for(const [id,data] of Object.entries(screen.cards)){assert.ok(ids.has(id));assert.equal(Buffer.from(data as string,'base64').length,200);}
 // Supplemental calibration never replaces the full catalog or its other artwork.
 assert.equal(cards.length,420);assert.ok(Object.keys(original).some(id=>!(id in screen.cards)));
 // Unverified atlas mappings retain their dictionary entry, never external pixels.
 const textOnly=cards.filter((card:{id:string})=>!original[card.id]&&!screen.cards[card.id]);
 assert.deepEqual(textOnly.map((card:{name:string})=>card.name).sort(),['찢겨진 발탄','아슈타로테','악몽의 게헤나','죽음의 계율자, 벨가르딘'].sort());
});

test('independent screenshot portraits accept 376 known cards without false identities',()=>{
 const fixture=json('./fixtures/screen-portrait-holdout.json'),match=createPortraitMatcher(cards,original,screen.cards);
 assert.equal(fixture.rows.length,400);let accepted=0,empty=0;
 for(const row of fixture.rows){
  const gray=Uint8Array.from(Buffer.from(row.gray,'base64'));assert.equal(gray.length,768);
  const result=match(gray);
  if(row.expected===null){empty++;assert.equal(result,null,`empty ${row.page}/${row.slot}`);}
  else if(result){accepted++;assert.equal(result.card.id,row.expected,`wrong identity ${row.page}/${row.slot}`);}
 }
 assert.equal(empty,16);assert.ok(accepted>=376,`accepted only ${accepted} of 384 owned cards`);
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
test('supplemental portraits do not invent an identity for empty backs or flat rasters',()=>{
 const match=createPortraitMatcher(cards,original,screen.cards),samples=json('./fixtures/artwork-detail-samples.json');
 for(const sample of samples.filter((s:{expected:string|null})=>!s.expected))assert.equal(match(Uint8Array.from(Buffer.from(sample.gray,'base64'))),null);
 assert.equal(match(new Uint8Array(768).fill(40)),null);
});
