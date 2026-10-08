import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasNamePixels, nameMask, NAME_WIDTH, NAME_HEIGHT } from '../src/features/card-scanner/name-pattern';

const legacy = (rgba: Uint8ClampedArray) => [0,1,2,3,4].some(grade =>
  nameMask(rgba,grade).reduce((sum,value) => sum+value,0) >= 35);

test('presence retains the independent 35-pixel threshold for all rarity colors', () => {
  for (const color of [[200,200,200],[80,180,40],[40,150,200],[170,50,190],[200,130,40]]) {
    for (const count of [0,34,35,36]) {
      const rgba = new Uint8ClampedArray(NAME_WIDTH*NAME_HEIGHT*4);
      // Include labels whose decisive pixels are at the end of the image.
      for (let i=NAME_WIDTH*NAME_HEIGHT-count;i<NAME_WIDTH*NAME_HEIGHT;i++) rgba.set([...color,255],i*4);
      assert.equal(hasNamePixels(rgba),count>=35);
      assert.equal(hasNamePixels(rgba),legacy(rgba));
    }
  }
  const mixed = new Uint8ClampedArray(NAME_WIDTH*NAME_HEIGHT*4);
  for (let i=0;i<34;i++) mixed.set([200,200,200,255],i*4);
  for (let i=34;i<68;i++) mixed.set([170,50,190,255],i*4);
  assert.equal(hasNamePixels(mixed),false,'different rarity counts must not be pooled');
});

test('single-pass presence agrees with legacy masks for sparse and dense RGB input', () => {
  let seed=12345;
  const next=() => { seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed; };
  for(let sample=0;sample<250;sample++) {
    const rgba=new Uint8ClampedArray(NAME_WIDTH*NAME_HEIGHT*4);
    const density=sample<200 ? 10+sample : NAME_WIDTH*NAME_HEIGHT;
    for(let j=0;j<density;j++) {
      const i=next()%(NAME_WIDTH*NAME_HEIGHT),rgb=next();
      rgba.set([rgb&255,(rgb>>>8)&255,(rgb>>>16)&255,next()&255],i*4);
    }
    assert.equal(hasNamePixels(rgba),legacy(rgba),`sample ${sample}`);
  }
});
