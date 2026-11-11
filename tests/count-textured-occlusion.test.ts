import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {matchCountPattern,packCount,prepareContrastPattern} from '../src/features/card-scanner/recognition/count-pattern';
import {readVisual} from '../src/features/card-scanner/recognition/visual-fields';
import {currentCountReliability} from '../src/features/card-scanner/recognition/count-confidence';
import type {Raster,RasterContext} from '../src/features/card-scanner/acquisition/acquisition-raster';

// The positive strip comes from the same video as the atlas construction. It
// proves this input was a +2 before mutation, not independent accuracy. The
// checkerboard cover is synthetic; it is not a recorded cursor or tooltip.
test('textured opaque cover on a positive counter cannot certify zero',async()=>{
 const samples=JSON.parse(await readFile('tests/fixtures/counter-samples.json','utf8')) as {name:string;value:number;rgba:string}[];
 const atlas=JSON.parse(await readFile('public/scanner/counter-patterns.json','utf8'));
 const patterns=atlas.patterns.map(prepareContrastPattern);
 const sample=samples.find(entry=>entry.value===2);
 assert.ok(sample,'positive +2 regression strip is required');
 const image=new Uint8Array(140*210*4);
 for(let y=0;y<210;y++)for(let x=0;x<140;x++)image.set([30,30,30,255],(y*140+x)*4);
 const strip=Buffer.from(sample.rgba,'base64');
 assert.equal(strip.length,86*25*4);
 for(let y=0;y<25;y++)image.set(strip.subarray(y*86*4,(y+1)*86*4),((141+y)*140+54)*4);
 assert.equal(matchCountPattern(image,patterns).value,2,'the unobscured source contains +2');
 // Mask only the counter's UI area, keeping the outside card pixels unchanged.
 for(let y=141;y<172;y++)for(let x=56;x<139;x++){
  const value=(x+y)%2?75:50;image.set([value,value,value,255],(y*140+x)*4);
 }
 const packed=packCount(image);
 assert.equal(packed.hasIcon,null,'the covered counter must stay unknown');
 const context={drawImage(){},getImageData(){return {data:image};}} as unknown as RasterContext;
 const fields={awakening:0,hasIcon:packed.hasIcon,offsetY:0,labelPixels:100,blankName:false,hasNameBand:true};
 const result=readVisual({} as Raster,context,fields,patterns);
 assert.equal(result.extraCopies,null,'the covered counter must not produce any number');
 assert.equal(currentCountReliability({stable:false,borderAlignment:.95,awakening:0,
  extraCopies:result.extraCopies,pattern:result.countDiagnostics?.pattern,
  iconPresent:result.countDiagnostics?.iconPresent}),'unconfirmed');
});

