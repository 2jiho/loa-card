import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CanonicalRasterReplay} from '../src/features/card-scanner/canonical-raster-replay';
import type {ExactEntry} from '../src/features/card-scanner/exact-recording-codec';
import {entryParts,executionSummary,fastCompress,packPixels} from '../src/features/card-scanner/exact-recording-codec';

const hash='a'.repeat(64),event=(type:string,value:unknown):ExactEntry=>({kind:'event',seq:1,time:0,type,value});
const frame={kind:'frame',id:7,width:8,height:8,time:2,hash,canonical:true,encoding:'raw',bytes:256} as unknown as ExactEntry;
const use={sourceFrameId:7,acquisitionFrameId:31,phase:'input',captureTime:2};
const receipt={version:1,kind:'measured',sourceFrameId:7,captureTime:2,acquisitionFrameId:31,width:8,height:8,hash};
function run(changes:{frame?:Record<string,unknown>;use?:Record<string,unknown>;receipt?:Record<string,unknown>}={}){
 const replay=new CanonicalRasterReplay();replay.accept(event('canonical-raster-contract',{version:1}));
 replay.accept({...frame,...changes.frame} as ExactEntry);replay.accept(event('canonical-source-use',{...use,...changes.use}));
 replay.accept(event('canonical-raster-receipt',{...receipt,...changes.receipt}));return replay;
}
test('measured receipts verify actual acquisition IDs and exact capture chronology including source reuse',()=>{
 const replay=run();replay.accept(event('canonical-source-use',{...use,acquisitionFrameId:34,phase:'recovery'}));
 replay.accept(event('canonical-raster-receipt',{...receipt,acquisitionFrameId:34}));
 assert.deepEqual(replay.summary(true),{supported:true,complete:true,matches:true,uses:2,measured:2,verified:2});
});
test('same pixels/time cannot substitute source identity, acquisition identity or geometry',()=>{
 for(const changes of [{receipt:{sourceFrameId:8}},{receipt:{acquisitionFrameId:32}},{receipt:{captureTime:3}},
  {receipt:{width:9}},{receipt:{hash:'b'.repeat(64)}},{frame:{canonical:false}},{use:{sourceFrameId:8}}])
  assert.throws(()=>run(changes).summary(true),/불일치/);
});
test('partial or legacy recordings do not claim complete input equality',()=>{
 const legacy=new CanonicalRasterReplay();legacy.accept(frame);legacy.accept(event('canonical-source-use',use));
 assert.equal(legacy.summary(true).supported,false);assert.equal(legacy.summary(true).matches,null);
 const partial=run();partial.accept(event('canonical-source-use',{...use,acquisitionFrameId:32}));
 assert.equal(partial.summary(false).matches,null);assert.throws(()=>partial.summary(true),/누락/);
});
test('duplicate acquisitions, fabricated reused measurements and undeclared receipts are rejected',()=>{
 const replay=run();assert.throws(()=>replay.accept(event('canonical-raster-receipt',receipt)),/중복/);
 assert.throws(()=>run({receipt:{kind:'analysis-reused'}}));
 const missing=new CanonicalRasterReplay();missing.accept(event('canonical-raster-receipt',receipt));assert.throws(()=>missing.summary(true),/계약 없는/);
 const duplicate=run();assert.throws(()=>duplicate.accept(event('canonical-source-use',use)),/중복/);
});
test('production execution reader enforces a declared raster contract after export',async()=>{
 const make=(hashValue:string)=>new Blob([
  ...entryParts({...frame,kind:'frame',key:true,codec:'lz4',xor:true} as ExactEntry,fastCompress(packPixels(new Uint8Array(256),undefined,true))),
  ...entryParts({...event('canonical-raster-contract',{version:1}),seq:1} as ExactEntry),
  ...entryParts({...event('canonical-source-use',use),seq:2} as ExactEntry),
  ...entryParts({...event('canonical-raster-receipt',{...receipt,hash:hashValue}),seq:3} as ExactEntry),
 ]);
 const totals={complete:true,dropped:0,events:3,frames:1};
 assert.equal((await executionSummary(make(hash),new AbortController().signal,totals)).rasterProof?.matches,true);
 await assert.rejects(executionSummary(make('b'.repeat(64)),new AbortController().signal,totals),/불일치/);
 // This reader checks event/header binding. Pixel bytes still require exactPixels.
});
test('legacy recordings beyond the new contract metadata bound remain unsupported instead of rejected',()=>{
 const legacy=new CanonicalRasterReplay();for(let id=1;id<=10_001;id++)legacy.accept({...frame,id} as ExactEntry);
 legacy.accept(event('canonical-source-use',use));legacy.accept(event('canonical-source-use',use));
 assert.equal(legacy.summary(true).supported,false);assert.equal(legacy.summary(true).uses,2);
 assert.throws(()=>legacy.accept(event('canonical-raster-contract',{version:1})),/과도한/);
});
test('analysis reuse requires a prior measured acquisition of the same physical source, not another similar image',()=>{
 const replay=run();replay.accept(event('canonical-source-use',{...use,acquisitionFrameId:34,phase:'recovery'}));
 replay.accept(event('canonical-raster-receipt',{...receipt,kind:'analysis-reused',acquisitionFrameId:34,originAcquisitionFrameId:31}));
 assert.deepEqual(replay.summary(true),{supported:true,complete:true,matches:true,uses:2,measured:1,reused:1,verified:2});
 for(const origin of [30,34,40]){
  const invalid=run();invalid.accept(event('canonical-source-use',{...use,acquisitionFrameId:34,phase:'recovery'}));
  assert.throws(()=>{invalid.accept(event('canonical-raster-receipt',{...receipt,kind:'analysis-reused',acquisitionFrameId:34,originAcquisitionFrameId:origin}));invalid.summary(true);});
 }
 const chain=run();chain.accept(event('canonical-source-use',{...use,acquisitionFrameId:34,phase:'recovery'}));
 chain.accept(event('canonical-raster-receipt',{...receipt,kind:'analysis-reused',acquisitionFrameId:34,originAcquisitionFrameId:31}));
 chain.accept(event('canonical-source-use',{...use,acquisitionFrameId:35,phase:'recovery'}));
 chain.accept(event('canonical-raster-receipt',{...receipt,kind:'analysis-reused',acquisitionFrameId:35,originAcquisitionFrameId:34}));
 assert.throws(()=>chain.summary(true),/실제 측정/);
});
