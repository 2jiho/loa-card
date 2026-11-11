import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFrameSkipper,frameChange,lumaThumbnail,parsePolicy,THUMBNAIL_HEIGHT,THUMBNAIL_WIDTH} from '../src/features/card-scanner/capture/frame-similarity';

const COUNT=THUMBNAIL_WIDTH*THUMBNAIL_HEIGHT;
const flat=(value:number)=>new Uint8Array(COUNT).fill(value);
/** A thumbnail equal to `base` except for one 16x16 block raised by `delta`. */
function withBlock(base:Uint8Array,bx:number,by:number,delta:number){
  const copy=base.slice();
  for(let y=0;y<16;y++)for(let x=0;x<16;x++)copy[(by*16+y)*THUMBNAIL_WIDTH+bx*16+x]+=delta;
  return copy;
}

test('luma thumbnail weights the channels and checks its size', () => {
  const rgba=new Uint8Array(COUNT*4);for(let i=0;i<COUNT;i++)rgba.set([255,0,0,255],i*4);
  assert.equal(lumaThumbnail(rgba)[0],76);               // 255 * 0.299
  assert.throws(()=>lumaThumbnail(new Uint8Array(8)),RangeError);
});

test('frame change reports the whole-screen mean and the largest block, so a local change is not averaged away', () => {
  const still=flat(100);
  const local=withBlock(still,3,4,40);                  // one of 144 blocks changes by 40
  const change=frameChange(local,still);
  assert.equal(change.maxBlock,40);
  assert.ok(Math.abs(change.mean-40/144)<1e-9,'mean over the whole screen is tiny: '+change.mean);
  assert.deepEqual(frameChange(still,still),{mean:0,maxBlock:0});
  assert.throws(()=>frameChange(new Uint8Array(4),still),RangeError);
});

test('the first frame is always processed; identical frames are skipped', () => {
  const skipper=createFrameSkipper({mean:0.5,block:4,forceEvery:100});
  assert.deepEqual([skipper.decide(flat(50)).skip,skipper.decide(flat(50)).skip,skipper.decide(flat(50)).skip],[false,true,true]);
});

test('a change confined to one block is processed even when the mean difference is far below the threshold', () => {
  const skipper=createFrameSkipper({mean:1,block:4,forceEvery:100});
  const base=flat(100);skipper.decide(base);
  const decision=skipper.decide(withBlock(base,0,0,30));
  assert.equal(decision.skip,false);assert.equal(decision.reason,'changed');
  assert.ok(decision.mean<1,'the whole-screen mean alone would have skipped this frame');
});

test('frames are compared with the last PROCESSED frame, so slow drift cannot add up unseen', () => {
  const skipper=createFrameSkipper({mean:0.5,block:100,forceEvery:100});
  const results:boolean[]=[];
  // Each frame is 0.2 brighter than the previous one: pairwise tiny, cumulatively large.
  for(let step=0;step<8;step++)results.push(skipper.decide(flat(100+Math.round(step*0.2*5)/5*1)).skip);
  // brightness 100,100,101,101,102,... : skipped while within 0.5 of the processed frame, then processed.
  assert.equal(results[0],false);
  assert.ok(results.includes(false,1),'the drift is processed at some point: '+results.join());
  const drift=createFrameSkipper({mean:0.5,block:100,forceEvery:100});
  drift.decide(flat(100));
  assert.equal(drift.decide(flat(100)).skip,true);
  assert.equal(drift.decide(flat(101)).skip,false,'1.0 from the processed frame');
});

test('after forceEvery consecutive skips a frame is processed anyway', () => {
  const skipper=createFrameSkipper({mean:5,block:5,forceEvery:3});
  const decisions=Array.from({length:9},()=>skipper.decide(flat(10)));
  assert.deepEqual(decisions.map(d=>d.skip),[false,true,true,true,false,true,true,true,false]);
  assert.equal(decisions[4].reason,'forced');
});

test('reset forgets the reference', () => {
  const skipper=createFrameSkipper({mean:5,block:5,forceEvery:50});
  skipper.decide(flat(10));assert.equal(skipper.decide(flat(10)).skip,true);
  skipper.reset();assert.equal(skipper.decide(flat(10)).skip,false);
});

test('policy parsing and validation', () => {
  assert.deepEqual(parsePolicy('mean=1,block=6,force=8'),{mean:1,block:6,forceEvery:8});
  const lenient=parsePolicy('mean=0.5');
  assert.equal(lenient.mean,0.5);assert.equal(lenient.block,Infinity);assert.ok(lenient.forceEvery>1e9);
  assert.throws(()=>parsePolicy('mean=x'),TypeError);
  assert.throws(()=>parsePolicy('speed=3'),TypeError);
  assert.throws(()=>createFrameSkipper({mean:-1,block:1,forceEvery:1}),RangeError);
  assert.throws(()=>createFrameSkipper({mean:1,block:1,forceEvery:0}),RangeError);
});
