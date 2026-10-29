import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{createPortraitMatcher,confirmPortrait,confirmPortraitWithText,MAX_PORTRAIT_DIAGNOSTIC_STAGES,MAX_PORTRAIT_DIAGNOSTIC_CANDIDATES,MAX_PORTRAIT_DIAGNOSTIC_ID_CHARS}from'../src/features/card-scanner/portrait-matcher.ts';
import type{PortraitMatchDiagnostic,PortraitTextEvidence,PortraitEvidence}from'../src/features/card-scanner/portrait-matcher.ts';
import {parsePortraitDiagnostics} from '../src/features/card-scanner/portrait-diagnostics';
const json=(path:string)=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const{cards}=json('../public/scanner/cards.json'),atlas=json('../public/scanner/artwork-details.json'),samples=json('./fixtures/artwork-detail-samples.json');
test('missing text identity reference is explicit and cannot borrow another card portrait',()=>{
 const sample=json('./fixtures/portrait-corroboration.json');
 for(const fractionalRegistration of [false,true]){
  const match=createPortraitMatcher(cards,atlas,{}, {fractionalRegistration});
  let diagnostic:PortraitMatchDiagnostic|undefined;
  const result=match(sample.gray,{id:'missing-reference',rawText:'테스트',ocrConfidence:100,score:1,gap:1},value=>{diagnostic=value;});
  assert.equal(result,null);assert.equal(diagnostic?.reason,'missing-text-reference');
  assert.equal(diagnostic?.outcome,'unavailable');assert.deepEqual(diagnostic?.stages,[]);
  assert.ok(parsePortraitDiagnostics([{source:'computed',mode:'text',diagnostic}]));
  assert.equal(match(sample.gray)?.card.id,sample.id,'independent visual matching is unchanged');
 }
});
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

function translatedPortrait(shift=.5) {
 const image=(x:number,y:number)=>120+40*Math.sin(x)+30*Math.cos(y*.7)+20*Math.sin(x*.4+y*.55);
 const other=(x:number,y:number)=>120+40*Math.cos(x*.43-y*.92)+30*Math.sin(x*.61+y*.24);
 const gray=Float32Array.from({length:768},(_,i)=>image(i%24+shift,Math.floor(i/24)));
 const encode=(pixel:(x:number,y:number)=>number)=>Buffer.from(Uint8Array.from({length:200},(_,i)=>
  Math.round(pixel(2+i%20,9+Math.floor(i/20))))).toString('base64');
 const references=[{...cards[0],id:'registration-target',name:'Registration target'},
  {...cards[1],id:'registration-other',name:'Registration other'}];
 return {gray,references,atlas:{'registration-target':encode(image),'registration-other':encode(other)}};
}

test('optional fractional registration corrects a sub-cell translation without changing the default path',()=>{
 const fixture=translatedPortrait(),options={fractionalRegistration:false};
 const defaultMatcher=createPortraitMatcher(fixture.references,fixture.atlas);
 const disabled=createPortraitMatcher(fixture.references,fixture.atlas,{},options);
 options.fractionalRegistration=true;
 assert.equal(defaultMatcher(fixture.gray),null);
 assert.equal(disabled(fixture.gray),null,'factory options are snapshotted; default remains off');
 const refined=createPortraitMatcher(fixture.references,fixture.atlas,{},options)(fixture.gray);
 assert.equal(refined?.card.id,'registration-target');
 assert.equal(refined?.portrait.registration,'quarter-cell-v1');
 assert.ok(refined&&confirmPortrait(refined.portrait),'original two-region/margin gates still decide');
});

test('registration metadata distinguishes refined banner evidence from the unchanged integer fast path',()=>{
 const aligned=translatedPortrait(0),integer=createPortraitMatcher(aligned.references,aligned.atlas,{}, {fractionalRegistration:true})(aligned.gray);
 assert.ok(integer);assert.equal(Object.hasOwn(integer.portrait,'registration'),false);
 const shifted=translatedPortrait(),obscured=shifted.gray.slice();obscured.fill(100,16*24,20*24);
 const baseline=createPortraitMatcher(shifted.references,shifted.atlas)(obscured);
 assert.equal(baseline,null);
 const refined=createPortraitMatcher(shifted.references,shifted.atlas,{}, {fractionalRegistration:true})(obscured);
 assert.equal(refined?.card.id,'registration-target');assert.equal(refined?.portrait.region,'above-badge');
 assert.equal(refined?.portrait.registration,'quarter-cell-v1');
});

