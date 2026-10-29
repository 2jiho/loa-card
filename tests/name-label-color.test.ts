import test from 'node:test';
import assert from 'node:assert/strict';
import {NAME_LABEL_COLOR_VARIANTS,nameLabelColor} from '../dev/name-label-color';
import type {NameLabelColorVariant} from '../dev/name-label-color';

const FIRST_PIXELS=128*18,TOTAL_PIXELS=128*36;
function raster(r=150,g=r,b=r){
  const data=new Uint8ClampedArray(TOTAL_PIXELS*4);
  for(let i=0;i<TOTAL_PIXELS;i++)pixel(data,i,r,g,b);
  return data;
}
function pixel(data:Uint8ClampedArray,index:number,r:number,g=r,b=r){data.set([r,g,b,255],index*4);}
const value=(data:Uint8ClampedArray,index:number)=>data[index*4];

test('chroma renders colored glyphs dark against neutral bright backgrounds without using brightness as chroma',()=>{
  const source=raster(250);
  for(let i=100;i<200;i++)pixel(source,i,230,160,80);
  pixel(source,300,30);pixel(source,301,150);
  const {data,recipe}=nameLabelColor(source,'chroma-first-v1');
  assert.equal(value(data,0),255);assert.equal(value(data,150),0);
  assert.equal(value(data,300),255);assert.equal(value(data,301),255);
  assert.deepEqual([recipe.lowScalar,recipe.highScalar],[0,150]);
  assert.equal(recipe.scalar,'max(R,G,B)-min(R,G,B)');assert.equal(recipe.inversion,'255-normalized');
});

test('achromatic labels stay flat under chroma and flat channel labels preserve their original scalars',()=>{
  const source=raster();
  for(let i=0;i<FIRST_PIXELS;i++)pixel(source,i,i%256);
  const chroma=nameLabelColor(source,'chroma-first-v1');
  assert.ok(chroma.data.every((entry,index)=>entry===(index%4===3?255:255)));
  assert.deepEqual([chroma.recipe.lowScalar,chroma.recipe.highScalar],[0,0]);
  for(const variant of NAME_LABEL_COLOR_VARIANTS){
    const {data,recipe}=nameLabelColor(raster(12,34,56),variant);
    const expected=variant==='chroma-first-v1'?211:variant==='red-first-v1'?12:variant==='green-first-v1'?34:56;
    assert.ok(data.every((entry,index)=>entry===(index%4===3?255:expected)));
    assert.equal(recipe.lowScalar,recipe.highScalar);assert.match(recipe.flatPolicy,/retain scalar/);
  }
});

test('RGB variants select exactly their channel, ignore the other channels and never invert',()=>{
  for(const [variant,channel] of [['red-first-v1',0],['green-first-v1',1],['blue-first-v1',2]] as const){
    const source=raster(),other=raster();
    for(let i=0;i<FIRST_PIXELS;i++)for(let c=0;c<3;c++){
      source[i*4+c]=c===channel?i%256:(i*17+c*31)%256;
      other[i*4+c]=c===channel?i%256:(i*73+c*19)%256;
    }
    const first=nameLabelColor(source,variant),second=nameLabelColor(other,variant);
    assert.deepEqual(first,second);assert.equal(first.recipe.inversion,'none');
    assert.deepEqual([first.recipe.lowScalar,first.recipe.highScalar],[2,253]);
    assert.equal(value(first.data,0),0);assert.equal(value(first.data,2),0);
    assert.equal(value(first.data,128),128);assert.equal(value(first.data,253),255);assert.equal(value(first.data,255),255);
  }
});

test('exact percentile ranks reject extremum outliers and stretch with rounding and saturation',()=>{
  for(const variant of NAME_LABEL_COLOR_VARIANTS){
    const source=raster(150);
    const setScalar=(index:number,scalar:number)=>variant==='chroma-first-v1'?pixel(source,index,scalar,0,0):pixel(source,index,scalar);
    if(variant==='chroma-first-v1')for(let i=0;i<FIRST_PIXELS;i++)setScalar(i,150);
    setScalar(0,0);setScalar(FIRST_PIXELS-1,255);
    for(let i=1;i<=50;i++)setScalar(i,100);
    for(let i=FIRST_PIXELS-51;i<FIRST_PIXELS-1;i++)setScalar(i,200);
    const {data,recipe}=nameLabelColor(source,variant),invert=variant==='chroma-first-v1';
    assert.deepEqual([recipe.lowRank,recipe.highRank,recipe.lowScalar,recipe.highScalar],[23,2280,100,200]);
    assert.equal(value(data,0),invert?255:0);assert.equal(value(data,1),invert?255:0);
    // Normalize and round first: 127.5 ->128; chroma then inverts to127.
    assert.equal(value(data,100),invert?127:128);assert.equal(value(data,FIRST_PIXELS-2),invert?0:255);
    assert.equal(value(data,FIRST_PIXELS-1),invert?0:255);
  }
});

