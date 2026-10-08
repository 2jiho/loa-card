import {test} from 'node:test';
import assert from 'node:assert/strict';
import {integerCropPixels} from '../src/features/card-scanner/integer-crop-pixels';
import {hasNamePixels} from '../src/features/card-scanner/name-pattern';

test('integer crop preserves row order, alpha and independent ownership',()=>{
 const source=Uint8ClampedArray.from({length:7*6*4},(_,i)=>(i*73)%256);
 const actual=integerCropPixels(source,7,6,{x:2,y:1,width:3,height:4})!;
 for(let y=0;y<4;y++)for(let x=0;x<3;x++)for(let c=0;c<4;c++)
  assert.equal(actual[(y*3+x)*4+c],source[((y+1)*7+x+2)*4+c]);
 const before=actual.slice();source.fill(0);assert.deepEqual(actual,before);
});
test('resampling, clipping and malformed data fall back instead of changing pixels',()=>{
 const source=new Uint8ClampedArray(7*6*4);
 for(const box of [{x:.5,y:1,width:3,height:4},{x:2,y:1,width:3.1,height:4},
  {x:-1,y:1,width:3,height:4},{x:5,y:1,width:3,height:4},{x:2,y:4,width:3,height:4},
  {x:2,y:1,width:0,height:4}])assert.equal(integerCropPixels(source,7,6,box),undefined);
 assert.equal(integerCropPixels(source.subarray(4),7,6,{x:2,y:1,width:3,height:4}),undefined);
});
test('strided name presence keeps the 35-pixel boundary and ignores artwork and counters',()=>{
 const colors=[[220,220,220],[100,180,30],[30,150,180],[160,30,180],[200,140,30]];
 for(const color of colors)for(const count of [0,34,35,36]){
  const card=new Uint8ClampedArray(140*210*4);
  card.fill(255);for(let y=14;y<50;y++)for(let x=6;x<134;x++)card.fill(0,(y*140+x)*4,(y*140+x+1)*4);
  for(let n=0;n<count;n++)card.set([...color,255],((14+Math.floor(n/128))*140+6+n%128)*4);
  const label=integerCropPixels(card,140,210,{x:6,y:14,width:128,height:36})!;
  assert.equal(hasNamePixels(card,(14*140+6)*4,140),hasNamePixels(label));
  assert.equal(hasNamePixels(label),count>=35);
 }
});
