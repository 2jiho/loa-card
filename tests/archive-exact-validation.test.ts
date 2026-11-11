import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateArchiveExact} from '../src/features/card-scanner/reproduction/archive-exact-validation';
import {createCanonicalFinalizationFixture} from './helpers/canonical-finalization-fixture';
import {verifyCanonicalFinalization,CanonicalFinalizationError} from '../src/features/card-scanner/reproduction/canonical-finalization-proof';
import {executionSummary} from '../src/features/card-scanner/reproduction/exact-recording-codec';
import type {ReproductionFile} from '../src/features/card-scanner/reproduction/scan-reproduction';

const signal=()=>AbortSignal.timeout(30_000);
function file(recording:Awaited<ReturnType<typeof createCanonicalFinalizationFixture>>['recording']):ReproductionFile {
 return {video:new Blob(),exact:recording.blob,metadata:{version:4,createdAt:'2026-10-01',browser:'test',catalog:'test',build:'test',
   completed:true,recordState:'complete',warnings:[],duration:1,type:'',bytes:0,seed:[],result:null,exact:recording.stats}};
}

test('validated archive requires linked input checkpoints and actual decoded pixel hashes',async()=>{
 const fixture=await createCanonicalFinalizationFixture();
 assert.equal(await validateArchiveExact(file(fixture.recording),signal()),true);
 const bad=fixture.entries.map((entry,index)=>index===0?{...entry,payload:new Uint8Array([1,2,3])}:entry);
 await assert.rejects(validateArchiveExact(file(fixture.recordingFrom(bad)),signal()));
});

test('legacy v1 matching snapshot hashes cannot authorize release after reconstructed live loss',async()=>{
 for(const historicalUnknownLoss of ['active-limit','name-conflict'] as const){
  const fixture=await createCanonicalFinalizationFixture({historicalUnknownLoss});
  const {blob,stats}=fixture.recording;
  const summary=await executionSummary(blob,signal(),stats);
  assert.equal(summary.recordingComplete,true);
  assert.equal(summary.unknownLifecycle.matchesCapturedState,true,'the historical v1 hash stays unchanged');
  assert.equal(summary.unknownLifecycle.liveEvidenceLost,true);
  assert.equal(await validateArchiveExact(file(fixture.recording),signal()),false);
  await assert.rejects(verifyCanonicalFinalization(fixture.recording,signal()),(error:unknown)=>
   error instanceof CanonicalFinalizationError&&error.reason==='captured-state');
 }
});

test('legacy exact streams without capture/input evidence cannot release browser protection',async()=>{
 const fixture=await createCanonicalFinalizationFixture();
 const entries=fixture.entries.filter(entry=>entry.header.kind!=='event'||entry.header.type!=='canonical-raster-contract');
 let seq=0;const renumbered=entries.map(entry=>entry.header.kind==='event'?{...entry,header:{...entry.header,seq:++seq}}:entry);
 await assert.rejects(validateArchiveExact(file(fixture.recordingFrom(renumbered)),signal()));
 const controller=new AbortController();controller.abort();
 await assert.rejects(validateArchiveExact(file(fixture.recording),controller.signal));
});

test('missing, mismatched or failed obstruction evidence cannot release browser protection',async()=>{
 const fixture=await createCanonicalFinalizationFixture();
 const run=async(entries:typeof fixture.entries)=>{
  let seq=0;const ordered=entries.map(entry=>entry.header.kind==='event'?{...entry,header:{...entry.header,seq:++seq}}:entry);
  try{return await validateArchiveExact(file(fixture.recordingFrom(ordered)),signal());}catch{return false;}
 };
 assert.equal(await validateArchiveExact(file(fixture.recording),signal()),true);
 for(const missing of ['obstruction-seed','obstruction-checkpoint']){
  const entries=fixture.entries.filter(entry=>entry.header.kind!=='event'||entry.header.type!==missing);
  assert.equal(await run(entries),false,`${missing} must not be treated as verified`);
 }
 const mismatch=fixture.entries.map(entry=>entry.header.kind==='event'&&entry.header.type==='obstruction-checkpoint'?
  {...entry,header:{...entry.header,value:{...(entry.header.value as object),hash:'f'.repeat(64)}}}:entry);
 assert.equal(await run(mismatch),false);
 const lost=[...fixture.entries,{header:{kind:'event' as const,seq:0,time:1,type:'obstruction-recording-error',value:{error:'lost'}}}];
 assert.equal(await run(lost),false);
});

test('missing captured-state checkpoints cannot promote recorded pixels to verified',async()=>{
 const fixture=await createCanonicalFinalizationFixture();
 for(const missing of ['inventory-checkpoint','grid-checkpoint','unknown-checkpoint','freshness-checkpoint']){
  const entries=fixture.entries.filter(entry=>entry.header.kind!=='event'||entry.header.type!==missing);
  let seq=0;const ordered=entries.map(entry=>entry.header.kind==='event'?{...entry,header:{...entry.header,seq:++seq}}:entry);
  let verified=false;try{verified=await validateArchiveExact(file(fixture.recordingFrom(ordered)),signal());}catch{/* malformed state also fails closed */}
  assert.equal(verified,false,missing);
 }
});
