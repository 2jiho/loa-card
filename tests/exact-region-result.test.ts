import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ExactRegionResult} from '../src/features/card-scanner/exact-region-result';
const region=()=>({width:2,height:1,data:new Uint8ClampedArray([12,34,56,255,78,90,12,255])});
test('all OCR regions and their geometry must match, including one-bit counter or arrow changes',()=>{
 const cache=new ExactRegionResult<{value:number}>(2),regions=[region(),region()];
 assert.equal(cache.get(regions),undefined);cache.set(regions,{value:1});assert.deepEqual(cache.get(regions),{value:1});
 for(let r=0;r<2;r++)for(let b=0;b<8;b++){
  const changed=regions.map(x=>({...x,data:x.data.slice()}));changed[r].data[b]^=1;
  assert.equal(cache.get(changed),undefined);
 }
 assert.equal(cache.get([{...regions[0],width:1,height:2},regions[1]]),undefined);
 assert.equal(cache.get([regions[0]]),undefined);
});
test('cached metadata owns its pixels/results and returned values cannot poison later reads',()=>{
 const cache=new ExactRegionResult<{sort:{direction:string}}>(2),regions=[region(),region()];
 const value={sort:{direction:'asc'}};cache.set(regions,value);value.sort.direction='desc';
 const hit=cache.get(regions)!;assert.equal(hit.sort.direction,'asc');hit.sort.direction='changed';
 assert.equal(cache.get(regions)!.sort.direction,'asc');
 regions[0].data[0]++;assert.equal(cache.get(regions),undefined);
 cache.set(regions,{sort:{direction:'desc'}});assert.equal(cache.get(regions)!.sort.direction,'desc');
});
test('failed fields retry without forcing an unchanged successful field to OCR again',async()=>{
 const points=new ExactRegionResult<{current:number}>(1),sort=new ExactRegionResult<{kind:string}>(1);
 const pointPixels=region(),sortPixels=region();let pointReads=0,sortReads=0;
 const read=()=>Promise.all([
  points.read([pointPixels],async()=>{pointReads++;return pointReads<3?null:{current:7};}),
  sort.read([sortPixels],async()=>{sortReads++;return {kind:'name'};}),
 ]);
 await read();await read();const complete=await read();await read();
 assert.deepEqual(complete,[{current:7},{kind:'name'}]);assert.equal(pointReads,3);assert.equal(sortReads,1);
 pointPixels.data[0]++;await read();assert.equal(pointReads,4);assert.equal(sortReads,1);
 sortPixels.data[7]--;await read();assert.equal(pointReads,4);assert.equal(sortReads,2);
});
