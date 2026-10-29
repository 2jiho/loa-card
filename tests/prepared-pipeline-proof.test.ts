import test from 'node:test';
import assert from 'node:assert/strict';
import {PIPELINE_PROOF_FRAMES,PIPELINE_PROOF_MAX_PREFIX_FRAMES,pipelineProofStartTime,selectPipelineWarmup,acquisitionShape,comparePipelineRows,type PipelineProofRow} from '../dev/prepared-pipeline-proof-core';

function rows():PipelineProofRow[]{return Array.from({length:PIPELINE_PROOF_FRAMES+1},(_,ordinal)=>({ordinal,sourceFrameId:ordinal+1,
 acquisitionFrameId:ordinal+1,time:ordinal/60,width:2,height:2,hash:'a'.repeat(64),storageKind:'native',nativeSha256:'b'.repeat(64),
 descriptorJson:'native-recipe-v1',acquisition:{layout:null,cells:[],detected:0,usable:0,intact:0}}));}
test('finite pair proof compares complete rasters and native profiles, not only frame counts',()=>{
 const serial=rows(),prefetch=rows();assert.equal(comparePipelineRows(serial,prefetch).measuredFrames,30);
 // Different actual client ID domains are independently validated, not equated.
 prefetch.forEach((row,index)=>{prefetch[index]={...row,sourceFrameId:row.sourceFrameId+100,acquisitionFrameId:row.acquisitionFrameId+200};});
 assert.equal(comparePipelineRows(serial,prefetch).fullRasterHashesEqual,true);
 for(const change of [{time:1},{hash:'c'.repeat(64)},{nativeSha256:'c'.repeat(64)},{descriptorJson:'another-profile'},
  {width:3},{acquisition:{layout:null,cells:[],detected:1,usable:0,intact:0}}]){
  const bad=rows();bad[2]={...bad[2],...change};assert.throws(()=>comparePipelineRows(serial,bad));
 }
});

test('actual consumer crop hashes compare every slot and cannot hide behind full source raster equality',()=>{
 const sampled=()=>rows().map(row=>({...row,acquisition:{...row.acquisition,cells:[{slot:0,content:{x:0,y:0,width:140,height:210},preview:{x:0,y:0,width:140,height:210},
  alignment:1,intact:true,borderSides:[1,1,1,1],labelVisible:true,quality:{} as any,width:140,height:210}]},
  cardPixelHashes:[{slot:0,width:140,height:210,hash:'a'.repeat(64)}]}));
 const left=sampled(),right=sampled();assert.equal(comparePipelineRows(left,right).consumerCardPixelHashesEqual,true);
 right[3].cardPixelHashes[0].hash='b'.repeat(64);assert.throws(()=>comparePipelineRows(left,right),/consumer card pixels mismatch/);
 const incomplete=sampled();incomplete[3].cardPixelHashes=[];assert.throws(()=>comparePipelineRows(left,incomplete),/incomplete card pixel hashes/);
 const misbound=sampled();misbound[3].cardPixelHashes[0].slot=1;assert.throws(()=>comparePipelineRows(left,misbound),/pixel hash binding/);
 assert.throws(()=>comparePipelineRows(left,rows()),/layout\/crop quality mismatch/);
});
test('duplicate use/source IDs, incomplete samples and missing native evidence never prove equivalence',()=>{
 for(const change of [{sourceFrameId:1},{acquisitionFrameId:1},{ordinal:4},{time:NaN},{nativeSha256:null},{descriptorJson:null}]){
  const bad=rows();bad[2]={...bad[2],...change};assert.throws(()=>comparePipelineRows(rows(),bad));
 }
 assert.throws(()=>comparePipelineRows(rows(),rows().slice(1)));
 const raw=rows().map(row=>({...row,storageKind:'rgba' as const,nativeSha256:null,descriptorJson:null}));
 assert.equal(comparePipelineRows(raw,raw).storedNativeBytesAndProfilesEqual,true);
 const wrong=structuredClone(raw);wrong[3].nativeSha256='b'.repeat(64) as never;assert.throws(()=>comparePipelineRows(raw,wrong));
});
test('acquisition comparison keeps geometry and quality while excluding timings, cache IDs and pixel owners',()=>{
 const box={x:0,y:0,width:2,height:2},cell={slot:1,content:box,preview:box,alignment:1,intact:true,borderSides:[1,1,1,1],labelVisible:true,
  quality:{usable:true,reason:'candidate',sharpness:3},image:{width:2,height:2},pixelKey:'process-uuid',vector:new Uint8Array(100)};
 const shape=acquisitionShape({layout:null,cells:[cell] as never});
 assert.equal(shape.detected,1);assert.equal(shape.usable,1);assert.equal(shape.intact,1);assert.equal('pixelKey' in shape.cells[0],false);
 box.x=9;assert.equal(shape.cells[0].content.x,0,'report must detach mutable detector geometry');
 assert.throws(()=>acquisitionShape({layout:null,cells:[{...cell,alignment:NaN}] as never}),/Nonfinite/);
});
test('fixed window selects the actual first original PTS at or after start and reports only discarded prefix samples',async()=>{
 let index=0;const times=[0,.5,1,2.9,3.02,3.04],frames=times.map(time=>({time})),iterator={async next(){return index<frames.length?{done:false as const,value:frames[index++]}:{done:true as const,value:undefined};}};
 const selected=await selectPipelineWarmup(iterator,3,new AbortController().signal);
 assert.equal(selected.frame,frames[4]);assert.equal(index,5,'selection must not consume any timed frame');
 assert.deepEqual(selected.window,{requestedStartTime:3,selection:'first-original-PTS-at-or-after',skippedFrames:4,skippedFirstPts:0,skippedLastPts:2.9,warmupPts:3.02});
 assert.equal((await iterator.next()).value,frames[5]);
 const noSkip=await selectPipelineWarmup({next:async()=>({done:false,value:{time:3}})},0,new AbortController().signal);
 assert.deepEqual(noSkip.window,{requestedStartTime:0,selection:'first-original-PTS-at-or-after',skippedFrames:0,skippedFirstPts:null,skippedLastPts:null,warmupPts:3});
});
test('prefix selection enforces fixed time/count bounds, original order, early end and abort',async()=>{
 for(const time of [-1,NaN,Infinity,10.01])assert.throws(()=>pipelineProofStartTime(time));
 const signal=new AbortController().signal;let calls=0;
 await assert.rejects(selectPipelineWarmup({next:async()=>{calls++;return {done:false,value:{time:0}};}},3,signal),/bound exceeded/);
 assert.equal(calls,PIPELINE_PROOF_MAX_PREFIX_FRAMES+1);
 await assert.rejects(selectPipelineWarmup({next:async()=>({done:true,value:undefined})},3,signal),/ended/);
 const times=[1,.5];await assert.rejects(selectPipelineWarmup({next:async()=>({done:false,value:{time:times.shift()!}})},3,signal),/Invalid prefix/);
 const stopped=new AbortController();stopped.abort();calls=0;
 await assert.rejects(selectPipelineWarmup({next:async()=>{calls++;return {done:false,value:{time:3}};}},3,stopped.signal),{name:'AbortError'});assert.equal(calls,0);
});
