import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{createPortraitMatcher,confirmPortrait,confirmPortraitWithText}from'../src/features/card-scanner/portrait-matcher.ts';
const json=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const{cards}=json('../public/scanner/cards.json'),atlas=json('../public/scanner/artwork-details.json'),samples=json('./fixtures/artwork-detail-samples.json');
test('two independent portrait regions agree with the OCR-validated screenshot inventory and never identify card backs',()=>{
 const match=createPortraitMatcher(cards,atlas);let accepted=0;
 for(const sample of samples){const result=match(Uint8Array.from(Buffer.from(sample.gray,'base64')));if(result){accepted++;assert.equal(result.card.name,sample.expected,`${sample.page}/${sample.row}/${sample.column}`);}}
 assert.equal(samples.length,400);assert.ok(accepted>=150);assert.ok(accepted<384);
});
test('a real compressed Orelda crop is independently confirmed above the banner area',()=>{
 const sample=json('./fixtures/portrait-corroboration.json'),match=createPortraitMatcher(cards,atlas);
 const text={id:sample.id,rawText:'오텔다',ocrConfidence:70,score:8/9,gap:2/9};
 const independent=match(sample.gray);assert.equal(independent?.card.name,'오렐다');
 assert.equal(independent?.portrait.region,'above-badge');
 const accepted=match(sample.gray,text);
 assert.equal(accepted?.card.name,'오렐다');
 assert.ok(accepted && confirmPortraitWithText(accepted.portrait,text));
 assert.equal(match(sample.gray,{...text,id:'another-card'}),null);
 const p={upper:.937222,lower:.9301,correlation:.93366,margin:.5299};
 assert.equal(confirmPortraitWithText(p,{...text,gap:.19999999999999996}),true);
 for(const change of [{upper:.90},{lower:.90},{correlation:.929},{margin:.299}])
  assert.equal(confirmPortraitWithText({...p,...change},text),false);
});
test('equipped Shandi needs both complete corrected text and independently matching unoccluded artwork',()=>{
 const samples=json('./fixtures/masked-portrait-corroboration.json'),match=createPortraitMatcher(cards,atlas);
 const sample=samples.find((s:{name:string})=>s.name==='샨디');
 const text={id:sample.id,rawText:'산디',canonicalName:'샨디',complete:true,ocrConfidence:58,score:5/6,gap:.5};
 assert.equal(match(sample.gray),null);
 const accepted=match(sample.gray,text);assert.equal(accepted?.card.name,'샨디');
 assert.equal(accepted?.portrait.region,'above-badge');
 for(const change of [{id:'another-card'},{complete:false},{canonicalName:'샨디라'},{rawText:'산ㄷ'},
   {rawText:'샨'},{ocrConfidence:49.9},{score:.829},{gap:.399}])
  assert.equal(match(sample.gray,{...text,...change}),null);
 const p=accepted!.portrait;
 for(const change of [{upper:.849},{lower:.849},{left:.839},{right:.839},{correlation:.859},{margin:.349}])
  assert.equal(confirmPortraitWithText({...p,...change},text),false);
 const wonpo=samples.find((s:{name:string})=>s.name==='원포');
 const picture=match(wonpo.gray);assert.equal(picture?.card.name,'원포');assert.ok(picture&&confirmPortrait(picture.portrait));
});
test('a single strong region, tied artworks, flat crops and corrupted regions cannot confirm a portrait',()=>{
 assert.equal(confirmPortrait({upper:.99,lower:.90,correlation:.945,margin:.4}),false);
 assert.equal(confirmPortrait({upper:.96,lower:.96,correlation:.96,margin:.19}),false);
 assert.equal(createPortraitMatcher(cards,atlas)(new Uint8Array(768).fill(50)),null);
 const sample=samples.find((s:{expected:string})=>s.expected==='가디언 루'),card=cards.find((c:{name:string})=>c.name==='가디언 루');
 const tied=createPortraitMatcher([card,{...card,id:'tied'}],{[card.id]:atlas[card.id],tied:atlas[card.id]});
 assert.equal(tied(Uint8Array.from(Buffer.from(sample.gray,'base64'))),null);
});
