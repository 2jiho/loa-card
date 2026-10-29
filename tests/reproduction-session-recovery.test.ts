import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';
import {clearReproduction,listReproductionSessions,loadReproductionSession,createReproductionBundle,openReproduction,replaySettings,
 beginReproduction,loadSessionDiagnosticSummary} from '../src/features/card-scanner/scan-reproduction';
import {entryParts,packPixels,fastCompress,pixelHash,exactPixels,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import type {ScannedCard} from '../src/features/card-scanner/recognizer';
const signal=()=>new AbortController().signal;
const environment={browser:'test',catalog:'test',build:'test'};

test('an expired interrupted session retains complete input entries and exports without preview or fabricated telemetry',async()=>{
  await clearReproduction();const past=Date.now()-300_000;
  const store=createReproductionSessionStore({ownerId:'terminated-document',now:()=>past});
  await store.beginSession({id:'crash-input',createdAt:new Date(past).toISOString(),environment,record:true,initial:{seed:[]}});
  const pixels=new Uint8Array(16).fill(27),payload=fastCompress(packPixels(pixels,undefined,true));
  const header={kind:'frame' as const,id:1,time:3.5,width:2,height:2,key:true,hash:await pixelHash(pixels),codec:'lz4' as const,xor:true};
  const first=new Blob(entryParts(header,payload)),next=new Blob(entryParts({...header,id:2,time:4},payload));
  await store.appendChunk('crash-input','exact',0,new Blob([first,next.slice(0,-1)]));
  const index=(await listReproductionSessions()).find(item=>item.id==='crash-input')!;
  assert.equal(index.status,'partial');assert.equal(index.hasInput,true);
  const file=(await loadReproductionSession(index.id))!;
  assert.equal(file.video.size,0);assert.equal(file.exact!.size,first.size);
  assert.equal(file.metadata.version,3);assert.equal(file.metadata.exact!.frames,1);
  assert.equal(file.metadata.exact!.dropped,null);assert.equal(file.metadata.exact!.readbackMs,null);
  assert.equal(file.metadata.exact!.complete,false);assert.equal(replaySettings(file).truncated,true);
  const imported=await openReproduction(createReproductionBundle(file),signal());
  assert.deepEqual(imported.metadata,file.metadata);
  const frames=[];for await(const frame of exactPixels(imported.exact!,signal()))frames.push(frame);
  assert.equal(frames.length,1);assert.deepEqual(frames[0].pixels,pixels);
  assert.equal((await executionSummary(imported.exact!,signal(),imported.metadata.exact)).recordingComplete,false);
});

test('session start snapshots starting values without retaining screenshot strings and durable input can exist without video',async()=>{
  await clearReproduction();let disposed=0;
  const seed:ScannedCard={id:'card',name:'카드',awakening:0,extraCopies:null,confidence:1,review:[],
    image:'data:image/png;base64,'+'A'.repeat(500_000),time:0,observations:1};
  const pixels=new Uint8Array(16),exactBlob=new Blob(entryParts({kind:'frame',id:1,time:0,width:2,height:2,key:true,
    hash:await pixelHash(pixels),codec:'lz4',xor:true},fastCompress(packPixels(pixels,undefined,true))));
  const exact={finish:async()=>({blob:exactBlob,stats:{frames:1,events:0,dropped:0,bytes:exactBlob.size,peakQueuedBytes:16,
    peakWorkingBytes:64,readbackMs:1,encodeMs:1,complete:true,error:''}}),dispose:async()=>{disposed++;}};
  const run=beginReproduction([seed],environment,{record:true,exact:exact as never});
  seed.extraCopies=8;
  const file=(await run.finish(undefined,false))!;
  assert.equal(disposed,1);assert.equal(file.video.size,0);assert.equal(file.metadata.seed[0].extraCopies,null);
  assert.ok(file.metadata.seed[0].image.length<300);assert.equal(file.metadata.exact!.dropped,0);
  assert.equal(file.metadata.exact!.complete,false);assert.equal(file.metadata.completed,false);
  assert.equal((await loadSessionDiagnosticSummary(run.id))!.completed,false);
});

test('quota registration failure preserves result counters in its partial index and never evicts a pinned session',async()=>{
  const store=createReproductionSessionStore({dbName:'quota-integration',limits:{maxSessions:1,maxBytes:1024*1024}});
  await store.beginSession({id:'keep',createdAt:new Date().toISOString(),environment,record:false});
  await store.sealSession('keep',{status:'complete'});await store.pinSession('keep',true);
  const run=beginReproduction([],environment,{record:true,store});
  await assert.rejects(run.finish({status:'done',expected:1,currentRunRead:1,unidentified:[],cards:[]} as never,true),/보관 한도/);
  const rows=await store.listSessions();assert.equal(rows.find(row=>row.id==='keep')!.pinned,true);
  const partial=rows.find(row=>row.id===run.id)!;assert.equal(partial.status,'partial');
  assert.equal(partial.read,1);assert.equal(partial.expected,1);assert.equal(partial.hasInput,false);
});

test('a failed optional recorder hook returns a finishable session rather than leaking its active lease',async()=>{
  const store=createReproductionSessionStore({dbName:'hook-failure-integration'});let disposed=0;
  const exact={setJournal(){throw Error('worker already closed');},async dispose(){disposed++;}};
  const run=beginReproduction([],environment,{record:true,store,exact:exact as never});
  assert.equal(run.options.exact,undefined);
  assert.equal(await run.finish(undefined,false),undefined);assert.equal(disposed,1);
  const row=(await store.listSessions())[0];assert.equal(row.id,run.id);assert.equal(row.sealed,true);
  assert.equal(row.status,'failed');assert.match(row.reason!,/worker already closed/);
  const fallback=beginReproduction([],environment,{record:true,store,exact:exact as never});
  fallback.options.continuous!({blob:new Blob(['preview'],{type:'video/webm'}),duration:1});
  const file=(await fallback.finish(undefined,false))!;
  assert.equal(await file.video.text(),'preview');assert.equal(file.metadata.exact,undefined);
  assert.equal((await store.listSessions()).find(item=>item.id===fallback.id)!.status,'partial');
});
