import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createReproductionBundle,openReproduction,beginReproduction,createReproductionSessionAccess} from '../src/features/card-scanner/scan-reproduction';
import {createReproductionSessionStore} from '../src/features/card-scanner/reproduction-session-store';
import {prepareNativeStorage,rgbaFrameStorage} from '../src/features/card-scanner/native-frame-storage';
import {planNativeYuvFrame,type NativeYuvFrameMetadata} from '../src/features/card-scanner/native-yuv-recipe';
import {entryParts,fastCompress,packPixels,pixelHash,exactPixels,executionSummary} from '../src/features/card-scanner/exact-recording-codec';
import type {ExactRecordingStats} from '../src/features/card-scanner/exact-recording';
import type {ReproductionFile} from '../src/features/card-scanner/scan-reproduction';

const signal=()=>new AbortController().signal;
async function fixture(){
 const descriptor:NativeYuvFrameMetadata={format:'I420',codedWidth:8,codedHeight:8,displayWidth:8,displayHeight:8,
  visibleRect:{x:0,y:0,width:8,height:8},rotation:0,flip:false,
  colorSpace:{primaries:'smpte170m',transfer:'smpte170m',matrix:'smpte170m',fullRange:false}};
 const native=new Uint8Array(planNativeYuvFrame(descriptor).nativeByteLength).fill(110),prepared=await prepareNativeStorage(descriptor,native),
  nativeFrame=new Blob(entryParts({kind:'frame',id:1,time:1,width:8,height:8,key:true,hash:prepared.rgbaHash,
   codec:'lz4',xor:true,canonical:true,storage:prepared.storage},fastCompress(packPixels(native,undefined,true))));
 const rgba=new Uint8Array(8*8*4).fill(75),rgbaFrame=new Blob(entryParts({kind:'frame',id:2,time:2,width:8,height:8,key:true,
  hash:await pixelHash(rgba),codec:'lz4',xor:true,canonical:true,storage:rgbaFrameStorage(8,8)},fastCompress(packPixels(rgba,undefined,true))));
 const exact=new Blob([nativeFrame,rgbaFrame]),stats:ExactRecordingStats={frames:2,events:0,dropped:0,bytes:exact.size,
  peakQueuedBytes:0,peakWorkingBytes:0,readbackMs:0,encodeMs:0,complete:true,error:'',canonical:true,
  storageVersion:1,nativeFrames:1,rgbaFrames:1};
 const file:ReproductionFile={video:new Blob(),exact,metadata:{version:5,createdAt:new Date().toISOString(),browser:'test',catalog:'test',
  build:'test',completed:true,warnings:[],exact:stats,duration:2,type:'',bytes:0,seed:[],result:null,recordState:'complete'}};
 return {file,nativeFrame,rgbaFrame,prepared,rgba,stats};
}

test('v5 mixed native and RGBA physical payload survives export/import with explicit kind totals',async()=>{
 const {file,prepared,rgba}=await fixture(),bundle=createReproductionBundle(file),reopened=await openReproduction(bundle,signal());
 assert.equal(reopened.metadata.version,5);assert.equal(reopened.metadata.exact?.nativeFrames,1);
 const hashes=[];for await(const frame of exactPixels(reopened.exact!,signal()))hashes.push(await pixelHash(frame.pixels));
 assert.deepEqual(hashes,[prepared.rgbaHash,await pixelHash(rgba)]);
 const summary=await executionSummary(reopened.exact!,signal(),reopened.metadata.exact);
 assert.equal(summary.recordingComplete,true);assert.equal(summary.unknownLifecycle.supported,false);
 assert.equal(summary.unknownLifecycle.matchesCapturedState,null,'physical payload support cannot invent lifecycle proof');
});

test('compact stats and outer version cannot be mislabeled as old RGBA or unsupported v6',async()=>{
 const {file}=await fixture();
 for(const version of [1,2,3,4,6]){
  assert.throws(()=>createReproductionBundle({...file,metadata:{...file.metadata,version:version as never}}),/정보|형식/);
 }
 for(const exact of [{...file.metadata.exact!,storageVersion:undefined},{...file.metadata.exact!,nativeFrames:2},
  {...file.metadata.exact!,rgbaFrames:-1},{...file.metadata.exact!,nativeFrames:undefined}])
  assert.throws(()=>createReproductionBundle({...file,metadata:{...file.metadata,exact}}),/형식|프레임|표시/);
});

test('crash-prefix recovery preserves compact format and retained kind counts without forging full input',async()=>{
 const {nativeFrame,rgbaFrame,prepared}=await fixture(),past=Date.now()-300_000,
  store=createReproductionSessionStore({dbName:'compact-crash-test',ownerId:'expired',now:()=>past});
 await store.beginSession({id:'compact-crash',createdAt:new Date(past).toISOString(),record:true,
  environment:{browser:'test',catalog:'test',build:'test'},initial:{seed:[]}});
 await store.appendChunk('compact-crash','exact',0,new Blob([nativeFrame,rgbaFrame.slice(0,-1)]));
 const file=(await createReproductionSessionAccess(store).load('compact-crash',signal()))!;
 assert.ok(file);assert.equal(file.metadata.version,5);assert.equal(file.metadata.recordState,'partial');
 assert.equal(file.metadata.exact?.storageVersion,1);assert.equal(file.metadata.exact?.nativeFrames,1);
 assert.equal(file.metadata.exact?.rgbaFrames,0);assert.equal(file.metadata.exact?.complete,false);
 assert.equal(file.metadata.exact?.dropped,null);assert.equal(file.exact?.size,nativeFrame.size);
 const reopened=await openReproduction(createReproductionBundle(file),signal());
 for await(const frame of exactPixels(reopened.exact!,signal()))assert.equal(frame.hash,prepared.rgbaHash);
 assert.equal((await executionSummary(reopened.exact!,signal(),reopened.metadata.exact)).recordingComplete,false);
});

test('ordinary session sealing chooses v5 only for an explicitly compact producer',async()=>{
 const {file,stats}=await fixture();let disposed=0;
 const store=createReproductionSessionStore({dbName:'compact-seal-test'}),exact={
  async finish(){return {blob:file.exact!,stats};},async dispose(){disposed++;}};
 const session=beginReproduction([],{browser:'test',catalog:'test',build:'test'},{record:true,store,exact:exact as never});
 const sealed=(await session.finish(undefined,true))!;
 assert.equal(disposed,1);assert.equal(sealed.metadata.version,5);assert.equal(sealed.metadata.exact?.storageVersion,1);
 assert.equal(sealed.metadata.exact?.nativeFrames,1);assert.equal(sealed.metadata.recordState,'complete');
  assert.equal(session.journalStats().complete,true);assert.equal(session.journalStats().error,'');
});
