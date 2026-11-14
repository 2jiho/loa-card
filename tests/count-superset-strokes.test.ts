import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {COUNT_SUPERSET_STROKES,matchCountPattern,prepareContrastPattern} from '../src/features/card-scanner/recognition/count-pattern';
import type {CountPattern} from '../src/features/card-scanner/recognition/count-pattern';
import {countReliability} from '../src/features/card-scanner/recognition/count-confidence';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/count-five-k-eight.json',import.meta.url),'utf8'));
const patterns=(JSON.parse(readFileSync(new URL('../public/scanner/counter-patterns.json',import.meta.url),'utf8')).patterns as CountPattern[]).map(prepareContrastPattern);
const picture=()=>{
  const image=new Uint8ClampedArray(140*210*4),bytes=Buffer.from(fixture.rgba,'base64');
  for(let y=0;y<fixture.height;y++)for(let x=0;x<fixture.width;x++)
    image.set(bytes.subarray((y*fixture.width+x)*4,(y*fixture.width+x)*4+4),((fixture.y+y)*140+fixture.x+x)*4);
  return image;
};

test('a 5K "+8" that the patterns score as 3 is not read: the strokes only 8 has are lit', () => {
  // 반다 at 5120x2880 (2.0 scale): 3 scored 0.48 and 8 only 0.30, and one replay confirmed it as 3.
  const reading=matchCountPattern(picture(),patterns,0,12,false,.22);
  assert.equal(reading.candidate,3,'the patterns still rank 3 first');
  assert.equal(reading.value,null,'but no value is read');
  assert.equal(reading.reason,COUNT_SUPERSET_STROKES);
  // Nothing to accept: a crop of a still list (stable) cannot confirm it either.
  assert.equal(countReliability({stable:true,borderAlignment:1,awakening:2,extraCopies:reading.value,pattern:reading,iconPresent:true}),'unconfirmed');
});

test('the veto never reads the other value instead', () => {
  const reading=matchCountPattern(picture(),patterns,0,15,false,.22);
  assert.notEqual(reading.value,8);
  assert.notEqual(reading.value,3);
});
