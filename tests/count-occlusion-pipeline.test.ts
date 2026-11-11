import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {alignCardBorders} from '../src/features/card-scanner/acquisition/card-borders';
import {integerCropPixels} from '../src/features/card-scanner/acquisition/integer-crop-pixels';
import {inspectCapture} from '../src/features/card-scanner/acquisition/capture-quality';
import {hasNamePixels} from '../src/features/card-scanner/recognition/name-pattern';
import {prepareContrastPattern} from '../src/features/card-scanner/recognition/count-pattern';
import {inspectVisual,readVisual} from '../src/features/card-scanner/recognition/visual-fields';
import type {Raster,RasterContext} from '../src/features/card-scanner/acquisition/acquisition-raster';
const fixtures=JSON.parse(await readFile('tests/fixtures/border-integrity-samples.json','utf8'));
const patterns=JSON.parse(await readFile('public/scanner/counter-patterns.json','utf8')).patterns.map(prepareContrastPattern);
const stars=JSON.parse(await readFile('public/scanner/stars.json','utf8'));

// Sample groups below are selected using the current reader's output, not
// independently verified card counts. These tests check behavior under the
// specified coverings, not correctness of the original reads.
test('opaque icon-only covering cannot certify an originally read zero or turn a positive read into zero',()=>{
  let positive=0,zero=0;
  for(const sample of fixtures.filter((s:{intact:boolean})=>s.intact)){
    const pixels=new Uint8ClampedArray(Buffer.from(sample.rgba,'base64'));
    const borders=alignCardBorders(pixels,sample.width,sample.height,sample.box);
    const read=(data:Uint8ClampedArray)=>{
      const quality=inspectCapture(data,140,210,true,hasNamePixels(data,(14*140+6)*4,140),borders.intact,borders.alignment>=.8);
      const context={drawImage(){},getImageData(x:number,y:number,width:number,height:number){
        return {data:integerCropPixels(data,140,210,{x,y,width,height})!};
      }} as unknown as RasterContext;
      const fields=inspectVisual({} as Raster,context,[stars.gray[0],stars.gold[0]]);
      return {fields,quality,value:readVisual({} as Raster,context,fields,patterns)};
    };
    const crop=integerCropPixels(pixels,sample.width,sample.height,borders.content)!;
    const before=read(crop),covered=crop.slice();
    assert.equal(before.quality.usable,true,sample.name);
    for(let y=141;y<172;y++)for(let x=56;x<90;x++)covered.set([0,0,0,255],((y+before.fields.offsetY)*140+x)*4);
    const after=read(covered);
    assert.equal(after.quality.usable,true,sample.name);
    if(before.value.extraCopies!==null&&before.value.extraCopies>0){
      positive++;assert.notEqual(after.value.extraCopies,0,sample.name);
      if(after.value.extraCopies!==null)assert.equal(after.value.extraCopies,before.value.extraCopies,sample.name);
    }
    if(before.value.extraCopies===0){
      zero++;
      // Five jewels independently imply no remaining copies; other cards
      // cannot infer zero from an icon hidden by an opaque covering.
      assert.equal(after.value.extraCopies,before.fields.awakening===5?0:null,sample.name);
    }
  }
  assert.ok(positive>=3);assert.ok(zero>=2);
});

test('field coverings remain unknown for crops originally read as positive',()=>{
 let positives=0;
 for(const sample of fixtures.filter((s:{intact:boolean})=>s.intact)){
  const pixels=new Uint8ClampedArray(Buffer.from(sample.rgba,'base64'));
  const borders=alignCardBorders(pixels,sample.width,sample.height,sample.box);
  const original=integerCropPixels(pixels,sample.width,sample.height,borders.content)!;
  const read=(data:Uint8ClampedArray)=>{
   const quality=inspectCapture(data,140,210,true,hasNamePixels(data,(14*140+6)*4,140),borders.intact,borders.alignment>=.8);
   const context={drawImage(){},getImageData(x:number,y:number,width:number,height:number){return {data:integerCropPixels(data,140,210,{x,y,width,height})!};}} as unknown as RasterContext;
   const fields=inspectVisual({} as Raster,context,[stars.gray[0],stars.gold[0]]);
   return {fields,quality,value:readVisual({} as Raster,context,fields,patterns)};
  };
  const before=read(original);
  if(before.value.extraCopies===null||before.value.extraCopies<=0)continue;
  positives++;
  for(const variant of ['black','gray','bright','checker','gradient','alpha'] as const){
   const covered=original.slice();
   for(let y=141;y<172;y++)for(let x=56;x<139;x++){
    const shade=variant==='black'?0:variant==='gray'?125:variant==='bright'?200:
      variant==='checker'?64+(x+y)%2*4:variant==='gradient'?64+Math.floor((x-56)*13/82):64;
    covered.set([shade,shade,shade,variant==='alpha'?254:255],((y+before.fields.offsetY)*140+x)*4);
   }
   const after=read(covered);
   assert.equal(after.quality.usable,true,'outer-card quality alone cannot rule out this covering');
   assert.equal(after.fields.hasIcon,null,`${sample.name}: field covering ${variant}`);
   assert.equal(after.value.extraCopies,null,`${sample.name}: covering cannot prove zero`);
  }
 }
 assert.ok(positives>=3,'test requires multiple crops originally read as positive');
});

// This extends the single-strip counterexample to intact card crops and the
// normal visual pipeline. The starting values are reader output, not human
// ground truth; the checkerboard is synthetic and not a recorded tooltip.
// Keep the known failure visible rather than treating an accepted zero as safe.
test('high-contrast textured coverings must not turn originally positive card crops into zero',()=>{
 let positives=0;const falseZeros:string[]=[];
 for(const sample of fixtures.filter((s:{intact:boolean})=>s.intact)){
  const pixels=new Uint8ClampedArray(Buffer.from(sample.rgba,'base64'));
  const borders=alignCardBorders(pixels,sample.width,sample.height,sample.box);
  const original=integerCropPixels(pixels,sample.width,sample.height,borders.content)!;
  const read=(data:Uint8ClampedArray)=>{
   const context={drawImage(){},getImageData(x:number,y:number,width:number,height:number){return {data:integerCropPixels(data,140,210,{x,y,width,height})!};}} as unknown as RasterContext;
   const fields=inspectVisual({} as Raster,context,[stars.gray[0],stars.gold[0]]);
   return {fields,value:readVisual({} as Raster,context,fields,patterns)};
  };
  const before=read(original);
  if(before.value.extraCopies===null||before.value.extraCopies<=0)continue;
  positives++;
  for(const contrast of [40,80]){
   const covered=original.slice();
   for(let y=141;y<172;y++)for(let x=56;x<139;x++){
    const shade=(x+y)%2?0:contrast;
    covered.set([shade,shade,shade,255],((y+before.fields.offsetY)*140+x)*4);
   }
   if(read(covered).value.extraCopies===0)falseZeros.push(`${sample.name}/${contrast}`);
  }
 }
 assert.ok(positives>=3,'test requires multiple crops originally read as positive');
 assert.deepEqual(falseZeros,[],'synthetic coverage must not establish a zero count');
});
