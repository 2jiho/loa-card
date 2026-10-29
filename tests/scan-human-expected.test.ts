import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,readFile,readdir,rm,symlink,writeFile,mkdir,open}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
import{addCorpusCase,verifyCorpus}from'../scripts/scan-corpus-core.mjs';
import{parseHumanExpected,importHumanExpected,listHumanExpected,verifyHumanExpected,compareHumanExpected,runHumanExpectedCli,MAX_HUMAN_LABEL_BYTES}from'../scripts/scan-human-expected.mjs';
import{runCorpusCli}from'../scripts/scan-corpus.mjs';
import{InventoryEvidence,hashInventoryEvidence,inventoryEventData}from'../src/features/card-scanner/inventory-evidence';
import{RunStateTrace}from'../dev/run-state-trace';import type{ScannedCard}from'../src/features/card-scanner/recognizer';

const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
type Manifest={id:string;inputs:{index:number;sha256:string;bytes:number;name:string}[]};
const confirmation={authority:'human-user',recordedAt:'2026-10-26T00:00:00.000Z',question:'카드 상태?',answer:'0각 0장',wording:'normalized',capturedAt:null};
function label(m:Manifest,fields:Record<string,unknown>={name:{status:'known',value:'카드'},awakening:{status:'known',value:0},extraCopies:{status:'known',value:0}}){
 return{kind:'loacard-human-label',version:1,status:'human-confirmed',scope:'partial',caseId:m.id,
  inputs:m.inputs.map(({index,sha256,bytes})=>({index,sha256,bytes})),confirmation:clone(confirmation),cards:[{id:'card',fields}]};
}
async function fixture(run:(c:{dir:string;root:string;manifest:Manifest;file:string;value:ReturnType<typeof label>})=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'loa-human-'));try{
  const root=join(dir,'corpus'),input=join(dir,'video.mp4');await writeFile(input,'input bytes');const{manifest}=await addCorpusCase([input],{root});
  const value=label(manifest),file=join(dir,'label.json');await writeFile(file,JSON.stringify(value));await run({dir,root,manifest,file,value});
 }finally{await rm(dir,{recursive:true,force:true});}
}
const source=(order:number)=>({sessionId:'test',frameId:order,observationId:String(order),captureOrder:order,captureTime:order/10,phase:'input' as const,slot:0,frame:`test/frame/${order}`});
function card(order:number,extra:Partial<ScannedCard>={}):ScannedCard{return{id:'card',name:'카드',awakening:0,extraCopies:0,
 confidence:1,review:[],image:'',time:order/10,observations:1,captureOrder:order,countReliable:true,
 capturePosition:{frame:source(order).frame,slot:0,stable:true,sort:null},...extra};}
async function report(manifest:Manifest,mode='fresh'){
 const trace=new RunStateTrace();let clock=0;trace.record('inventory-seed',{version:1,cards:[]},clock++);
 const inv=new InventoryEvidence([],{onEvent:e=>trace.record('inventory-event',inventoryEventData(e),clock++)});
 const record=(order:number,changes:Partial<ScannedCard>={})=>{const s=source(order);inv.acceptIdentity(s,'card');if(mode!=='no-name')inv.confirmName(s,'card');inv.recordObservation(s,card(order,changes),1);};
 record(10);
 if(mode==='unresolved'){record(30,{extraCopies:null,countReliable:false,review:['추가 장수 확인']});record(20);}
 if(mode==='impossible')record(30,{awakening:4,extraCopies:10});
 if(mode==='identity-only'){inv.acceptIdentity(source(40),'card');inv.confirmName(source(40),'card');}
 const digest=await hashInventoryEvidence(inv.snapshot());trace.record('inventory-checkpoint',{complete:true,hash:digest},clock++);
 if(mode==='late-fact')inv.acceptIdentity(source(50),'card');
 return{result:{expected:1,read:1,unidentified:0,experience:null,cards:[{id:'card',name:'카드',awakening:0,extraCopies:0,review:mode==='unresolved'?['최신 각성·장수 확인']:[]}]},
  validation:{caseId:manifest.id,input:manifest.inputs,sourceChanged:false,sourceStart:{sourceDigest:hash('source')},sourceEnd:{sourceDigest:hash('source')}},
  executionExpected:{inventoryHash:digest},execution:JSON.parse(await(await trace.snapshotBlob()).text())};
}