test('fractional registration still rejects tied identities, wrong text, flat images and a missing independent region',()=>{
 const {gray,references,atlas}=translatedPortrait();
 const match=createPortraitMatcher(references,atlas,{}, {fractionalRegistration:true});
 const tied=createPortraitMatcher(references,{...atlas,'registration-other':atlas['registration-target']},{}, {fractionalRegistration:true});
 assert.equal(tied(gray),null,'every distinct identity receives the same refinement, including the runner-up');
 assert.equal(match(gray,{id:'registration-other',rawText:'Registration other',ocrConfidence:99,score:1,gap:1}),null);
 assert.equal(match(new Uint8Array(768).fill(100)),null);
 const corrupt=gray.slice();corrupt.fill(100,14*24,20*24);
 assert.equal(match(corrupt),null,'one strong region is insufficient');
});

test('fractional option preserves accepted screenshot identities and does not identify unowned backs',()=>{
 const screen=json('../public/scanner/screen-artwork-details.json').cards;
 for(const supplement of [{},screen]){
  const baseline=createPortraitMatcher(cards,atlas,supplement),refined=createPortraitMatcher(cards,atlas,supplement,{fractionalRegistration:true});
  for(const sample of samples){
   const gray=Uint8Array.from(Buffer.from(sample.gray,'base64')),before=baseline(gray),after=refined(gray);
   if(before)assert.deepEqual(after,before,'an accepted integer registration must return before refinement');
   if(after)assert.equal(after.card.name,sample.expected,`${sample.page}/${sample.row}/${sample.column}`);
  }
 }
 const holdout=json('./fixtures/screen-portrait-holdout.json'),refined=createPortraitMatcher(cards,atlas,screen,{fractionalRegistration:true});
 for(const row of holdout.rows){
  const after=refined(Uint8Array.from(Buffer.from(row.gray,'base64')));
  if(row.expected===null)assert.equal(after,null,`empty ${row.page}/${row.slot}`);
  else if(after)assert.equal(after.card.id,row.expected,`identity ${row.page}/${row.slot}`);
 }
});

test('fractional option preserves coarse text-assisted results and refuses mismatched text identities',()=>{
 const orelda=json('./fixtures/portrait-corroboration.json');
 const masked=json('./fixtures/masked-portrait-corroboration.json'),shandi=masked.find((sample:{name:string})=>sample.name==='샨디');
 const baseline=createPortraitMatcher(cards,atlas),refined=createPortraitMatcher(cards,atlas,{}, {fractionalRegistration:true});
 const observations=[
  {gray:orelda.gray,text:{id:orelda.id,rawText:'오텔다',ocrConfidence:70,score:8/9,gap:2/9}},
  {gray:shandi.gray,text:{id:shandi.id,rawText:'산디',canonicalName:'샨디',complete:true,ocrConfidence:58,score:5/6,gap:.5}},
 ];
 for(const {gray,text}of observations){
  const before=baseline(gray,text);assert.ok(before);assert.deepEqual(refined(gray,text),before);
  assert.equal(refined(gray,{...text,id:'another-card'}),null);
 }
 for(const sample of masked){
  const after=refined(sample.gray);if(after)assert.equal(after.card.id,sample.id,sample.name);
 }
});

test('fractional registration cannot select between different named cards that share the same robot artwork',()=>{
 const screen=json('../public/scanner/screen-artwork-details.json').cards;
 const related=cards.filter((card:{id:string})=>['3200157','3200208'].includes(card.id));
 assert.equal(related.length,2);
 const sample=samples.find((sample:{expected:string})=>sample.expected==='솔 그랑데');assert.ok(sample);
 const gray=Uint8Array.from(Buffer.from(sample.gray,'base64'));
 for(const supplement of [{},screen]){
  const baseline=createPortraitMatcher(related,atlas,supplement),refined=createPortraitMatcher(related,atlas,supplement,{fractionalRegistration:true});
  assert.equal(baseline(gray),null);
  assert.equal(refined(gray),null,'registration cannot establish a unique ID when another name shares the artwork');
 }
});