test('source including its second line is untouched and unused second-line colors cannot affect output',()=>{
  const source=raster(220,190,150);pixel(source,400,120,140,160);const before=source.slice();
  for(const variant of NAME_LABEL_COLOR_VARIANTS){
    const first=nameLabelColor(source,variant),other=source.slice();
    for(let i=FIRST_PIXELS;i<TOTAL_PIXELS;i++)pixel(other,i,i%256,(i*7)%256,(i*29)%256);
    assert.deepEqual(nameLabelColor(other,variant),first);assert.deepEqual(source,before);
    assert.equal(first.width,128);assert.equal(first.height,18);assert.equal(first.data.length,FIRST_PIXELS*4);
    assert.ok(first.data.buffer instanceof ArrayBuffer);assert.notEqual(first.data.buffer,source.buffer);
    assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(first.recipe));assert.ok(Object.isFrozen(first.recipe.sourceBox));
    first.data.fill(0);assert.deepEqual(source,before);
  }
});

test('all fixed recipes are deterministic and preserve typed-array view boundaries',()=>{
  const backing=new Uint8ClampedArray(TOTAL_PIXELS*4+32);backing.fill(17);
  const source=backing.subarray(16,16+TOTAL_PIXELS*4);
  for(let i=0;i<TOTAL_PIXELS;i++)pixel(source,i,(i*17)%256,(i*31)%256,(i*71)%256);
  assert.ok(Object.isFrozen(NAME_LABEL_COLOR_VARIANTS));
  assert.deepEqual(NAME_LABEL_COLOR_VARIANTS,['chroma-first-v1','red-first-v1','green-first-v1','blue-first-v1']);
  for(const variant of NAME_LABEL_COLOR_VARIANTS){
    const first=nameLabelColor(source,variant),second=nameLabelColor(source,variant);
    assert.deepEqual(first,second);assert.notEqual(first.data.buffer,second.data.buffer);
    for(let i=0;i<first.data.length;i+=4){
      assert.equal(first.data[i],first.data[i+1]);assert.equal(first.data[i],first.data[i+2]);assert.equal(first.data[i+3],255);
    }
    assert.deepEqual(first.recipe.sourceBox,{x:0,y:0,width:128,height:18});
    assert.equal(first.recipe.sampleCount,2304);assert.equal(first.recipe.lowQuantile,.01);assert.equal(first.recipe.highQuantile,.99);
  }
  assert.ok(backing.subarray(0,16).every(entry=>entry===17));assert.ok(backing.subarray(backing.length-16).every(entry=>entry===17));
});

test('invalid shape, array type, variant and every nonopaque alpha location are rejected without mutation',()=>{
  for(const source of [new Uint8ClampedArray(),new Uint8ClampedArray(128*18*4),new Uint8ClampedArray(TOTAL_PIXELS*4+4)]){
    const before=source.slice();assert.throws(()=>nameLabelColor(source,'chroma-first-v1'),/128x36 RGBA/);assert.deepEqual(source,before);
  }
  for(const source of [null,[],new Uint8Array(TOTAL_PIXELS*4)])
    assert.throws(()=>nameLabelColor(source as unknown as Uint8ClampedArray,'red-first-v1'),/128x36 RGBA/);
  const good=raster();assert.throws(()=>nameLabelColor(good,'other' as NameLabelColorVariant),/Unsupported/);
  for(const index of [0,FIRST_PIXELS-1,FIRST_PIXELS,TOTAL_PIXELS-1])for(const alpha of [0,128,254]){
    const source=raster();source[index*4+3]=alpha;const before=source.slice();
    for(const variant of NAME_LABEL_COLOR_VARIANTS)assert.throws(()=>nameLabelColor(source,variant),/opaque/);
    assert.deepEqual(source,before);
  }
});
