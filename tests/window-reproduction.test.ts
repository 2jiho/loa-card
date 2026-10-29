import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createReproductionBundle,openReproduction,beginReproduction,createReproductionSessionAccess,replaySettings} from '../src/features/card-scanner/scan-reproduction';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';
import {entryParts,fastCompress,packPixels,pixelHash,exactPixels,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import {RGBA_WINDOW_CODEC,RGBA_WINDOW_POLICY} from '../src/features/card-scanner/rgba-window-policy';
import type {ExactRecordingStats} from '../src/features/card-scanner/exact-recording';
import type {ReproductionFile} from '../src/features/card-scanner/scan-reproduction';

const signal=()=>new AbortController().signal,environment={browser:'test',catalog:'test',build:'test'};
async function fixture(){
  const first=Uint8Array.from({length:64},(_,i)=>(i*41)&255),second=first.slice();second[19]^=41;
  const frames=[];
  for(const [index,pixels]of [first,second].entries())frames.push(new Blob(entryParts({kind:'frame',id:index+1,time:2-index,
    width:4,height:4,key:index===0,hash:await pixelHash(pixels),canonical:true,codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY,xor:true,
    phase:index?'recovery':'input'},fastCompress(packPixels(pixels,index?first:undefined,true)))));
  const exact=new Blob(frames),stats:ExactRecordingStats={frames:2,events:0,dropped:0,bytes:exact.size,peakQueuedBytes:0,
    peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:'',canonical:true,codec:RGBA_WINDOW_CODEC,policy:RGBA_WINDOW_POLICY};
  const file:ReproductionFile={video:new Blob(),exact,metadata:{version:6,createdAt:new Date().toISOString(),...environment,completed:true,
    warnings:[],exact:stats,duration:2,type:'',bytes:0,seed:[],result:null,recordState:'complete'}};
  return {first,second,frames,stats,file};
}

test('v6 exact policy survives bundle export/import and separate pixel verification',async()=>{
  const {first,second,file}=await fixture(),opened=await openReproduction(createReproductionBundle(file),signal());
  assert.equal(opened.metadata.version,6);assert.equal(opened.metadata.exact?.codec,RGBA_WINDOW_CODEC);
  assert.equal(opened.metadata.exact?.policy,RGBA_WINDOW_POLICY);assert.equal(opened.metadata.exact?.storageVersion,undefined);
  const decoded=[];for await(const frame of exactPixels(opened.exact!,signal(),0,RGBA_WINDOW_POLICY))decoded.push({id:frame.id,time:frame.time,pixels:frame.pixels.slice()});
  assert.deepEqual(decoded,[{id:1,time:2,pixels:first},{id:2,time:1,pixels:second}]);
  const summary=await executionSummary(opened.exact!,signal(),opened.metadata.exact);
  assert.equal(summary.recordingComplete,true);
});

test('v6 outer tags are mandatory, cannot be downgraded, and cannot name native storage',async()=>{
  const {file}=await fixture();
  for(const exact of [{...file.metadata.exact!,codec:undefined},{...file.metadata.exact!,policy:undefined},
    {...file.metadata.exact!,codec:'lz4'},{...file.metadata.exact!,policy:'other'},
    {...file.metadata.exact!,storageVersion:1,nativeFrames:0,rgbaFrames:2}])
    assert.throws(()=>createReproductionBundle({...file,metadata:{...file.metadata,exact:exact as never}}),/정보|형식|정책/);
  for(const version of [1,2,3,4,5])assert.throws(()=>createReproductionBundle({...file,metadata:{...file.metadata,version:version as never}}),/정보|형식|정책/);
});

test('crash recovery preserves v6 prefix policy without claiming complete source input',async()=>{
  const {frames,first}=await fixture(),past=Date.now()-300000;
  const store=createReproductionSessionStore({dbName:'window-crash-test',ownerId:'expired',now:()=>past});
  await store.beginSession({id:'window-crash',createdAt:new Date(past).toISOString(),record:true,environment,initial:{seed:[]}});
  await store.appendChunk('window-crash','exact',0,new Blob([frames[0],frames[1].slice(0,-1)]));
  const file=(await createReproductionSessionAccess(store).load('window-crash',signal()))!;
  assert.equal(file.metadata.version,6);assert.equal(file.metadata.recordState,'partial');assert.equal(replaySettings(file).truncated,true);
  assert.equal(file.metadata.exact?.codec,RGBA_WINDOW_CODEC);assert.equal(file.metadata.exact?.policy,RGBA_WINDOW_POLICY);
  assert.equal(file.metadata.exact?.complete,false);assert.equal(file.metadata.exact?.dropped,null);assert.equal(file.exact?.size,frames[0].size);
  const opened=await openReproduction(createReproductionBundle(file),signal());
  const decoded=[];for await(const frame of exactPixels(opened.exact!,signal(),0,RGBA_WINDOW_POLICY))decoded.push(frame.pixels.slice());assert.deepEqual(decoded,[first]);
  assert.equal((await executionSummary(opened.exact!,signal(),opened.metadata.exact)).recordingComplete,false);
});

test('normal session sealing chooses v6 only for an explicitly tagged producer',async()=>{
  const {file,stats}=await fixture(),store=createReproductionSessionStore({dbName:'window-seal-test'});let disposed=0;
  const exact={async finish(){return{blob:file.exact!,stats};},async dispose(){disposed++;}};
  const session=beginReproduction([],environment,{record:true,store,exact:exact as never}),saved=(await session.finish(undefined,true))!;
  assert.equal(disposed,1);assert.equal(saved.metadata.version,6);assert.equal(saved.metadata.exact?.codec,RGBA_WINDOW_CODEC);
  assert.equal(saved.metadata.exact?.policy,RGBA_WINDOW_POLICY);assert.equal(saved.metadata.recordState,'complete');assert.equal(session.journalStats().complete,true);
});

test('outer structure import does not itself certify inner policy or pixel integrity',async()=>{
  const {file}=await fixture(),legacyLabeled={...file,metadata:{...file.metadata,version:4 as const,exact:{...file.metadata.exact!}}};
  delete legacyLabeled.metadata.exact.codec;delete legacyLabeled.metadata.exact.policy;
  const opened=await openReproduction(createReproductionBundle(legacyLabeled),signal());assert.equal(opened.metadata.version,4);
  await assert.rejects(executionSummary(opened.exact!,signal(),opened.metadata.exact),/정책|형식|codec|policy|일치/i);
});

test('recovery cannot downgrade a known v6 policy or silently upgrade known legacy metadata',async()=>{
  const {file,first,frames}=await fixture(),legacy=new Blob(entryParts({kind:'frame',id:1,time:2,width:4,height:4,key:true,
    hash:await pixelHash(first),canonical:true,codec:'lz4',xor:true},fastCompress(packPixels(first,undefined,true))));
  for(const direction of ['downgrade','upgrade']){
    const raw=direction==='downgrade'?legacy:frames[0],store=createReproductionSessionStore({dbName:`window-recovery-${direction}`});
    const metadata=structuredClone(file.metadata);metadata.exact!.bytes=raw.size+1;
    if(direction==='upgrade'){metadata.version=4;delete metadata.exact!.codec;delete metadata.exact!.policy;}
    await store.beginSession({id:direction,createdAt:new Date().toISOString(),record:true,environment,initial:{seed:[]}});
    await store.appendChunk(direction,'exact',0,raw);await store.sealSession(direction,{status:'partial',metadata});
    await assert.rejects(createReproductionSessionAccess(store).load(direction,signal()),/정책.*형식/);
  }
});
