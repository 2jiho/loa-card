import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nameLocalContrast} from '../src/features/card-scanner/recognition/name-local-contrast';
import {alignCardBorders} from '../src/features/card-scanner/acquisition/card-borders';
import {integerCropPixels} from '../src/features/card-scanner/acquisition/integer-crop-pixels';

// Pre-optimization implementation. This checks equivalence, not OCR truth.
function reference(gray:Float32Array) {
  const output=new Uint8Array(128*36);
  for(let y=0;y<36;y++)for(let x=0;x<128;x++){
    let dark=255;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)
      if(y+dy>=0&&y+dy<36&&x+dx>=0&&x+dx<128)
        dark=Math.min(dark,gray[(y+dy)*128+x+dx]);
    output[y*128+x]=Number(dark<100&&gray[y*128+x]-dark>=45);
  }
  return output;
}
function compare(gray:Float32Array) {
  const bytes=new Uint8Array(gray.buffer,gray.byteOffset,gray.byteLength).slice();
  assert.deepEqual(nameLocalContrast(gray),reference(gray));
  assert.deepEqual(new Uint8Array(gray.buffer,gray.byteOffset,gray.byteLength),bytes,'input pixels must not be changed');
}
function grayFromCrop(crop:Uint8ClampedArray) {
  const gray=new Float32Array(128*36);
  for(let y=0;y<36;y++)for(let x=0;x<128;x++){
    const i=((y+14)*140+x+6)*4;
    gray[y*128+x]=.299*crop[i]+.587*crop[i+1]+.114*crop[i+2];
  }
  return gray;
}

test('recorded card crops preserve every contrast-mask byte',async()=>{
  const samples=JSON.parse(await readFile('tests/fixtures/border-integrity-samples.json','utf8'));
  let checked=0;
  for(const sample of samples.filter((item:{intact:boolean})=>item.intact)){
    const pixels=new Uint8ClampedArray(Buffer.from(sample.rgba,'base64'));
    const borders=alignCardBorders(pixels,sample.width,sample.height,sample.box);
    const crop=integerCropPixels(pixels,sample.width,sample.height,borders.content);
    assert.ok(crop);compare(grayFromCrop(crop));checked++;
  }
  assert.ok(checked>=5);
});

test('deterministic randomized, boundary and transparent pixel inputs match the previous mask',()=>{
  let seed=0x61d709f3;
  const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
  for(let sample=0;sample<32;sample++){
    const rgba=Uint8ClampedArray.from({length:140*210*4},(_,index)=>index%4===3?[0,128,255][next()%3]:next()%256);
    compare(grayFromCrop(rgba));
  }
  for(const point of [[0,0],[127,0],[0,35],[127,35],[2,2],[125,33],[64,18]]){
    const gray=new Float32Array(128*36).fill(144.5);gray[point[1]*128+point[0]]=99.5;compare(gray);
  }
  for(const values of [[100,145],[99.999,144.999],[99,143.999],[99,144],[0,255],[Infinity,-Infinity],[NaN,42]]){
    const gray=new Float32Array(128*36).fill(values[0]);gray[64]=values[1];compare(gray);
  }
});

test('wrong grayscale lengths fail without modifying the supplied data',()=>{
  for(const length of [0,1,128*36-1,128*36+1]){
    const gray=new Float32Array(length).fill(12.5),original=gray.slice();
    assert.throws(()=>nameLocalContrast(gray),RangeError);
    assert.deepEqual(gray,original);
  }
});