test('strict partial schema preserves omitted, unknown and known zero without fake headers',()=>{
 const m={id:'a'.repeat(64),inputs:[{index:0,sha256:'b'.repeat(64),bytes:1,name:'x'}]},p=parseHumanExpected(label(m,{awakening:{status:'unknown'},extraCopies:{status:'known',value:0}}));
 assert.deepEqual(p.cards[0].fields,{awakening:{status:'unknown'},extraCopies:{status:'known',value:0}});
 assert.equal(Object.hasOwn(p.cards[0].fields,'name'),false);assert.equal(Object.hasOwn(p,'result'),false);
 const mutations=[(v:any)=>v.cards[0].fields.extraCopies.value=null,(v:any)=>v.cards[0].fields.extraCopies.value='0',
  (v:any)=>v.cards[0].fields.extraCopies.value=16,(v:any)=>v.cards[0].fields.awakening.value=6,
  (v:any)=>{v.cards[0].fields.awakening.value=4;v.cards[0].fields.extraCopies.value=10;},
  (v:any)=>v.cards.push(v.cards[0]),(v:any)=>v.cards[0].fields.review={status:'known',value:[]},
  (v:any)=>v.cards[0].fields.awakening={status:'unknown',value:null},(v:any)=>v.version=2,(v:any)=>v.headers={}];
 for(const mutate of mutations){const value=label(m);mutate(value);assert.throws(()=>parseHumanExpected(value));}
});

test('import requires an operator assertion and preserves manifests; repeated labels deduplicate confirmations',async()=>{
 await fixture(async({dir,root,manifest,file,value})=>{
  const manifestPath=join(root,'cases',manifest.id,'manifest.json'),before=await readFile(manifestPath);
  await assert.rejects(importHumanExpected(manifest.id,file,{root}),/operator-confirmed/);
  const first=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true});
  await writeFile(file,JSON.stringify(value,null,5));const again=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true});
  assert.equal(first.sha256,again.sha256);assert.equal(first.created,true);assert.equal(again.created,false);
  assert.deepEqual(await readFile(manifestPath),before);assert.equal((await verifyHumanExpected(first.sha256,{root})).verified,true);
  const input=join(dir,'other.mp4');await writeFile(input,'different bytes');const secondCase=(await addCorpusCase([input],{root})).manifest;
  const secondFile=join(dir,'second.json');await writeFile(secondFile,JSON.stringify(label(secondCase)));
  const second=await importHumanExpected(secondCase.id,secondFile,{root,operatorConfirmed:true});
  assert.equal(first.confirmationSha256,second.confirmationSha256);const listed=await listHumanExpected({root});
  assert.equal(listed.labels.length,2);assert.equal(listed.confirmations,1);
  assert.equal((await verifyCorpus({root})).verified,true);assert.deepEqual(await readdir(join(root,'human-labels','.tmp')),[]);
 });
});

test('import rejects wrong ordered inputs, oversized/invalid UTF8, case escape and immutable corruption',async()=>{
 await fixture(async({root,manifest,file,value})=>{
  const wrong=clone(value);wrong.inputs[0].sha256='f'.repeat(64);await writeFile(file,JSON.stringify(wrong));
  await assert.rejects(importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),/input hash/);
  await writeFile(file,Buffer.from([123,255,125]));await assert.rejects(importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),/UTF-8/);
  await writeFile(file,' '.repeat(MAX_HUMAN_LABEL_BYTES+1));await assert.rejects(importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),/size limit/);
  await writeFile(file,JSON.stringify(value));await assert.rejects(importHumanExpected('../escape',file,{root,operatorConfirmed:true}),/SHA-256/);
  const imported=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true});await writeFile(imported.file,'corrupt');
  await assert.rejects(importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),/conflict/);
  assert.equal(await readFile(imported.file,'utf8'),'corrupt');await assert.rejects(verifyHumanExpected(imported.sha256,{root}),/checksum/);
 });
});