function checkDiagnostic(packet:PortraitMatchDiagnostic,text?:PortraitTextEvidence&{id:string}) {
 assert.ok(Object.isFrozen(packet));assert.ok(Object.isFrozen(packet.stages));
 assert.ok(packet.stages.length<=MAX_PORTRAIT_DIAGNOSTIC_STAGES);
 for(const stage of packet.stages){
  assert.ok(Object.isFrozen(stage));assert.ok(Object.isFrozen(stage.candidates));assert.equal(stage.candidates.length,MAX_PORTRAIT_DIAGNOSTIC_CANDIDATES);
  assert.ok(stage.queryCount>=0&&stage.queryCount<=81);
  const top=stage.candidates[0],masked=stage.stage==='above-badge'||stage.stage==='refined-above-badge';
  const p:PortraitEvidence={upper:top.upper,lower:top.lower,correlation:top.correlation,margin:top.margin,
   ...(masked?{region:'above-badge',left:top.left??undefined,right:top.right??undefined}:{})};
  for(const [index,candidate]of stage.candidates.entries()){
   assert.ok(Object.isFrozen(candidate));assert.ok(candidate.id.length<=MAX_PORTRAIT_DIAGNOSTIC_ID_CHARS);
   assert.equal(candidate.evaluatedForAcceptance,index===0);
   assert.equal(candidate.margin,candidate.correlation-stage.candidates[index===0?1:0].correlation);
   if(candidate.registration){assert.ok(Object.isFrozen(candidate.registration));assert.ok(Object.isFrozen(candidate.roi));
    for(const region of Object.values(candidate.roi!))if(region)assert.ok(Object.isFrozen(region));
   }else assert.equal(candidate.roi,null);
  }
  assert.ok(Object.isFrozen(stage.decision));assert.ok(Object.isFrozen(stage.decision.independent));assert.ok(Object.isFrozen(stage.decision.text));
  const picture=stage.decision.independent,corroboration=stage.decision.text;
  if(picture.evaluated){
   assert.equal(picture.passed,confirmPortrait(p));assert.ok(Object.isFrozen(picture.checks));
   assert.equal(Object.values(picture.checks!).every(value=>value!==false),picture.passed);
  }else{assert.equal(picture.passed,null);assert.equal(picture.checks,null);}
  if(corroboration.evaluated){
   assert.ok(text);assert.equal(corroboration.passed,confirmPortraitWithText(p,text));assert.ok(Object.isFrozen(corroboration.checks));
   assert.equal(Object.values(corroboration.checks!).every(value=>value!==false),corroboration.passed);
  }else{assert.equal(corroboration.passed,null);assert.equal(corroboration.checks,null);}
 }
}

test('optional portrait diagnostics report the selected integer registration and fixed ROIs without changing the identity',()=>{
 const fixture=translatedPortrait(0),match=createPortraitMatcher(fixture.references,fixture.atlas),packets:PortraitMatchDiagnostic[]=[];
 const baseline=match(fixture.gray),observed=match(fixture.gray,undefined,packet=>packets.push(packet));
 assert.deepEqual(observed,baseline);assert.ok(observed);assert.equal(observed.card,fixture.references[0]);
 assert.equal(packets.length,1);const packet=packets[0];checkDiagnostic(packet);
 assert.equal(packet.outcome,'accepted');assert.equal(packet.reason,'accepted');assert.equal(packet.coordinateSpace,'gray-grid-24x32');assert.equal(packet.text,null);
 assert.deepEqual(packet.stages.map(stage=>stage.stage),['normal']);
 const stage=packet.stages[0],top=stage.candidates[0];assert.equal(top.id,observed.card.id);assert.equal(stage.queryCount,9);
 assert.deepEqual(top.registration,{dx:0,dy:0,interpolation:'integer'});
 assert.deepEqual(top.roi,{upper:{x:2,y:9,width:20,height:5},lower:{x:2,y:14,width:20,height:5},left:null,right:null});
 for(const key of ['upper','lower','correlation','margin'] as const)assert.equal(top[key],observed.portrait[key]);
 assert.equal(stage.decision.independent.passed,true);assert.equal(stage.decision.text.evaluated,false);assert.equal(stage.decision.accepted,true);
});

test('portrait diagnostics preserve tied rejections and retain only top2 for the four actually evaluated stages',()=>{
 const fixture=translatedPortrait(),refs=[...fixture.references,{...fixture.references[1],id:'third'}];
 const tied={...fixture.atlas,'registration-other':fixture.atlas['registration-target'],third:fixture.atlas['registration-target']};
 const match=createPortraitMatcher(refs,tied,{}, {fractionalRegistration:true}),packets:PortraitMatchDiagnostic[]=[];
 assert.equal(match(fixture.gray),null);assert.equal(match(fixture.gray,undefined,packet=>packets.push(packet)),null);
 assert.equal(packets.length,1);const packet=packets[0];checkDiagnostic(packet);
 assert.equal(packet.referenceIdentities,3);assert.equal(packet.outcome,'rejected');assert.equal(packet.reason,'all-stages-rejected');
 assert.deepEqual(packet.stages.map(stage=>stage.stage),['normal','above-badge','refined-normal','refined-above-badge']);
 assert.deepEqual(packet.stages.map(stage=>stage.queryCount),[9,9,81,81]);
 for(const stage of packet.stages){assert.equal(stage.candidates.length,2);assert.equal(stage.candidates[0].margin,0);assert.equal(stage.decision.accepted,false);assert.equal(stage.decision.independent.checks?.margin,false);}
 assert.ok(JSON.stringify(packet).length<16_384,'fixed stage/candidate bounds do not retain the full catalog rank');
});

