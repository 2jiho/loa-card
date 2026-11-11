import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createRecognitionCropJournal,replayRecognitionCropJournal,cropJournalHash,cropJournalChain} from '../dev/recognition-crop-journal';
import {createCropIndexedDbSink,loadCropIndexedDbRun,deleteCropIndexedDbRun} from '../dev/recognition-crop-indexeddb';
import {exportCropArchive,openCropArchive,restoreCropArchive} from '../dev/crop-archive';
import type {RecognitionInputMeta,RecognitionInputOutcome} from '../src/features/card-scanner/recognition/recognition-input-observer';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCropArchiveCli} from '../scripts/crop-archive';

const seed={version:2 as const,captureBoundary:'recognition-input-v2' as const,sessionId:null,build:'test',catalog:'test',
 nameConfiguration:{version:1,rawResultPolicy:'resample'},modelSignature:null,recognitionOptions:{fractionalPortrait:false,grayNameFallback:false}};
const meta=(id:number):RecognitionInputMeta=>({diagnosticReadId:id,processingFrame:id,slot:0,
 source:{sessionId:'session',frameId:id,observationId:`o${id}`,captureOrder:id,captureTime:id/10,phase:'input',slot:0},
 group:id,trace:id,pixelKey:`pixel${id}`,stage:'short',stable:true,borderAlignment:1,
 sourceBox:{x:1,y:1,width:1,height:1},sourceWidth:10,sourceHeight:10,cropWidth:1,cropHeight:1});
const canvas=(value:number)=>({width:1,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([value,2,3,255])})})}) as unknown as HTMLCanvasElement;
const outcome={admitted:true,identifyExecuted:true,timedOut:false,error:null,status:'read'} as RecognitionInputOutcome;
test('v2 크롭 파일의 순서와 공유 데이터를 검증한 뒤 새 기록으로 복원한다',async()=>{
 const originalId=`a-${crypto.randomUUID()}`,copyId=`b-${crypto.randomUUID()}`,legacyId=`c-${crypto.randomUUID()}`;
 const sink=await createCropIndexedDbSink(originalId),journal=createRecognitionCropJournal(seed,sink);
 for(const [id,value] of [[1,8],[2,8],[3,9]]){const reading=journal.observer.begin(meta(id))!;reading.captureInput!(canvas(value));reading.finish(outcome);}
 const checkpoint=await journal.finish();assert.equal(checkpoint.complete,true);sink.close();
 const original=await loadCropIndexedDbRun(originalId);const chunks:Uint8Array[]=[];let aborted=false,closed=false;
 try{
  const writer={write:async(value:Uint8Array)=>{chunks.push(value.slice());},close:async()=>{closed=true;},abort:async()=>{aborted=true;}};
  const result=await exportCropArchive(original,writer,new AbortController().signal);
  assert.equal(closed,true);assert.equal(aborted,false);assert.equal(result.crops,3);assert.equal(result.unique,2);assert.equal(result.shared,1);
  const blob=new Blob(chunks.map(bytes=>Uint8Array.from(bytes))),archive=await openCropArchive(blob,new AbortController().signal);
  assert.equal(archive.seed.captureBoundary,'recognition-input-v2');assert.equal(archive.proof.complete,true);
  const replacement=await createCropIndexedDbSink(copyId);
  const restored=await restoreCropArchive(archive,replacement,new AbortController().signal);replacement.close();
  assert.equal(restored.complete,true);const copy=await loadCropIndexedDbRun(copyId);
  try{assert.deepEqual(copy.seed,original.seed);assert.deepEqual(copy.events,original.events);assert.deepEqual(copy.checkpoint,original.checkpoint);
   const seen:number[]=[];const proof=await replayRecognitionCropJournal(copy.seed,copy.events,copy.checkpoint,copy.read,(_e,_m,pixels)=>{seen.push(pixels[0]);},new AbortController().signal);
   assert.equal(proof.complete,true);assert.deepEqual(seen,[8,8,9]);
  }finally{copy.close();}
  const raw=new Uint8Array(await blob.arrayBuffer());raw[20]^=1;
  await assert.rejects(openCropArchive(new Blob([raw]),new AbortController().signal),/metadata hash/);
  await assert.rejects(openCropArchive(blob.slice(0,blob.size-1),new AbortController().signal),/truncated|trailing/);
  const damaged=new Uint8Array(await blob.arrayBuffer());damaged[damaged.length-9]^=1;
  await assert.rejects(openCropArchive(new Blob([damaged]),new AbortController().signal),/integrity/);
  // Earlier v1 stored crop event `seq` last; property order is part of the hash chain.
  const {captureBoundary:_boundary,...otherSeed}=original.seed;
  const v1Seed={...otherSeed,version:1 as const};
  const legacyEvents=original.events.map(event=>{if(event.kind!=='crop')return event;
   const {seq,...rest}=event;return {...rest,seq};});
  let chain=await cropJournalHash(new TextEncoder().encode(JSON.stringify(v1Seed)));
  for(const event of legacyEvents)chain=await cropJournalChain(chain,event);
  const {skipped:_skipped,...checkpointWithoutSkipped}=original.checkpoint!;
  const legacyCheckpoint={...checkpointWithoutSkipped,chain};
  const legacyChunks:Uint8Array[]=[];
  await exportCropArchive({seed:v1Seed,events:legacyEvents,checkpoint:legacyCheckpoint,read:original.read},
   {write:async(value)=>{legacyChunks.push(value.slice());},close:async()=>{},abort:async()=>{}},new AbortController().signal);
  const legacy=await openCropArchive(new Blob(legacyChunks.map(bytes=>Uint8Array.from(bytes))),new AbortController().signal);
  const legacySink=await createCropIndexedDbSink(legacyId);await restoreCropArchive(legacy,legacySink,new AbortController().signal);legacySink.close();
  const restoredLegacy=await loadCropIndexedDbRun(legacyId);
  try{assert.equal(JSON.stringify(restoredLegacy.events),JSON.stringify(legacyEvents));assert.equal(restoredLegacy.checkpoint?.chain,chain);
   assert.equal((await replayRecognitionCropJournal(restoredLegacy.seed,restoredLegacy.events,restoredLegacy.checkpoint,restoredLegacy.read,()=>{},new AbortController().signal)).complete,true);
  }finally{restoredLegacy.close();}
  const temporary=await mkdtemp(join(tmpdir(),'loa-crop-archive-test-'));
  try{
   const path=join(temporary,'input.loacrops'),root=join(temporary,'corpus');await writeFile(path,new Uint8Array(await blob.arrayBuffer()));
   const registered=await runCropArchiveCli(['add',path],root),again=await runCropArchiveCli(['add',path],root);
   assert.equal(registered.added,true);assert.equal(again.added,false);assert.equal(registered.sha256,again.sha256);
   assert.equal(registered.bytes,blob.size);assert.deepEqual(await readFile(registered.path),await readFile(path));
   const checked=await runCropArchiveCli(['verify',registered.path]);assert.equal(checked.sha256,registered.sha256);assert.equal(checked.complete,true);
   await writeFile(path,damaged);await assert.rejects(runCropArchiveCli(['add',path],root),/integrity/);
   assert.deepEqual(await readFile(registered.path),await readFile(join(root,`${registered.sha256}.loacrops`)));
  }finally{await rm(temporary,{recursive:true,force:true});}
 }finally{original.close();await deleteCropIndexedDbRun(originalId);await deleteCropIndexedDbRun(copyId);await deleteCropIndexedDbRun(legacyId);}
});
