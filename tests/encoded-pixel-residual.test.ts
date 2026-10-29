import test from 'node:test';
import assert from 'node:assert/strict';
import {createEncodedPixelResidual,MAX_ENCODED_PIXEL_RESIDUAL_EDITS,restoreEncodedPixels} from '../src/features/card-scanner/encoded-pixel-residual';
import {MAX_FRAME_BYTES,pixelHash} from '../src/features/card-scanner/exact-recording-codec';

const base=()=>Uint8Array.from([10,20,30,255,40,50,60,255,70,80,90,255,100,110,120,255]);
const changed=()=>{const result=base();result[0]=9;result[7]=254;result[15]=0;return result;};

test('sparse RGB and alpha bytes reconstruct the exact actual RGBA in the owned view',async()=>{
 const baseline=base(),actual=changed(),beforeBase=baseline.slice(),beforeActual=actual.slice();
 const residual=await createEncodedPixelResidual(baseline,actual);
 assert.ok(residual);assert.equal(residual.version,1);assert.equal(residual.bytes,16);
 assert.deepEqual(residual.edits,[{offset:0,value:9},{offset:7,value:254},{offset:15,value:0}]);
 assert.equal(residual.baseSha256,await pixelHash(baseline));assert.equal(residual.resultSha256,await pixelHash(actual));
 assert.deepEqual(baseline,beforeBase);assert.deepEqual(actual,beforeActual);
 assert.ok(Object.isFrozen(residual));assert.ok(Object.isFrozen(residual.edits));assert.ok(residual.edits.every(Object.isFrozen));
 const owned=baseline.slice(),restored=await restoreEncodedPixels(owned,JSON.parse(JSON.stringify(residual)));
 assert.equal(restored,owned);assert.equal(restored.buffer,owned.buffer);assert.deepEqual(restored,actual);
 assert.equal(await pixelHash(restored),residual.resultSha256);
});

test('exact equality has an empty residual and zero budget still distinguishes equality from raw fallback',async()=>{
 const baseline=base(),equal=baseline.slice();
 for(const budget of [0,MAX_ENCODED_PIXEL_RESIDUAL_EDITS]){
  const patch=await createEncodedPixelResidual(baseline,equal,budget);assert.ok(patch);
  assert.deepEqual(patch.edits,[]);assert.equal(patch.baseSha256,patch.resultSha256);
  const owned=baseline.slice();assert.equal(await restoreEncodedPixels(owned,patch),owned);assert.deepEqual(owned,equal);
 }
 assert.equal(await createEncodedPixelResidual(baseline,changed(),0),null);
});

test('more than the selected edit budget requests raw storage without changing either input',async()=>{
 const baseline=base(),actual=changed(),beforeBase=baseline.slice(),beforeActual=actual.slice();
 assert.equal(await createEncodedPixelResidual(baseline,actual,2),null);
 assert.deepEqual(baseline,beforeBase);assert.deepEqual(actual,beforeActual);
 const exactBudget=await createEncodedPixelResidual(baseline,actual,3);assert.equal(exactBudget?.edits.length,3);
 const largeBase=new Uint8Array(MAX_ENCODED_PIXEL_RESIDUAL_EDITS+4),largeActual=largeBase.slice().fill(1);
 assert.equal(await createEncodedPixelResidual(largeBase,largeActual),null);
 assert.equal(largeBase.some(Boolean),false);assert.equal(largeActual.every(value=>value===1),true);
});

test('changed baseline SHA is rejected before applying any edit',async()=>{
 const patch=await createEncodedPixelResidual(base(),changed());assert.ok(patch);
 const owned=base();owned[4]++;const before=owned.slice();
 await assert.rejects(restoreEncodedPixels(owned,patch),/기준 픽셀 SHA/);assert.deepEqual(owned,before);
});

test('wrong result SHA never returns a patched buffer as verified pixels',async()=>{
 const patch=await createEncodedPixelResidual(base(),changed());assert.ok(patch);
 const owned=base();let returned=false;
 await assert.rejects(restoreEncodedPixels(owned,{...patch,resultSha256:'0'.repeat(64)}).then(()=>{returned=true;}),/결과 픽셀 SHA/);
 assert.equal(returned,false);assert.deepEqual(owned,changed(),'failed owned output must be discarded by its caller');
});

