import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InventoryEvidence,hashInventoryEvidence,inventoryEventData} from '../src/features/card-scanner/session/inventory-evidence';
import type {InventorySource} from '../src/features/card-scanner/session/inventory-evidence';
import type {NameEvidence,ScannedCard} from '../src/features/card-scanner/recognition/recognizer';
import {RunStateTrace,compareLegacyInventoryCandidate,replayRunStateTrace} from '../dev/run-state-trace';
import {runCorpusCli} from '../scripts/scan-corpus.mjs';

function source(order:number):InventorySource {
 return {sessionId:'legacy',frameId:order,observationId:`observation-${order}`,captureOrder:order,
  captureTime:order/10,phase:'input',slot:0,frame:`legacy/frame-${order}`};
}
function card(input:InventorySource,engine:'paddle'|'tesseract',rawText:string):ScannedCard {
 const evidence:NameEvidence={rawText,normalizedText:rawText,engine,readingId:`reading-${input.frameId}`,
  fingerprint:`pixels-${input.frameId}`,ocrConfidence:90,score:.95,gap:.3,exact:false,stable:true,frame:input.frame};
 return {id:'short',name:'발탄',awakening:0,extraCopies:2,confidence:.95,review:['이름 확인'],image:'',
  time:input.captureTime,observations:1,captureOrder:input.captureOrder,countReliable:true,nameEvidence:[evidence],
  capturePosition:{frame:input.frame,slot:input.slot,stable:true,sort:null}};
}

test('explicit legacy hypothesis reproduces an old checkpoint without changing current replay or verification',async()=>{
 const trace=new RunStateTrace();let time=0;
 trace.record('inventory-seed',{version:1,cards:[]},time++);
 const live=new InventoryEvidence([],{onEvent:event=>trace.record('inventory-event',inventoryEventData(event),time++)});
 const legacy=new InventoryEvidence([],{legacyRepeatCandidate:true});
 for(const [order,engine,raw] of [[10,'paddle','발탄'],[20,'tesseract','발단']] as const){
  const s=source(order),value=card(s,engine,raw);
  live.acceptIdentity(s,value.id);legacy.acceptIdentity(s,value.id);
  live.recordObservation(s,value,.9);legacy.recordObservation(s,value,.9);
 }
 assert.ok(live.cards.get('short')!.review.includes('이름 확인'));
 assert.equal(live.cards.get('short')!.nameConfirmedBy,undefined);
 assert.equal(legacy.cards.get('short')!.nameConfirmedBy,'repeat');
 const oldHash=await hashInventoryEvidence(legacy.snapshot()),currentHash=await hashInventoryEvidence(live.snapshot());
 assert.notEqual(oldHash,currentHash);
 trace.record('inventory-checkpoint',{complete:true,hash:oldHash},time++);
 const blob=await trace.snapshotBlob(),signal=new AbortController().signal;
 const current=await replayRunStateTrace(blob,signal),candidate=await compareLegacyInventoryCandidate(blob,signal);
 assert.equal(current.inventory.hash,currentHash);assert.equal(current.inventory.matchesCapturedState,false);
 assert.equal(candidate.hash,oldHash);assert.equal(candidate.matchesCandidateCheckpoint,true);
 assert.equal(candidate.policyAuthenticated,false);assert.equal(candidate.scope,'inventory-state-hypothesis-only');

 const dir=await mkdtemp(join(tmpdir(),'loa-legacy-policy-'));
 try {
  const file=join(dir,'trace.json'),execution=JSON.parse(await blob.text());
  await writeFile(file,JSON.stringify({execution,executionExpected:{inventoryHash:oldHash}}));
  let output='';
  assert.equal(await runCorpusCli(['replay-state',file],value=>{output=value;}),2);
  assert.equal(Object.hasOwn(JSON.parse(output),'legacyInventoryCandidate'),false);
  assert.equal(await runCorpusCli(['replay-state',file,'--inventory-policy','legacy-repeat-candidate'],value=>{output=value;}),2);
  let report=JSON.parse(output);
  assert.equal(report.matchesCapturedState,false);assert.equal(report.legacyInventoryCandidate.matchesDeclaredHash,true);
  assert.equal(report.legacyInventoryCandidate.policyAuthenticated,false);
  await writeFile(file,JSON.stringify({execution,executionExpected:{inventoryHash:currentHash}}));
  // A matching outer report hash cannot conceal the conflicting checkpoint
  // inside the same trace, even when the optional hypothesis is requested.
  assert.equal(await runCorpusCli(['replay-state',file,'--inventory-policy','legacy-repeat-candidate'],value=>{output=value;}),2);
  report=JSON.parse(output);
  assert.equal(report.matchesCapturedState,false);assert.equal(report.legacyInventoryCandidate.matchesDeclaredHash,false);
  assert.equal(report.componentChecks.inventory.status,'checkpoint-mismatch');
  await assert.rejects(runCorpusCli(['replay-state',file,'--inventory-policy','auto'],()=>{}),/Unknown inventory/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('legacy comparison refuses explicit newer seed policies and incomplete traces',async()=>{
 const signal=new AbortController().signal,trace=new RunStateTrace();
 trace.record('inventory-seed',{version:4,seedPolicy:'prior-run-v3',cards:[]},0);
 await assert.rejects(compareLegacyInventoryCandidate(await trace.snapshotBlob(),signal),/v1/);
 const incomplete=new Blob([JSON.stringify({version:1,complete:false,dropped:1,events:[]})]);
 await assert.rejects(compareLegacyInventoryCandidate(incomplete,signal),/불완전/);
});
