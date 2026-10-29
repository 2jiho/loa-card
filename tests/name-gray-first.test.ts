import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NAME_GRAY_FIRST_RECIPE,createGrayNameFirstLine} from '../src/features/card-scanner/name-gray-first';

const pixels=()=>new Uint8ClampedArray(128*36*4);

test('gray first-line recipe uses rounded RGB luminance and preserves actual alpha',()=>{
  assert.equal(NAME_GRAY_FIRST_RECIPE,'gray-first-line-v1');
  const input=pixels();
  input.set([255,0,0,0, 0,255,0,7, 0,0,255,128, 255,255,255,255, 0,0,0,31, 0,0,250,211]);
  const result=createGrayNameFirstLine(input);
  assert.deepEqual(Array.from(result.slice(0,24)),[
    76,76,76,0, 150,150,150,7, 29,29,29,128, 255,255,255,255, 0,0,0,31, 29,29,29,211,
  ]);
});

test('only the first eighteen rows become an independently owned raster',()=>{
  const input=pixels(),last=(128*18-1)*4;
  input.set([11,27,83,41],0);input.set([200,100,50,67],last);
  input.fill(255,128*18*4);const before=input.slice();
  const output=createGrayNameFirstLine(input);
  assert.equal(output.length,128*18*4);assert.ok(output.buffer instanceof ArrayBuffer);
  assert.notEqual(output.buffer,input.buffer);assert.deepEqual(input,before);
  assert.deepEqual(Array.from(output.slice(0,4)),[29,29,29,41]);
  assert.deepEqual(Array.from(output.slice(last,last+4)),[124,124,124,67]);
  input.fill(3);assert.deepEqual(Array.from(output.slice(0,4)),[29,29,29,41]);
  output.fill(9);assert.ok(input.every(value=>value===3));
});

test('a valid view reads its own bytes rather than assuming buffer offset zero',()=>{
  const backing=new Uint8ClampedArray(128*36*4+16),input=backing.subarray(8,8+128*36*4);
  backing.fill(250);input.set([12,34,56,78]);
  assert.deepEqual(Array.from(createGrayNameFirstLine(input).slice(0,4)),[30,30,30,78]);
});

test('the initial fixed RGBA shape is mandatory and invalid inputs are untouched',()=>{
  for (const input of [new Uint8ClampedArray(),new Uint8ClampedArray(128*18*4),new Uint8ClampedArray(128*36*4-1),new Uint8ClampedArray(128*36*4+4)]) {
    const before=input.slice();assert.throws(()=>createGrayNameFirstLine(input),/128x36 RGBA/);assert.deepEqual(input,before);
  }
  for (const input of [null,[],new Uint8Array(128*36*4)])
    assert.throws(()=>createGrayNameFirstLine(input as unknown as Uint8ClampedArray),/128x36 RGBA/);
});