test('label and registry symlinks are refused rather than followed',async t=>{
 await fixture(async({dir,root,manifest,file})=>{
  const alias=join(dir,'alias.json');let fileLink=true;try{await symlink(file,alias,'file');}catch(e:any){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){fileLink=false;t.diagnostic('File symlink creation unavailable; directory junction is still tested.');}else throw e;}
  if(fileLink)await assert.rejects(importHumanExpected(manifest.id,alias,{root,operatorConfirmed:true}),/Symlink|symlink/);
  const outside=join(dir,'outside');await mkdir(outside);await symlink(outside,join(root,'human-labels'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),/symlink|junction/);assert.deepEqual(await readdir(outside),[]);
 });
});

test('private flat labels require explicit migration and bind a copied PNG without following metadata paths',async()=>{
 await fixture(async({dir,root,manifest,file})=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'),asset=join(dir,'crop.png');await writeFile(asset,png);
  const value={kind:'loacard-human-expected',version:1,status:'human-confirmed',scope:'partial',registeredAt:confirmation.recordedAt,
   caseId:manifest.id,inputSha256:manifest.inputs[0].sha256,inputBytes:manifest.inputs[0].bytes,
   assertedFields:['id','name','awakening','extraCopies'],unassertedFields:['review'],cards:[{id:'card',name:'카드',awakening:0,extraCopies:0}],
   provenance:{authority:'human-user',status:'human-confirmed',source:'direct human answer',questionContext:confirmation.question,normalizedAnswer:confirmation.answer,
    recordedAt:confirmation.recordedAt,answeredAt:null,capturedAt:null,timeMeaning:'label registration only',programBaselinePromoted:false,independentHumanConfirmations:1},
   evidence:{original:{},duplicatePolicy:'one answer',replay:{caseId:manifest.id,input:manifest.inputs[0],producerSource:hash('source'),
    sourceFrameId:21,acquisitionFrameId:8,observationId:'46',phase:'input',slot:5,captureOrder:136620006,captureTime:3.4155,
    captureClock:'browser capture clock, not original-video PTS',box:{x:0,y:0,width:1,height:1},fullRgbaSha256:hash('frame'),cropRgbaSha256:hash('rgba'),
    cropPng:{file:'../../must-not-follow.png',sha256:hash(png),bytes:png.length},exactPixelJoinEvidence:{file:'https://must-not-fetch'}}},role:'original',boundaries:{oneCardOnly:true}};
  await writeFile(file,JSON.stringify(value));await assert.rejects(importHumanExpected(manifest.id,file,{root,operatorConfirmed:true,asset}),/object keys|format/);
  const imported=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true,migratePrivateV1:true,asset});
  const verified=await verifyHumanExpected(imported.sha256,{root});assert.equal(verified.anchorAssetVerified,true);assert.equal(verified.anchorPixelProof,'not-restored-by-this-command');
  const stored=JSON.parse(await readFile(imported.file,'utf8'));assert.equal(stored.anchor.clock,'browser-capture');assert.equal(stored.cards[0].fields.extraCopies.value,0);
  assert.equal(JSON.stringify(stored).includes('must-not-'),false);assert.equal(stored.confirmation.capturedAt,null);
  const again=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true,migratePrivateV1:true});assert.equal(again.created,false);
  await writeFile(asset,'wrong image');await assert.rejects(importHumanExpected(manifest.id,file,{root,operatorConfirmed:true,migratePrivateV1:true,asset}),/PNG/);
  const bad=clone(stored);bad.anchor.clock='original-video';assert.throws(()=>parseHumanExpected(bad),/clock/);
  bad.anchor.clock='browser-capture';bad.anchor.box.x=.5;assert.throws(()=>parseHumanExpected(bad),/integer/);
 });
});

