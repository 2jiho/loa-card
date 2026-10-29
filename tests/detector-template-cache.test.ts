import test from 'node:test';
import assert from 'node:assert/strict';
import {createDetectorTemplateCache} from '../src/features/card-scanner/detector-template-cache';

function setup(bytes=100,entries=2){
  const made:{width:number;height:number;deleted:number;delete():void}[]=[];
  const cache=createDetectorTemplateCache((width,height)=>{
    const value={width,height,deleted:0,delete(){this.deleted++;}};made.push(value);return value;
  },bytes,entries);
  return {cache,made};
}
test('same integer dimensions reuse a derivative; LRU eviction releases one allocation',()=>{
  const {cache,made}=setup();
  const a=cache.acquire(5,5);a.release();cache.acquire(4,4).release();
  assert.equal(cache.acquire(5,5).value,a.value);
  cache.acquire(3,3).release();assert.equal(made[1].deleted,1);assert.equal(made[0].deleted,0);
  cache.dispose();cache.dispose();assert.ok(made.every(value=>value.deleted===1));
});
test('byte bound and oversized ephemeral leases do not grow retained memory',()=>{
  const {cache,made}=setup(30,10);
  cache.acquire(5,5).release();cache.acquire(3,3).release();assert.equal(made[0].deleted,1);
  const large=cache.acquire(10,10);assert.equal(made[1].deleted,0);
  large.release();large.release();assert.equal(large.value.deleted,1);
  cache.dispose();assert.ok(made.every(value=>value.deleted===1));
});
test('invalid dimensions and failed creation do not evict a valid cached template',()=>{
  let calls=0;
  const good={delete(){}};
  const cache=createDetectorTemplateCache((width)=>{calls++;if(width===2)throw Error('resize failed');return good;},10,1);
  cache.acquire(1,1);
  assert.throws(()=>cache.acquire(2,2),/resize failed/);
  assert.equal(cache.acquire(1,1).value,good);assert.equal(calls,2);
  for(const width of [0,-1,NaN,1.5,Infinity])assert.throws(()=>cache.acquire(width,1),/size/);
  assert.equal(calls,2);cache.dispose();
});
