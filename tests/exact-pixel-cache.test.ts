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

test('frame snapshots survive overwriting and eviction of source slots',()=>{
 const cache=new ExactPixelCache<string>(2),px=new Uint8ClampedArray([1,2,3,255]);
 cache.set(0,'a',px,'old-zero');cache.set(1,'b',px,'old-one');
 const previous=cache.snapshot();cache.set(0,'a',px,'new-zero');cache.set(2,'c',px,'new-two');
 assert.equal(previous.get(0,'a',px),'old-zero');assert.equal(previous.get(1,'b',px),'old-one');
 assert.equal(cache.get(0,'a',px),'new-zero');assert.equal(cache.get(1,'b',px),undefined);
});

test('region selection compares all bytes including sparse changes and alpha without borrowing full-pixel identity',()=>{
 const cache=new ExactPixelCache<string>(),pixels=new Uint8ClampedArray(8*6*4).fill(20);
 const regions=[{x:1,y:1,width:3,height:2},{x:5,y:4,width:2,height:1}];
 cache.setOwned(0,'geometry',pixels,'fields');const before=pixels.slice();
 const portrait=pixels.slice();portrait[0]^=1;
 assert.equal(cache.getRegions(0,'geometry',portrait,8,regions,()=>true),'fields');
 assert.equal(cache.get(0,'geometry',portrait),undefined,'a subset match is never a whole-crop cache hit');
 for(const box of regions)for(let y=box.y;y<box.y+box.height;y++)for(let x=box.x;x<box.x+box.width;x++)for(let channel=0;channel<4;channel++){
  const changed=pixels.slice();changed[(y*8+x)*4+channel]^=1;
  assert.equal(cache.getRegions(0,'geometry',changed,8,regions,()=>true),undefined);
 }
 assert.deepEqual(pixels,before,'comparisons do not change the immutable cache snapshot');
 assert.deepEqual(portrait.slice(1),before.slice(1));
});

test('region selection rejects missing geometry, invalid masks, cache eviction and failed content guards',()=>{
 const cache=new ExactPixelCache<string>(1),pixels=new Uint8ClampedArray(8*6*4);
 const box={x:1,y:1,width:3,height:2},match=()=>true;
 cache.setOwned(0,'geometry',pixels,'old');
 for(const regions of [[],[{...box,x:-1}],[{...box,x:.5}],[{...box,width:0}],[{...box,height:6}],[box,{...box,x:8}]])
  assert.equal(cache.getRegions(0,'geometry',pixels,8,regions,match),undefined);
 assert.equal(cache.getRegions(0,'other',pixels,8,[box],match),undefined);
 assert.equal(cache.getRegions(0,'geometry',pixels,7,[box],match),undefined);
 assert.equal(cache.getRegions(0,'geometry',pixels,8,[box],()=>false),undefined);
 const snapshot=cache.snapshot();cache.setOwned(1,'geometry',pixels,'replacement');
 assert.equal(cache.getRegions(0,'geometry',pixels,8,[box],match),undefined);
 assert.equal(snapshot.getRegions(0,'geometry',pixels,8,[box],match),'old');
});

test('region equality preserves every channel for independently offset source views',()=>{
 const width=7,height=5,size=width*height*4,regions=[{x:1,y:1,width:5,height:3}];
 for(const leftOffset of [0,1,2,3,4])for(const rightOffset of [0,1,2,3,4]){
  const left=new Uint8ClampedArray(size+leftOffset+4).subarray(leftOffset,leftOffset+size);
  const right=new Uint8ClampedArray(size+rightOffset+4).subarray(rightOffset,rightOffset+size);
  for(let i=0;i<size;i++)left[i]=right[i]=(i*73)%256;
  const cache=new ExactPixelCache<number>();cache.setOwned(0,'g',left,17);
  assert.equal(cache.getRegions(0,'g',right,width,regions,()=>true),17);
  for(let index=0;index<size;index++){
   right[index]^=1;
   const pixel=Math.floor(index/4),x=pixel%width,y=Math.floor(pixel/width);
   const inside=x>=1&&x<6&&y>=1&&y<4;
   assert.equal(cache.getRegions(0,'g',right,width,regions,()=>true),inside?undefined:17,
     `${leftOffset}/${rightOffset} byte ${index}`);
   right[index]^=1;
  }
 }
});
