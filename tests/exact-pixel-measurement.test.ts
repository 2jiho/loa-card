import test from 'node:test';
import assert from 'node:assert/strict';
import {ExactPixelCache} from '../src/features/card-scanner/acquisition/exact-pixel-cache';

test('diagnostic comparison has identical results to ordinary exact lookup',()=>{
 const cache=new ExactPixelCache<{id:number}>(),value={id:1};
 const source=Uint8ClampedArray.from({length:40},(_,index)=>index*5);
 cache.set(2,'geometry',source,value);
 for(const offset of [0,1])for(const changed of [-1,0,1,3,4,19,39]){
  const buffer=new ArrayBuffer(40+offset),candidate=new Uint8ClampedArray(buffer,offset,40);
  candidate.set(source);if(changed>=0)candidate[changed]^=1;
  const ordinary=cache.get(2,'geometry',candidate),measured=cache.getMeasured(2,'geometry',candidate);
  assert.equal(measured.value,ordinary,`offset ${offset}, differing byte ${changed}`);
  assert.equal(measured.eligible,true);
  const expected=changed<0?40:offset===0?(Math.floor(changed/4)+1)*4:changed+1;
  assert.equal(measured.bytesCompared,expected);
 }
 for(const [slot,key,candidate] of [[3,'geometry',source],[2,'other',source],[2,'geometry',new Uint8ClampedArray(39)]] as const){
  assert.equal(cache.getMeasured(slot,key,candidate).value,cache.get(slot,key,candidate));
  assert.deepEqual(cache.getMeasured(slot,key,candidate),{value:undefined,bytesCompared:0,eligible:false});
 }
 assert.deepEqual(cache.get(2,'geometry',source),value,'measurements never mutate cached pixels');
});