test('diagnostics distinguish text eligibility, actual corroboration and an independently accepted picture',()=>{
 const fixtures=json('./fixtures/masked-portrait-corroboration.json'),sample=fixtures.find((s:{name:string})=>s.name==='샨디');
 const match=createPortraitMatcher(cards,atlas),text={id:sample.id,rawText:'산디',canonicalName:'샨디',complete:true,ocrConfidence:58,score:5/6,gap:.5};
 const otherId=Object.keys(atlas).find(id=>id!==sample.id)!;
 for(const change of [{},{complete:false},{ocrConfidence:49.9},{rawText:'산ㄷ'},{id:otherId}]){
  const actualText={...text,...change},packets:PortraitMatchDiagnostic[]=[];
  const baseline=match(sample.gray,actualText),observed=match(sample.gray,actualText,packet=>packets.push(packet));
  assert.deepEqual(observed,baseline);assert.equal(packets.length,1);checkDiagnostic(packets[0],actualText);
  const stage=packets[0].stages.find(s=>s.stage==='above-badge')!;assert.ok(stage);
  if(actualText.id!==sample.id){assert.equal(stage.decision.textIdMatches,false);assert.equal(stage.decision.independent.evaluated,false);assert.equal(stage.decision.text.evaluated,false);}
  else{assert.equal(stage.decision.independent.passed,false);assert.equal(stage.decision.text.evaluated,true);assert.equal(stage.decision.text.passed,!!observed);}
 }
 const orelda=json('./fixtures/portrait-corroboration.json'),packets:PortraitMatchDiagnostic[]=[];
 const textAccepted=match(orelda.gray,{id:orelda.id,rawText:'오텔다',ocrConfidence:70,score:8/9,gap:2/9},packet=>packets.push(packet));
 assert.ok(textAccepted);const assisted=packets[0].stages.at(-1)!;
 assert.equal(assisted.stage,'normal');assert.equal(assisted.decision.independent.passed,false);assert.equal(assisted.decision.text.evaluated,true);assert.equal(assisted.decision.text.passed,true);
 const aligned=translatedPortrait(0),independentPackets:PortraitMatchDiagnostic[]=[];
 const independent=createPortraitMatcher(aligned.references,aligned.atlas)(aligned.gray,
  {id:aligned.references[0].id,rawText:'Registration target',ocrConfidence:99,score:1,gap:1},packet=>independentPackets.push(packet));
 assert.ok(independent);const accepted=independentPackets[0].stages.at(-1)!;
 assert.equal(accepted.decision.independent.passed,true);assert.equal(accepted.decision.text.evaluated,false);assert.equal(accepted.decision.text.passed,null);
});

test('fractional diagnostics expose the existing best quarter-cell query and above-badge sampling geometry',()=>{
 const fixture=translatedPortrait(),match=createPortraitMatcher(fixture.references,fixture.atlas,{}, {fractionalRegistration:true});
 for(const obscured of [false,true]){
  const gray=fixture.gray.slice();if(obscured)gray.fill(100,16*24,20*24);
  const packets:PortraitMatchDiagnostic[]=[],baseline=match(gray),observed=match(gray,undefined,packet=>packets.push(packet));
  assert.deepEqual(observed,baseline);assert.equal(observed?.portrait.registration,'quarter-cell-v1');assert.equal(packets.length,1);checkDiagnostic(packets[0]);
  const last=packets[0].stages.at(-1)!,top=last.candidates[0];
  assert.equal(last.stage,obscured?'refined-above-badge':'refined-normal');assert.equal(last.queryCount,81);assert.equal(last.decision.accepted,true);
  assert.ok(top.registration);assert.equal(top.registration.interpolation,'bilinear');assert.ok(!Number.isInteger(top.registration.dx)||!Number.isInteger(top.registration.dy));
  assert.equal(top.roi?.upper.x,2+top.registration.dx);assert.equal(top.roi?.upper.y,9+top.registration.dy);
  assert.equal(top.roi?.lower.height,obscured?2:5);assert.equal(top.roi?.lower.y,14+top.registration.dy);
  if(obscured){assert.equal(top.roi?.left?.width,10);assert.equal(top.roi?.right?.x,12+top.registration.dx);}
  else{assert.equal(top.roi?.left,null);assert.equal(top.roi?.right,null);}
  for(const key of ['upper','lower','correlation','margin'] as const)assert.equal(top[key],observed!.portrait[key]);
 }
});

