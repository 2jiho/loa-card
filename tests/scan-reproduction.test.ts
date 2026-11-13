import {test} from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import {createReproductionBundle,openReproduction} from '../src/features/card-scanner/reproduction/scan-reproduction';
import type {ReproductionFile} from '../src/features/card-scanner/reproduction/scan-reproduction';
const file=():ReproductionFile=>({video:new Blob(['webm-content'],{type:'video/webm;codecs=vp8'}),metadata:{
  version:1,createdAt:'2026-10-17T00:00:00Z',browser:'test',catalog:'test',build:'test',completed:true,warnings:[],
  duration:2,type:'video/webm;codecs=vp8',bytes:12,seed:[],result:{expected:1,read:1,unidentified:0,experience:null,cards:[{id:'1',name:'카드',awakening:1,extraCopies:2,review:[]}]},
}});

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

test('canonical source-use bundles require v4 so older readers cannot silently replay backup frames as acquisitions',async()=>{
 const value=file();value.metadata.version=4;value.exact=new Blob(['canonical']);
 value.metadata.exact={frames:1,events:1,dropped:0,bytes:value.exact.size,peakQueuedBytes:0,peakWorkingBytes:0,
  readbackMs:0,encodeMs:0,complete:true,error:'',canonical:true};
 const loaded=await openReproduction(createReproductionBundle(value),new AbortController().signal);
 assert.equal(loaded.metadata.version,4);assert.equal(loaded.metadata.exact?.canonical,true);
 value.metadata.version=3;assert.throws(()=>createReproductionBundle(value),/무손실/);
 value.metadata.version=4;delete value.metadata.exact.canonical;assert.throws(()=>createReproductionBundle(value),/공통 원본/);
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
