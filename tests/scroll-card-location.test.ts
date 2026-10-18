import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scrollCardLocation,scrollLocationLabel,estimateScrollRows} from '../src/features/card-scanner/scroll-card-location';
test('top, bottom, column and row follow current thumb geometry without assuming inventory count',()=>{
  assert.deepEqual(scrollCardLocation({position:0,pageSpan:4/35},0,true),{percent:0,column:1,row:1});
  assert.deepEqual(scrollCardLocation({position:1,pageSpan:4/35},39,true),{percent:100,column:10,row:39});
  assert.equal(scrollCardLocation({position:1,pageSpan:4/10},20,true)?.row,13);
});
test('55 total rows have 51 steps and 52 distinct viewport positions',()=>{
 const pageSpan=4/51;
 assert.equal(estimateScrollRows({pageSpan}),55);
 for(let step=0;step<=51;step++) {
   assert.equal(scrollCardLocation({position:step/51,pageSpan},0,true)?.row,step+1);
   assert.equal(scrollCardLocation({position:step/51,pageSpan},39,true)?.row,step+4);
 }
 assert.equal(estimateScrollRows({pageSpan:4/55}),undefined); // More than the 550-slot capacity is not credible.
 assert.equal(estimateScrollRows({pageSpan:4/51.5}),55);
});
test('moving, half-row and ambiguous geometry never claim an exact row',()=>{
  assert.equal(scrollCardLocation({position:.5,pageSpan:4/35},0,true)?.row,undefined);
  assert.equal(scrollCardLocation({position:1,pageSpan:4/35},0,false)?.row,undefined);
  assert.equal(scrollCardLocation({position:1,pageSpan:4/35.5},0,true)?.row,undefined);
  assert.equal(scrollCardLocation(null,0,true),undefined);
  assert.equal(scrollCardLocation({position:NaN,pageSpan:.1},0,true),undefined);
  assert.match(scrollLocationLabel(scrollCardLocation({position:.5,pageSpan:4/35},13,false)),/50%.*4열/);
});