test('compare keeps zero tuple equality separate from unresolved latest evidence and from unsupported traces',async()=>{
 await fixture(async({dir,root,manifest,file})=>{
  const imported=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),actual=join(dir,'actual.json');
  for(const mode of ['fresh','unresolved','identity-only','late-fact','impossible']){
   await writeFile(actual,JSON.stringify(await report(manifest,mode)));const result=await compareHumanExpected(imported.sha256,actual,{root});
   assert.equal(result.valueMatches,true,mode);assert.equal(result.fieldProofPassed,mode==='fresh'?true:mode==='late-fact'?null:false,mode);
   assert.equal(result.exitCode,mode==='fresh'?0:3,mode);
  }
  const value=await report(manifest);delete (value as any).execution;await writeFile(actual,JSON.stringify(value));
  const unsupported=await compareHumanExpected(imported.sha256,actual,{root});assert.equal(unsupported.fieldProofPassed,null);assert.equal(unsupported.exitCode,3);
  value.result.cards[0].extraCopies=1;await writeFile(actual,JSON.stringify(value));assert.equal((await compareHumanExpected(imported.sha256,actual,{root})).exitCode,2);
  value.validation.input[0].sha256='f'.repeat(64);await writeFile(actual,JSON.stringify(value));await assert.rejects(compareHumanExpected(imported.sha256,actual,{root}),/input hash/);
 });
});

test('explicit unknown fields are not counted as correct labels and values-only never certifies freshness',async()=>{
 await fixture(async({dir,root,manifest,file})=>{
  await writeFile(file,JSON.stringify(label(manifest,{extraCopies:{status:'unknown'}})));const imported=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true});
  const actual=join(dir,'actual.json');await writeFile(actual,JSON.stringify(await report(manifest)));
  const result=await compareHumanExpected(imported.sha256,actual,{root});assert.equal(result.checkedFields,0);assert.equal(result.fieldProofPassed,null);assert.equal(result.exitCode,3);
  const only=await compareHumanExpected(imported.sha256,actual,{root,valuesOnly:true});assert.equal(only.latestEvidenceSupported,false);assert.equal(only.exitCode,3);
 });
});

test('an unknown-only card cannot block the scoped proof of a different known card',async()=>{
 await fixture(async({dir,root,manifest,file,value})=>{
  value.cards.push({id:'unlabelled-card',fields:{extraCopies:{status:'unknown'}}});await writeFile(file,JSON.stringify(value));
  const imported=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),actual=join(dir,'actual.json');
  await writeFile(actual,JSON.stringify(await report(manifest)));const result=await compareHumanExpected(imported.sha256,actual,{root});
  assert.equal(result.checkedFields,3);assert.equal(result.valueMatches,true);assert.equal(result.fieldProofPassed,true);assert.equal(result.exitCode,0);
  assert.equal(result.cards.find(c=>c.id==='unlabelled-card')!.latestEvidence.status,'unasserted');
 });
});

