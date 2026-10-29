import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordingInputRaster,recordingInputBytes} from '../src/features/card-scanner/recording-input-raster';

test('recording conversion uses the same 2D source/coordinates and preserves expected RGBA bytes for bitmap and VideoFrame shapes',()=>{
 const expected=Uint8ClampedArray.from([1,2,3,255,45,67,89,255,4,5,6,255,200,190,180,255]);
 const requests:any[]=[],draws:any[]=[];let allocations=0,closed=0;
 const canvas={width:2,height:2,getContext:(kind:string,options:unknown)=>{requests.push([kind,options]);return {
  drawImage:(...args:unknown[])=>draws.push(args),getImageData:(...args:unknown[])=>{assert.deepEqual(args,[0,0,2,2]);return {data:expected};},
 };}};
 const raster=createRecordingInputRaster((width,height)=>{allocations++;assert.deepEqual([width,height],[2,2]);return canvas as unknown as OffscreenCanvas;});
 const bitmap={width:2,height:2,close(){closed++;}} as unknown as ImageBitmap;
 assert.deepEqual([...raster.read({width:2,height:2,bitmap})],[...expected]);
 const frame={displayWidth:2,displayHeight:2,close(){closed++;}} as unknown as VideoFrame;
 assert.deepEqual([...raster.read({width:2,height:2,bitmap:frame})],[...expected]);
 assert.deepEqual(requests,[['2d',{willReadFrequently:true}]]);assert.deepEqual(draws,[[bitmap,0,0],[frame,0,0]]);assert.equal(allocations,1);assert.equal(closed,0,'worker queue owns the sole close');
});

test('legacy RGBA bytes remain supported while inconsistent source sizes fail before raster allocation',()=>{
 const raster=createRecordingInputRaster(()=>assert.fail('legacy or invalid input must not allocate a canvas'));
 const pixels=Uint8Array.from([10,20,30,255]).buffer;assert.deepEqual([...raster.read({width:1,height:1,pixels})],[10,20,30,255]);
 assert.throws(()=>raster.read({width:1,height:2,pixels}),/크기/);
 assert.throws(()=>raster.read({width:1,height:1,bitmap:{width:2,height:1} as ImageBitmap}),/원본 크기/);
 for(const width of [0,-1,NaN,Infinity,1.5,100000])assert.throws(()=>recordingInputBytes({width,height:100000}));
});

test('a transparent later input replaces the previous frame instead of accumulating source-over alpha',()=>{
 let current=Uint8ClampedArray.from([0,0,0,0]);
 const context={globalCompositeOperation:'source-over',drawImage(bitmap:{rgba:Uint8ClampedArray}){
  const source=bitmap.rgba;
  if(this.globalCompositeOperation==='copy')current=source.slice();
  else {const a=source[3]/255,b=current[3]/255,next=a+b*(1-a);current=Uint8ClampedArray.from([
   (source[0]*a+current[0]*b*(1-a))/next,(source[1]*a+current[1]*b*(1-a))/next,
   (source[2]*a+current[2]*b*(1-a))/next,next*255,
  ]);}
 },getImageData(){return {data:current.slice()};}};
 const raster=createRecordingInputRaster(()=>({width:1,height:1,getContext:()=>context}) as unknown as OffscreenCanvas);
 const bitmap=(rgba:number[])=>({width:1,height:1,rgba:Uint8ClampedArray.from(rgba)}) as unknown as ImageBitmap;
 assert.deepEqual([...raster.read({width:1,height:1,bitmap:bitmap([255,0,0,128])})],[255,0,0,128]);
 assert.deepEqual([...raster.read({width:1,height:1,bitmap:bitmap([0,0,255,128])})],[0,0,255,128]);
 assert.deepEqual([...raster.read({width:1,height:1,bitmap:bitmap([0,0,0,0])})],[0,0,0,0]);
});
