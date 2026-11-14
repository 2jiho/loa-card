import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nameBandSpread} from '../src/features/card-scanner/recognition/name-visibility';
import {NAME_TEXT_SPREAD} from '../src/features/card-scanner/recognition/recognizer';

/** A 140x210 crop whose name band (rows 15..35) is `plate`, with white strokes in `strokes` of its columns. */
const crop=(plate:number,strokes=0,glow=0)=>{
  const rgba=new Uint8ClampedArray(140*210*4).fill(255);
  for(let y=0;y<210;y++)for(let x=0;x<140;x++){
    const i=(y*140+x)*4,shade=Math.min(255,plate+glow*(1-y/60));
    rgba[i]=rgba[i+1]=rgba[i+2]=shade;
  }
  for(let y=18;y<30;y++)for(let x=20;x<20+strokes;x+=2){const i=(y*140+x)*4;rgba[i]=rgba[i+1]=rgba[i+2]=235;}
  return rgba;
};

test('a name band with text strokes stands well above its plate; an empty or washed-out one does not', () => {
  assert.ok(nameBandSpread(crop(40,80),140,210)>=NAME_TEXT_SPREAD,'white name strokes on a dark plate');
  assert.ok(nameBandSpread(crop(42),140,210)<NAME_TEXT_SPREAD,'a dark empty slot');
  assert.ok(nameBandSpread(crop(200,0,30),140,210)<NAME_TEXT_SPREAD,'the hover glow washing out a plate (measured 4 to 11)');
  assert.ok(nameBandSpread(crop(200,0,90),140,210)>=NAME_TEXT_SPREAD,'a strong gradient is not refused: it may be a name blurred while scrolling');
  assert.equal(nameBandSpread(new Uint8ClampedArray(10),2,5),Infinity,'a crop too small is never refused');
});
