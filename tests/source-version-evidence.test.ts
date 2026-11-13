import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSourceVersionEvidence,resolveSourceVersionEvidence,trackSourceVersion} from '../src/features/card-scanner/session/source-version-evidence';
import {createReproductionBundle,openReproduction} from '../src/features/card-scanner/reproduction/scan-reproduction';
import 'fake-indexeddb/auto';

const a='a'.repeat(64), b='b'.repeat(64);
const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
test('completed boundary snapshots and a hot update are kept distinct',async()=>{
  let invalidated=()=>{},unsubscribed=false,calls=0;
  const tracker=trackSourceVersion(async()=>({sourceDigest:++calls===1?a:b}),fn=>{invalidated=fn;return()=>{unsubscribed=true;};});
  await turn();tracker.scannerStarted();
  const result=await tracker.finish();
  assert.deepEqual(result,{version:2,startDigest:a,endDigest:b,startBeforeScanner:true,
    hotUpdateBeforeScanner:false,hotUpdateDuringScanner:false,hotUpdateAfterScanner:false,changed:true});
  assert.equal(unsubscribed,true);
  calls=0;
  const update=trackSourceVersion(async()=>({sourceDigest:a}),fn=>{invalidated=fn;return()=>{};});
  await turn();update.scannerStarted();invalidated();
  assert.equal((await update.finish()).changed,true);
});
test('late or failed initial snapshot remains unknown even if ending digest matches',async()=>{
  let resolve!:(value:unknown)=>void,calls=0;
  const pending=new Promise<unknown>(done=>{resolve=done;});
  const tracker=trackSourceVersion(()=>++calls===1?pending:Promise.resolve({sourceDigest:a}),()=>()=>{});
  tracker.scannerStarted();resolve({sourceDigest:a});
  assert.deepEqual(await tracker.finish(),{version:2,startDigest:a,endDigest:a,startBeforeScanner:false,
    hotUpdateBeforeScanner:false,hotUpdateDuringScanner:false,hotUpdateAfterScanner:false,changed:null});
  const failure=trackSourceVersion(async()=>{throw Error('offline');},()=>()=>{});
  await turn();failure.scannerStarted();assert.equal((await failure.finish()).changed,null);
});
test('pending snapshots time out, unsubscribe, and never block scanner start',async()=>{
  let invalidate=()=>{},unsubscribed=false;
  const tracker=trackSourceVersion(()=>new Promise(()=>{}),fn=>{invalidate=fn;return()=>{unsubscribed=true;};},10);
  tracker.scannerStarted();invalidate();
  const result=await tracker.finish();
  assert.equal(result.version,2);
  if(result.version!==2)throw Error('wrong format');
  assert.equal(result.startBeforeScanner,false);assert.equal(result.hotUpdateDuringScanner,true);
  assert.equal(result.changed,true);assert.equal(unsubscribed,true);
  assert.equal((await resolveSourceVersionEvidence(()=>new Promise(()=>{}),10)).changed,null);
});
test('HMR before, during and after a scan are reported separately',async()=>{
  let invalidate=()=>{};
  const previous=trackSourceVersion(async()=>({sourceDigest:a}),fn=>{invalidate=fn;return()=>{};});
  await turn();invalidate();previous.scannerStarted();
  const before=await previous.finish();
  assert.equal(before.version,2);if(before.version!==2)throw Error('wrong format');
  assert.equal(before.hotUpdateBeforeScanner,true);assert.equal(before.changed,null);
  const current=trackSourceVersion(()=>new Promise(()=>{}),fn=>{invalidate=fn;return()=>{};},10);
  current.scannerStarted();invalidate();
  const during=await current.finish();
  assert.equal(during.version,2);if(during.version!==2)throw Error('wrong format');
  assert.equal(during.hotUpdateDuringScanner,true);assert.equal(during.startBeforeScanner,false);assert.equal(during.changed,true);
  const next=trackSourceVersion(async()=>({sourceDigest:a}),fn=>{invalidate=fn;return()=>{};});
  await turn();next.scannerStarted();next.scannerStopped();invalidate();
  const after=await next.finish();
  assert.equal(after.version,2);if(after.version!==2)throw Error('wrong format');
  assert.equal(after.hotUpdateDuringScanner,false);assert.equal(after.hotUpdateAfterScanner,true);assert.equal(after.changed,true);
});
test('source evidence survives the replay bundle and contradictory claims are rejected',async()=>{
  const evidence={version:1 as const,startDigest:a,endDigest:a,startBeforeScanner:true,hotUpdate:false,changed:false};
  const video=new Blob(['x'],{type:'video/webm'});
  const file={video,metadata:{version:3 as const,createdAt:'2026-10-30',browser:'test',catalog:'test',build:'test',completed:true,
    warnings:[],duration:1,type:video.type,bytes:video.size,seed:[],result:null,sourceVersion:evidence}};
  const loaded=await openReproduction(createReproductionBundle(file),AbortSignal.timeout(1000));
  assert.deepEqual(loaded.metadata.sourceVersion,evidence);
  assert.throws(()=>parseSourceVersionEvidence({...evidence,endDigest:b,changed:false}));
  assert.throws(()=>createReproductionBundle({...file,metadata:{...file.metadata,sourceVersion:{...evidence,changed:null}}}));
});