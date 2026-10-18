import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {beginReproduction,loadReproduction,clearReproduction,createReproductionBundle,openReproduction,replaySettings,compareReproduction} from '../src/features/card-scanner/scan-reproduction';
import type {ReproductionFile} from '../src/features/card-scanner/scan-reproduction';
const file=():ReproductionFile=>({video:new Blob(['webm-content'],{type:'video/webm;codecs=vp8'}),metadata:{
  version:1,createdAt:'2026-10-17T00:00:00Z',browser:'test',catalog:'test',build:'test',completed:true,warnings:[],
  duration:2,type:'video/webm;codecs=vp8',bytes:12,seed:[],result:{expected:1,read:1,unidentified:0,experience:null,cards:[{id:'1',name:'카드',awakening:1,extraCopies:2,review:[]}]},
}});
test('single file keeps source bytes, starting settings and original results without full-video reads',async()=>{
 const value=file();value.video.arrayBuffer=()=>{throw Error('must not read full video');};
 const bundle=createReproductionBundle(value),loaded=await openReproduction(bundle,new AbortController().signal);
 assert.equal(await loaded.video.text(),'webm-content');assert.deepEqual(loaded.metadata,value.metadata);
 assert.equal(replaySettings(loaded).source,'screen');assert.equal(replaySettings(loaded).frames.length,0);
});
test('corrupt headers, sizes, settings and appended data are rejected',async()=>{
 const bundle=createReproductionBundle(file());
 await assert.rejects(openReproduction(bundle.slice(0,-1),new AbortController().signal),/잘렸/);
 await assert.rejects(openReproduction(new Blob([bundle,'extra']),new AbortController().signal),/데이터/);
 await assert.rejects(openReproduction(new Blob(['LOACARD-REPLAY1\n']),new AbortController().signal),/잘렸/);
 const invalid=file();invalid.metadata.duration=-1;assert.throws(()=>createReproductionBundle(invalid),/정보/);
 const seed=file();seed.metadata.seed=[{name:'wrong'} as never];assert.throws(()=>createReproductionBundle(seed),/목록/);
 const bad=file();bad.metadata.result!.cards[0].extraCopies=999;assert.throws(()=>createReproductionBundle(bad),/비교 결과/);
});
test('cancelled import never begins replay',async()=>{
 const abort=new AbortController();abort.abort();await assert.rejects(openReproduction(createReproductionBundle(file()),abort.signal),{name:'AbortError'});
});
test('comparison distinguishes null from zero and tracks missing and changed fields',()=>{
 const before=file().metadata.result!;
 const after={...before,cards:[{...before.cards[0],extraCopies:null},{id:'2',name:'추가',awakening:0,extraCopies:0,review:[]}]};
 assert.deepEqual(compareReproduction(before,after),{added:['추가'],missing:[],changed:['카드']});
 assert.deepEqual(compareReproduction(after,{...before,cards:[]}),{added:[],missing:['카드','추가'],changed:[]});
});
test('only latest run survives, retained file is independent of cleanup and deletion blocks late writes',async()=>{
 await clearReproduction();let disposed=0;
 const env={browser:'test',catalog:'test',build:'test'};
 const first=await beginReproduction([],env),second=await beginReproduction([],env);
 first.options.continuous!({blob:file().video,duration:2,dispose:async()=>{disposed++;}});
 second.options.continuous!({blob:new Blob(['latest'],{type:'video/webm'}),duration:3,dispose:async()=>{disposed++;}});
 await second.finish(undefined,true);await first.finish(undefined,false);
 assert.equal(await (await loadReproduction())!.video.text(),'latest');assert.equal(disposed,2);
 const third=await beginReproduction([],env);third.options.continuous!({blob:file().video,duration:2});
 await clearReproduction();await third.finish(undefined,true);assert.equal(await loadReproduction(),undefined);
});
test('recording failures do not replace old files with fake completed data',async()=>{
 const capture=await beginReproduction([],{browser:'test',catalog:'test',build:'test'});
 await assert.rejects(capture.finish(undefined,false),/영상이 없습니다/);assert.equal(await loadReproduction(),undefined);
});

test('real JPEG thumbnails in starting inventory survive export and import',async()=>{
 const value=file();value.metadata.seed=[{id:'1',name:'카드',image:'data:image/jpeg;base64,AAAA',awakening:0,extraCopies:15,review:[],confidence:1,observations:1,time:0} as never];
 const loaded=await openReproduction(createReproductionBundle(value),new AbortController().signal);
 assert.equal(loaded.metadata.seed[0].image,value.metadata.seed[0].image);
});

test('v2 lossless payload survives export/import independently of preview video',async()=>{
 const value=file();value.metadata.version=2;value.exact=new Blob(['lossless']);value.metadata.signature='test-hash';value.metadata.exact={frames:2,events:3,dropped:0,bytes:8,peakQueuedBytes:4,peakWorkingBytes:8,readbackMs:1,encodeMs:2,complete:true,error:''};
 value.exact.arrayBuffer=()=>{throw Error('whole archive must not be read');};
 const loaded=await openReproduction(createReproductionBundle(value),new AbortController().signal);
 assert.equal(await loaded.exact!.text(),'lossless');assert.equal(await loaded.video.text(),'webm-content');assert.deepEqual(loaded.metadata,value.metadata);
 value.metadata.exact.bytes++;assert.throws(()=>createReproductionBundle(value),/용량/);
});
