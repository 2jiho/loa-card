import test from 'node:test';
import assert from 'node:assert/strict';
import {NAME_LABEL_CONTRAST_VARIANTS,nameLabelContrast} from '../dev/name-label-contrast';
import type {NameLabelContrastVariant} from '../dev/name-label-contrast';

const WIDTH=128,FIRST_PIXELS=128*18;
function raster(value=150){
  const data=new Uint8ClampedArray(128*36*4);
  for(let i=0;i<data.length;i+=4)data.set([value,value,value,255],i);
  return data;
}
function pixel(data:Uint8ClampedArray,index:number,value:number){data.set([value,value,value,255],index*4);}
const channel=(data:Uint8ClampedArray,x:number,y:number)=>data[(y*WIDTH+x)*4];

test('only first-line pixels are transformed into independent owned output and the input is unchanged',()=>{
  const source=raster(200);pixel(source,10*WIDTH+60,190);const before=source.slice();
  for(const variant of NAME_LABEL_CONTRAST_VARIANTS){
    const first=nameLabelContrast(source,variant),other=source.slice();
    for(let i=FIRST_PIXELS;i<128*36;i++)pixel(other,i,i%256);
    assert.deepEqual(nameLabelContrast(other,variant),first,'second-line colors cannot affect a first-line transform');
    assert.equal(first.width,128);assert.equal(first.height,18);assert.equal(first.data.length,FIRST_PIXELS*4);
    assert.ok(first.data.buffer instanceof ArrayBuffer);assert.notEqual(first.data.buffer,source.buffer);
    assert.deepEqual(source,before);assert.ok(Object.isFrozen(first.recipe));assert.ok(Object.isFrozen(first.recipe.sourceBox));
    first.data.fill(0);assert.deepEqual(source,before);
  }
});

test('percentile stretch ignores extreme outliers and records exact zero-based histogram limits',()=>{
  const source=raster(150);
  pixel(source,0,0);pixel(source,FIRST_PIXELS-1,255);
  for(let i=1;i<=50;i++)pixel(source,i,100);
  for(let i=FIRST_PIXELS-51;i<FIRST_PIXELS-1;i++)pixel(source,i,200);
  const {data,recipe}=nameLabelContrast(source,'stretch-first-v1');
  assert.equal(recipe.variant,'stretch-first-v1');
  if(recipe.variant!=='stretch-first-v1')throw Error('wrong recipe');
  assert.deepEqual([recipe.lowRank,recipe.highRank,recipe.lowGray,recipe.highGray],[23,2280,100,200]);
  assert.deepEqual(Array.from(data.subarray(0,8)),[0,0,0,255,0,0,0,255]);
  assert.equal(data[100*4],128);assert.equal(data[(FIRST_PIXELS-2)*4],255);assert.equal(data[(FIRST_PIXELS-1)*4],255);
});

test('flat labels remain spatially flat without creating a glyph pattern',()=>{
  for(const value of [0,30,128,250,255]){
    const source=raster(value);
    for(const variant of NAME_LABEL_CONTRAST_VARIANTS){
      const {data}=nameLabelContrast(source,variant),expected=variant==='stretch-first-v1'?value:255;
      for(let i=0;i<data.length;i++)assert.equal(data[i],i%4===3?255:expected);
    }
  }
});

test('local polarity exposes a weak dark stroke while only absolute difference exposes a weak light stroke',()=>{
  const dark=raster(200),light=raster(200),x=60,y=9;
  pixel(dark,y*WIDTH+x,190);pixel(light,y*WIDTH+x,210);
  const darkOnly=nameLabelContrast(dark,'local-dark-first-v1');
  assert.equal(channel(darkOnly.data,x,y),177);assert.equal(channel(darkOnly.data,10,9),255);
  assert.equal(channel(nameLabelContrast(light,'local-dark-first-v1').data,x,y),255);
  assert.equal(channel(nameLabelContrast(light,'local-absolute-first-v1').data,x,y),177);
  assert.equal(channel(nameLabelContrast(dark,'local-absolute-first-v1').data,x,y),177);
});

test('local means clip their neighborhoods to the first line instead of padding zeros or reading a second line',()=>{
  const source=raster(100);pixel(source,0,90);pixel(source,FIRST_PIXELS-1,90);
  for(const variant of ['local-dark-first-v1','local-absolute-first-v1'] as const){
    const {data,recipe}=nameLabelContrast(source,variant);
    // A corner uses 16 real samples: mean 99.375, delta 9.375, output 180.
    assert.equal(channel(data,0,0),180);assert.equal(channel(data,127,17),180);
    assert.equal(recipe.algorithm,'clipped-local-mean');
    if(recipe.algorithm!=='clipped-local-mean')throw Error('wrong local recipe');
    assert.match(recipe.boundary,/actual sample count/);
  }
});

test('rounded RGB luminance reads a typed-array view at its own byte offset',()=>{
  const backing=new Uint8ClampedArray(128*36*4+32);backing.fill(17);
  const source=backing.subarray(16,16+128*36*4);
  for(let i=0;i<source.length;i+=4)source.set([12,34,56,255],i);
  const output=nameLabelContrast(source,'stretch-first-v1');
  assert.deepEqual(Array.from(output.data.subarray(0,4)),[30,30,30,255]);
  assert.ok(output.data.every((value,index)=>value===(index%4===3?255:30)));
  assert.ok(backing.subarray(0,16).every(value=>value===17));assert.ok(backing.subarray(backing.length-16).every(value=>value===17));
});

test('all recipes are deterministic, fixed and round to bounded grayscale with opaque output',()=>{
  const source=raster();
  for(let i=0;i<FIRST_PIXELS;i++)source.set([(i*17)%256,(i*31)%256,(i*71)%256,255],i*4);
  assert.ok(Object.isFrozen(NAME_LABEL_CONTRAST_VARIANTS));
  for(const variant of NAME_LABEL_CONTRAST_VARIANTS){
    const first=nameLabelContrast(source,variant),second=nameLabelContrast(source,variant);
    assert.deepEqual(first,second);assert.notEqual(first.data.buffer,second.data.buffer);
    for(let i=0;i<first.data.length;i+=4){
      assert.equal(first.data[i],first.data[i+1]);assert.equal(first.data[i],first.data[i+2]);assert.equal(first.data[i+3],255);
    }
    assert.deepEqual(first.recipe.sourceBox,{x:0,y:0,width:128,height:18});
  }
});

test('wrong shape, array type, variant and nonopaque pixels are rejected without mutating the input',()=>{
  for(const source of [new Uint8ClampedArray(),new Uint8ClampedArray(128*18*4),new Uint8ClampedArray(128*36*4+4)]){
    const before=source.slice();assert.throws(()=>nameLabelContrast(source,'stretch-first-v1'),/128x36 RGBA/);assert.deepEqual(source,before);
  }
  for(const source of [null,[],new Uint8Array(128*36*4)])
    assert.throws(()=>nameLabelContrast(source as unknown as Uint8ClampedArray,'stretch-first-v1'),/128x36 RGBA/);
  const good=raster();assert.throws(()=>nameLabelContrast(good,'other' as NameLabelContrastVariant),/Unsupported/);
  for(const index of [0,FIRST_PIXELS-1,FIRST_PIXELS,128*36-1])for(const alpha of [0,128,254]){
    const source=raster();source[index*4+3]=alpha;const before=source.slice();
    for(const variant of NAME_LABEL_CONTRAST_VARIANTS)assert.throws(()=>nameLabelContrast(source,variant),/opaque/);
    assert.deepEqual(source,before);
  }
});
