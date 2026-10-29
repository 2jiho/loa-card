import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inspectVisual,readVisual,reusableVisualPixels} from '../src/features/card-scanner/visual-fields';
import {pixelRegion} from '../src/features/card-scanner/pixel-region';
import {prepareContrastPattern} from '../src/features/card-scanner/count-pattern';
import type {Raster,RasterContext} from '../src/features/card-scanner/acquisition-raster';

test('only native-size fully opaque inputs permit visual readback reuse',()=>{
  const pixels=new Uint8ClampedArray(140*210*4).fill(255);
  assert.equal(reusableVisualPixels(pixels,140,210),pixels);
  assert.equal(reusableVisualPixels(pixels,210,140),undefined);
  assert.equal(reusableVisualPixels(pixels.subarray(4),140,210),undefined);
  pixels[pixels.length-1]=254;assert.equal(reusableVisualPixels(pixels,140,210),undefined);
});

test('shared pixels preserve jewel fixture inspection and count results without extra canvas reads',async()=>{
  const stars=JSON.parse(await readFile('public/scanner/stars.json','utf8'));
  const patterns=JSON.parse(await readFile('public/scanner/counter-patterns.json','utf8')).patterns.map(prepareContrastPattern);
  const samples=JSON.parse(await readFile('tests/fixtures/star-samples.json','utf8'));
  for(const sample of samples){
    const pixels=new Uint8ClampedArray(140*210*4);
    pixels.set(Buffer.from(sample.rgba,'base64'),176*140*4);
    for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
    let reads=0,draws=0;
    const context={drawImage(){draws++;},getImageData(x:number,y:number,w:number,h:number){
      reads++;return pixelRegion({data:pixels,width:140,height:210},x,y,w,h)!;
    }} as unknown as RasterContext;
    const canvas={} as Raster,templates=[stars.gray[0],stars.gold[0]];
    const legacyFields=inspectVisual(canvas,context,templates);
    const legacyValues=readVisual(canvas,context,legacyFields,patterns);
    assert.ok(reads>=2);assert.ok(draws>=1);
    const priorReads=reads,priorDraws=draws,snapshot=reusableVisualPixels(pixels,140,210)!;
    const fields=inspectVisual(canvas,context,templates,snapshot);
    assert.deepEqual(fields,legacyFields,sample.name);
    assert.deepEqual(readVisual(canvas,context,fields,patterns,undefined,snapshot),legacyValues,sample.name);
    assert.equal(reads,priorReads);assert.equal(draws,priorDraws);
    // Exercise positive-counter/uncertain and full-awakening branches as well.
    for(const awakening of [null,0,4,5]){
      const forced={...fields,awakening,hasIcon:true};
      const expected=readVisual(canvas,context,forced,patterns);
      const before=reads;
      assert.deepEqual(readVisual(canvas,context,forced,patterns,undefined,snapshot),expected);
      assert.equal(reads,before);
    }
  }
});
