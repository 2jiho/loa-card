import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {alignCardBorders} from '../src/features/card-scanner/card-borders';
import {integerCropPixels} from '../src/features/card-scanner/integer-crop-pixels';
import {inspectCapture} from '../src/features/card-scanner/capture-quality';
import {hasNamePixels} from '../src/features/card-scanner/name-pattern';
import {prepareContrastPattern} from '../src/features/card-scanner/count-pattern';
import {inspectVisual,readVisual} from '../src/features/card-scanner/visual-fields';
import type {Raster,RasterContext} from '../src/features/card-scanner/acquisition-raster';
const fixtures=JSON.parse(await readFile('tests/fixtures/border-integrity-samples.json','utf8'));
const patterns=JSON.parse(await readFile('public/scanner/counter-patterns.json','utf8')).patterns.map(prepareContrastPattern);
const stars=JSON.parse(await readFile('public/scanner/stars.json','utf8'));

test('intact public crops retain valid zero counts and never turn icon-only occlusion into a false zero',()=>{
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
    if(before.value.extraCopies===0){zero++;assert.equal(after.value.extraCopies,0,sample.name);}
  }
  assert.ok(positive>=3);assert.ok(zero>=2);
});
