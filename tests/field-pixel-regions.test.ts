import test from 'node:test';
import assert from 'node:assert/strict';
import {fieldPixelRegions} from '../src/features/card-scanner/field-pixel-regions';

test('integer unscaled fields cover the full name, count and awakening ROIs',()=>{
 const content={x:6,y:6,width:140,height:210},before={...content};
 assert.deepEqual(fieldPixelRegions(content,152,222),[
  {x:12,y:20,width:128,height:36},{x:62,y:147,width:82,height:31},{x:20,y:182,width:112,height:24},
 ]);
 assert.deepEqual(content,before);
});

test('unknown resampling phases, clipped fields and invalid raster geometry conservatively have no subset mask',()=>{
 const box={x:6,y:6,width:140,height:210};
 for(const content of [{...box,x:6.5},{...box,y:6.5},{...box,width:139},{...box,height:211},{...box,x:-10}])
  assert.equal(fieldPixelRegions(content,152,222),undefined);
 for(const [width,height] of [[0,222],[152,0],[143,222],[152,205],[152.5,222]])
  assert.equal(fieldPixelRegions(box,width,height),undefined);
});
