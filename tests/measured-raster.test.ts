import test from 'node:test';
import assert from 'node:assert/strict';
import {opaqueCardPixels,ownedCardRaster,requireMeasuredRaster} from '../src/features/card-scanner/measured-raster';
import {integerCropPixels} from '../src/features/card-scanner/integer-crop-pixels';

test('measured raster borrows only a complete fixed matching readback without copying or granting authority',()=>{
  const data=new Uint8ClampedArray(7*5*4),raster={data,width:7,height:5};
  assert.equal(requireMeasuredRaster(raster,7,5),raster);
  assert.equal(requireMeasuredRaster(raster,7,5).data,data);
  assert.deepEqual(Object.keys(raster),['data','width','height']);
});

test('malformed, detached, shared and resizable measured rasters cannot reach cropping',()=>{
  const data=new Uint8ClampedArray(4*3*4),base={data,width:4,height:3};
  for(const raster of [{...base,width:3},{...base,height:4},{...base,data:new Uint8Array(48)},
    {...base,data:new Uint8ClampedArray(52).subarray(0,48)},{...base,data:new Uint8ClampedArray(52).subarray(4)},
    {...base,data:new Uint8ClampedArray(47)},{...base,data:new Uint8ClampedArray(new SharedArrayBuffer(48))},
    {...base,data:new Uint8ClampedArray(new ArrayBuffer(48,{maxByteLength:96}))}])
    assert.throws(()=>requireMeasuredRaster(raster as never,4,3),/측정 픽셀/);
  for(const [width,height]of [[0,3],[-1,3],[4.5,3],[4,NaN],[Infinity,3]])
    assert.throws(()=>requireMeasuredRaster(base,width,height),/측정 픽셀/);
  structuredClone(data,{transfer:[data.buffer]});assert.throws(()=>requireMeasuredRaster(base,4,3),/측정 픽셀/);
});

test('owned crop transport detaches independently while the complete measured raster remains readable',()=>{
  const full=Uint8ClampedArray.from({length:7*5*4},(_,i)=>i%4===3?255:i%251),before=full.slice();
  const crop=integerCropPixels(full,7,5,{x:1,y:2,width:4,height:2})!;
  assert.equal(opaqueCardPixels(crop),true);
  const raster=ownedCardRaster(crop,4,2),snapshot=crop.slice(),moved=structuredClone(raster,{transfer:[raster.data.buffer]});
  assert.equal(crop.byteLength,0);assert.deepEqual(moved.data,snapshot);assert.deepEqual(full,before);
  assert.equal(requireMeasuredRaster({width:7,height:5,data:full},7,5).data.byteLength,140);
});

test('nonopaque pixels keep the Canvas transport fallback eligible even when RGB looks unchanged',()=>{
  const data=new Uint8ClampedArray([1,2,3,255,1,2,3,255]);
  for(const alpha of [0,1,128,254]){data[7]=alpha;assert.equal(opaqueCardPixels(data),false);}
  data[7]=255;assert.equal(opaqueCardPixels(data),true);
});
