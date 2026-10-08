import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ExactPixelCache} from '../src/features/card-scanner/exact-pixel-cache';
test('owned subarrays compare only their exact byte range, aligned or unaligned',()=>{
 for(const offset of [1,4]) {
  const cache=new ExactPixelCache<string>();
  const allocation=new Uint8ClampedArray(16).fill(99);
  allocation.set([1,2,3,255],offset);
  cache.setOwned(0,'crop',allocation.subarray(offset,offset+4),'match');
  assert.equal(cache.get(0,'crop',new Uint8ClampedArray([1,2,3,255])),'match');
  assert.equal(cache.get(0,'crop',new Uint8ClampedArray([1,2,4,255])),undefined);
 }
});
test('pixel changes including alpha and geometry invalidate a cached crop',()=>{
 const c=new ExactPixelCache<string>(),px=new Uint8ClampedArray([1,2,3,255,4,5,6,255]);
 c.set(0,'geometry',px,'card');
 assert.equal(c.get(0,'geometry',px),'card');
 assert.equal(c.get(0,'moved',px),undefined);
 assert.equal(c.get(1,'geometry',px),undefined);
 assert.equal(c.get(0,'geometry',px.subarray(0,4)),undefined);
 for(let i=0;i<px.length;i++){const changed=px.slice();changed[i]^=1;assert.equal(c.get(0,'geometry',changed),undefined);}
 px[0]=99;assert.equal(c.get(0,'geometry',px),undefined,'stored pixels own their copy');
});
test('bounded storage and unaligned views preserve exact byte comparison',()=>{
 const c=new ExactPixelCache<string>(2),buffer=new Uint8ClampedArray([0,1,2,3,4,5]);
 const view=buffer.subarray(1,5);
 c.set(0,'g',view,'a');assert.equal(c.get(0,'g',view),'a');
 c.set(1,'g',view,'b');c.set(2,'g',view,'c');assert.equal(c.get(0,'g',view),undefined);
 c.set(1,'g',view,'updated');assert.equal(c.get(1,'g',view),'updated');
 assert.equal(c.get(2,'g',view),'c');
});
test('owned independent pixel snapshots retain exact matching and bounded eviction',()=>{
 const c=new ExactPixelCache<string>(1);
 c.setOwned(0,'crop',new Uint8ClampedArray([1,2,3,255]),'first');
 assert.equal(c.get(0,'crop',new Uint8ClampedArray([1,2,3,255])),'first');
 assert.equal(c.get(0,'crop',new Uint8ClampedArray([1,2,4,255])),undefined);
 c.setOwned(1,'crop',new Uint8ClampedArray([4,5,6,255]),'second');
 assert.equal(c.get(0,'crop',new Uint8ClampedArray([1,2,3,255])),undefined);
 assert.equal(c.get(1,'crop',new Uint8ClampedArray([4,5,6,255])),'second');
});