test('diagnostics do not add gray reads and throwing or mutating observers cannot change a result',()=>{
 const fixture=translatedPortrait(),match=createPortraitMatcher(fixture.references,fixture.atlas,{}, {fractionalRegistration:true});
 function reads(observe:boolean){let count=0;const gray=new Proxy(fixture.gray,{get(target,key){if(typeof key==='string'&&/^\d+$/.test(key))count++;return Reflect.get(target,key,target);}});
  const result=observe?match(gray,undefined,packet=>{assert.ok(Object.isFrozen(packet));throw Error('diagnostic sink failed');}):match(gray);
  return {count,result};
 }
 const baseline=reads(false),observed=reads(true);assert.ok(baseline.count>0);assert.equal(observed.count,baseline.count);assert.deepEqual(observed.result,baseline.result);
 const packets:PortraitMatchDiagnostic[]=[];
 assert.deepEqual(match(fixture.gray,undefined,packet=>{
  packets.push(packet);assert.throws(()=>{(packet.stages as unknown as unknown[]).push('extra');},TypeError);
  assert.throws(()=>{(packet.stages[0].candidates[0] as unknown as {id:string}).id='changed';},TypeError);
 }),baseline.result);
 const snapshot=JSON.stringify(packets[0]);match(new Uint8Array(768).fill(50),undefined,packet=>packets.push(packet));
 assert.equal(packets.length,2);assert.notEqual(packets[0],packets[1]);assert.notEqual(packets[0].stages,packets[1].stages);assert.equal(JSON.stringify(packets[0]),snapshot);
});

test('invalid and flat portrait inputs report unavailable measurements without inventing registrations',()=>{
 const fixture=translatedPortrait(0),match=createPortraitMatcher(fixture.references,fixture.atlas),packets:PortraitMatchDiagnostic[]=[];
 assert.equal(match(new Uint8Array(767),undefined,packet=>packets.push(packet)),null);
 assert.equal(packets[0].reason,'invalid-gray-size');assert.equal(packets[0].outcome,'unavailable');assert.equal(packets[0].stages.length,0);
 assert.equal(createPortraitMatcher([fixture.references[0]],fixture.atlas)(fixture.gray,undefined,packet=>packets.push(packet)),null);
 assert.equal(packets[1].reason,'insufficient-identities');assert.equal(packets[1].stages.length,0);
 assert.equal(match(new Uint8Array(768).fill(50),undefined,packet=>packets.push(packet)),null);checkDiagnostic(packets[2]);
 for(const stage of packets[2].stages){assert.equal(stage.queryCount,0);for(const candidate of stage.candidates){assert.equal(candidate.registration,null);assert.equal(candidate.roi,null);}}
});

test('diagnostic IDs and text snapshots are bounded and detached while returned card identity stays unchanged',()=>{
 const fixture=translatedPortrait(0),id='target-'+ 'x'.repeat(300),references=[{...fixture.references[0],id},fixture.references[1]];
 const match=createPortraitMatcher(references,{...fixture.atlas,[id]:fixture.atlas['registration-target']}),packets:PortraitMatchDiagnostic[]=[];
 const text={id,rawText:'Visible name',canonicalName:'Canonical name',complete:true,ocrConfidence:Infinity,score:1,gap:1};
 const baseline=match(fixture.gray,text),observed=match(fixture.gray,text,packet=>packets.push(packet));
 assert.deepEqual(observed,baseline);assert.equal(observed?.card.id,id);assert.equal(packets.length,1);
 const packet=packets[0];checkDiagnostic(packet,text);assert.equal(packet.text?.id.length,MAX_PORTRAIT_DIAGNOSTIC_ID_CHARS);assert.equal(packet.text?.idTruncated,true);assert.equal(packet.text?.ocrConfidence,null);
 assert.equal(packet.stages[0].candidates[0].idTruncated,true);assert.equal(packet.stages[0].candidates[0].id.length,MAX_PORTRAIT_DIAGNOSTIC_ID_CHARS);
 const frozen=JSON.stringify(packet);text.rawText='changed';text.ocrConfidence=1;assert.equal(JSON.stringify(packet),frozen);
 assert.equal(JSON.stringify(packet).includes('Visible name'),false);assert.equal(JSON.stringify(packet).includes(fixture.atlas['registration-target']),false);
});