test('metadata is completely validated before mutation, including later malformed edits and no-ops',async()=>{
 const patch=await createEncodedPixelResidual(base(),changed());assert.ok(patch);
 const malformed:unknown[]=[null,[],{}, {...patch,version:2},{...patch,bytes:12},{...patch,bytes:NaN},
  {...patch,baseSha256:patch.baseSha256.toUpperCase()},{...patch,resultSha256:'z'.repeat(64)},
  {...patch,edits:null},{...patch,edits:{}},{...patch,edits:[null]},
  {...patch,edits:[{offset:0,value:9},{offset:0,value:8}]},
  {...patch,edits:[{offset:7,value:254},{offset:0,value:9}]},
  {...patch,edits:[{offset:-1,value:9}]},{...patch,edits:[{offset:16,value:9}]},
  {...patch,edits:[{offset:0,value:256}]},{...patch,edits:[{offset:0,value:-1}]},
  {...patch,edits:[{offset:.5,value:9}]},{...patch,edits:[{offset:0,value:.5}]},
  {...patch,edits:[{offset:0,value:9},{offset:7,value:255}]},
  {...patch,edits:[]},
  {...patch,edits:Array.from({length:MAX_ENCODED_PIXEL_RESIDUAL_EDITS+1},(_,offset)=>({offset,value:1}))}];
 for(const invalid of malformed){const owned=base(),before=owned.slice();await assert.rejects(restoreEncodedPixels(owned,invalid));assert.deepEqual(owned,before);}
});

test('sparse metadata is snapshotted before hashing can yield to a caller that changes its object',async()=>{
 const patch=await createEncodedPixelResidual(base(),changed());assert.ok(patch);
 const wire=JSON.parse(JSON.stringify(patch)),owned=base(),pending=restoreEncodedPixels(owned,wire);
 wire.baseSha256='0'.repeat(64);wire.resultSha256='0'.repeat(64);wire.edits[0].value=200;wire.edits.push({offset:1,value:201});
 assert.deepEqual(await pending,changed());
});

test('restoration uses the checked indexed edits rather than a substituted array iterator',async()=>{
 const baseline=base(),actual=base();actual[0]=11;
 const patch=await createEncodedPixelResidual(baseline,actual);assert.ok(patch);
 const wire=JSON.parse(JSON.stringify(patch));let iteratorCalls=0;
 wire.edits[Symbol.iterator]=function*(){iteratorCalls++;};
 assert.deepEqual(await restoreEncodedPixels(baseline,wire),actual);assert.equal(iteratorCalls,0);
});

test('the fixed 4096-edit limit is restorable without accepting a 4097th byte',async()=>{
 const baseline=new Uint8Array(MAX_ENCODED_PIXEL_RESIDUAL_EDITS+4),actual=baseline.slice();actual.fill(255,0,MAX_ENCODED_PIXEL_RESIDUAL_EDITS);
 const patch=await createEncodedPixelResidual(baseline,actual);assert.equal(patch?.edits.length,MAX_ENCODED_PIXEL_RESIDUAL_EDITS);
 assert.deepEqual(await restoreEncodedPixels(baseline,patch),actual);
});

test('only complete bounded RGBA ArrayBuffer views and valid edit budgets are accepted',async()=>{
 for(const invalid of [new Uint8Array(),new Uint8Array(3),new Uint8Array(MAX_FRAME_BYTES+4),new Uint8Array(new SharedArrayBuffer(4))]){
  await assert.rejects(createEncodedPixelResidual(invalid as Uint8Array<ArrayBuffer>,base()));
  await assert.rejects(restoreEncodedPixels(invalid as Uint8Array<ArrayBuffer>,{}));
 }
 await assert.rejects(createEncodedPixelResidual(base(),new Uint8Array(4)),/크기 불일치/);
 for(const invalid of [-1,.5,NaN,Infinity,MAX_ENCODED_PIXEL_RESIDUAL_EDITS+1])await assert.rejects(createEncodedPixelResidual(base(),base(),invalid),/상한/);
});

test('hash and offset handling use only the supplied RGBA view and do not touch adjacent backing bytes',async()=>{
 const storage=new Uint8Array(24).fill(201);storage.set(base(),4);
 const baseline=storage.subarray(4,20),actual=changed(),patch=await createEncodedPixelResidual(baseline,actual);assert.ok(patch);
 const owned=storage.subarray(4,20);assert.equal(await restoreEncodedPixels(owned,patch),owned);
 assert.deepEqual(owned,actual);assert.deepEqual([...storage.subarray(0,4)],[201,201,201,201]);assert.deepEqual([...storage.subarray(20)],[201,201,201,201]);
});
