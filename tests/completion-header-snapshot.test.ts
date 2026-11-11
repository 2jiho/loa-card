import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareInventoryHeaderTotal,headerSnapshotMatches,nextHeaderConflict,snapshotHeader,type CompletionHeaderInput} from '../src/features/card-scanner/session/completion-header-snapshot';

const header=():CompletionHeaderInput=>({width:1,height:1,pixels:Uint8ClampedArray.of(1,2,3,255),captureTime:3,sourceFrame:8});
test('header OCR snapshot retains its own pixels when later acquisition mutates the canvas data',()=>{
 const original=header(),snapshot=snapshotHeader(original);
 original.pixels[0]=9;
 assert.equal(snapshot.pixels[0],1);
 assert.equal(headerSnapshotMatches(snapshot,original),false);
 assert.equal(headerSnapshotMatches(snapshot,{...header(),captureTime:4,sourceFrame:9}),true);
});
test('old frames, resized inputs and missing pixel evidence cannot reuse the OCR result',()=>{
 const snapshot=snapshotHeader(header());
 for(const current of [
  {...header(),captureTime:2}, {...header(),sourceFrame:7},
  {...header(),width:2,pixels:new Uint8ClampedArray(8)},
  {...header(),pixels:Uint8ClampedArray.of(1,2,4,255)},
  {...header(),pixels:new Uint8ClampedArray(new SharedArrayBuffer(4))},
 ])assert.equal(headerSnapshotMatches(snapshot,current),false);
});

test('owned count and capacity must both match; invalid or unreadable pairs do not establish a match',()=>{
 const initial={owned:393,capacity:450};
 assert.equal(compareInventoryHeaderTotal(initial,{owned:393,capacity:450}),'matching');
 for(const current of [{owned:393,capacity:460},{owned:394,capacity:450},{owned:394,capacity:460}])
  assert.equal(compareInventoryHeaderTotal(initial,current),'different');
 for(const current of [null,undefined,{owned:0,capacity:450},{owned:393,capacity:392},
  {owned:NaN,capacity:450},{owned:393,capacity:Infinity},{owned:393,capacity:2001}])
  assert.equal(compareInventoryHeaderTotal(initial,current),'unavailable');
 for(const initialUnknown of [{owned:null,capacity:450},{owned:393,capacity:null}])
  assert.equal(compareInventoryHeaderTotal(initialUnknown,{owned:393,capacity:450}),'unavailable');
 // A later consistent pair may recover from an earlier OCR mismatch.
 assert.equal(compareInventoryHeaderTotal(initial,{owned:393,capacity:450}),'matching');
});

test('a header mismatch remains visible through failed reads and clears only after a matching pair',()=>{
 let conflict=nextHeaderConflict(undefined,'different');
 assert.equal(conflict,true);
 conflict=nextHeaderConflict(conflict,'unavailable');assert.equal(conflict,true);
 conflict=nextHeaderConflict(conflict,'matching');assert.equal(conflict,false);
 assert.equal(nextHeaderConflict(conflict,'unavailable'),false);
});