test('name-only labels require current confirmed name evidence without demanding unlabelled numeric proof',async()=>{
 await fixture(async({dir,root,manifest,file})=>{
  await writeFile(file,JSON.stringify(label(manifest,{name:{status:'known',value:'카드'},awakening:{status:'unknown'},extraCopies:{status:'unknown'}})));
  const imported=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),actual=join(dir,'actual.json');
  await writeFile(actual,JSON.stringify(await report(manifest,'unresolved')));let result=await compareHumanExpected(imported.sha256,actual,{root});
  assert.equal(result.checkedFields,1);assert.equal(result.valueMatches,true);assert.equal(result.fieldProofPassed,true);assert.equal(result.exitCode,0);
  assert.equal(result.cards[0].latestEvidence.jointFieldContract,false);assert.equal(result.cards[0].latestEvidence.jointFieldsConfirmed,false);
  for(const mode of ['identity-only','no-name']){await writeFile(actual,JSON.stringify(await report(manifest,mode)));result=await compareHumanExpected(imported.sha256,actual,{root});assert.equal(result.fieldProofPassed,false,mode);assert.equal(result.exitCode,3,mode);}
 });
});

test('one known numeric field still needs a valid current numeric pair but does not assert the other number or name',async()=>{
 await fixture(async({dir,root,manifest,file})=>{
  await writeFile(file,JSON.stringify(label(manifest,{awakening:{status:'known',value:0},extraCopies:{status:'unknown'}})));
  const imported=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),actual=join(dir,'actual.json');
  await writeFile(actual,JSON.stringify(await report(manifest,'unresolved')));let result=await compareHumanExpected(imported.sha256,actual,{root});
  assert.equal(result.checkedFields,1);assert.equal(result.valueMatches,true);assert.equal(result.fieldProofPassed,false);assert.equal(result.exitCode,3);
  assert.equal(result.cards[0].latestEvidence.jointFieldContract,true);
  const fresh=await report(manifest);fresh.result.cards[0].name='별도 표시 이름';await writeFile(actual,JSON.stringify(fresh));result=await compareHumanExpected(imported.sha256,actual,{root});
  assert.equal(result.checkedFields,1);assert.equal(result.fieldProofPassed,true);assert.equal(result.exitCode,0);
  assert.equal(result.cards[0].fields.extraCopies.status,'unasserted-unknown');assert.equal(Object.hasOwn(result.cards[0].fields,'name'),false);
 });
});

test('failed staging writes are closed and removed before a retry',async t=>{
 await fixture(async({dir,root,manifest,file})=>{
  const probe=await open(join(dir,'handle-type'),'wx'),prototype=Object.getPrototypeOf(probe);await probe.close();
  const write=t.mock.method(prototype,'writeFile',async()=>{throw Object.assign(new Error('simulated full disk'),{code:'ENOSPC'});});
  await assert.rejects(importHumanExpected(manifest.id,file,{root,operatorConfirmed:true}),/simulated full disk/);
  write.mock.restore();assert.deepEqual(await readdir(join(root,'human-labels','.tmp')),[]);
  const imported=await importHumanExpected(manifest.id,file,{root,operatorConfirmed:true});assert.equal(imported.created,true);
 });
});

test('new commands route lazily and preserve legacy comparison; bad arguments reject',async()=>{
 await fixture(async({dir,root,manifest,file})=>{
  let output='';const write=(s:string)=>{output=s;};
  assert.equal(await runCorpusCli(['import-human',manifest.id,file,'--root',root,'--operator-confirmed'],write),0);const imported=JSON.parse(output);
  assert.equal(await runCorpusCli(['verify-human',imported.sha256,'--root',root],write),0);
  assert.equal(await runCorpusCli(['list-human',manifest.id,'--root',root],write),0);assert.equal(JSON.parse(output).labels.length,1);
  const actual=join(dir,'actual.json');await writeFile(actual,JSON.stringify(await report(manifest,'unresolved')));
  assert.equal(await runCorpusCli(['compare-human',imported.sha256,actual,'--root',root],write),3);assert.equal(JSON.parse(output).valueMatches,true);
  assert.equal(await runCorpusCli(['compare',actual,actual,'--scope','partial'],write),0);
  await assert.rejects(runHumanExpectedCli(['list','--unknown'],write),/option/);
  await assert.rejects(runHumanExpectedCli(['import',manifest.id,file,'--operator-confirmed','--operator-confirmed'],write),/repeated/);
 });
});
