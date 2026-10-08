import {test} from 'node:test';import assert from 'node:assert/strict';
import {observationPixels} from '../src/features/card-scanner/observation-pixels';
import {sameCapture} from '../src/features/card-scanner/capture-quality';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

test('cached geometry preserves the pre-optimization bytes across scales and eviction',()=>{
 const cases=JSON.parse(readFileSync(new URL('./fixtures/observation-plans.json',import.meta.url),'utf8'));
 for(const sample of [...cases,...cases.slice(0,5)]) {
  const {width,height}=sample;let n=sample.seed;
  const rgba=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<rgba.length;i++){n=(Math.imul(n,1664525)+1013904223)>>>0;rgba[i]=i%4===3?255:n>>>24;}
  for(let repeat=0;repeat<2;repeat++){
   const result=observationPixels(rgba,width,height);
   // Digests come from the stored pre-optimization bytes, never this implementation.
   assert.equal(createHash('sha256').update(result.art).digest('hex'),sample.artSha256,`${width}/${height} art`);
   assert.equal(createHash('sha256').update(result.feature).digest('hex'),sample.featureSha256,`${width}/${height} fields`);
  }
 }
});
test('area features preserve colors and independent name/count/jewel regions',()=>{
 const rgba=new Uint8ClampedArray(140*210*4);
 for(let i=0;i<rgba.length;i+=4)rgba.set([30,60,90,255],i);
 const a=observationPixels(rgba,140,210);
 assert.equal(a.art.length,648);assert.equal(a.feature.length,3240);
 for(let i=0;i<a.feature.length;i++)assert.equal(a.feature[i],[30,60,90][i%3]);
 for(let y=144;y<163;y++)for(let x=96;x<135;x++)rgba.set([230,230,230,255],(y*140+x)*4);
 const b=observationPixels(rgba,140,210);
 assert.deepEqual(a.feature.slice(0,864),b.feature.slice(0,864));
 assert.deepEqual(a.feature.slice(2016,2592),b.feature.slice(2016,2592));
 assert.equal(sameCapture(a.feature,b.feature),false);
});
