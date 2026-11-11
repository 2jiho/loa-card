import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitLine,parabolaPeak,summarize} from '../dev/grid-fit-math';

test('the parabola peak recovers a fractional position and refuses what is not a peak', () => {
  // Scores of -(x - 0.3)^2 at x = -1, 0, 1: the top is 0.3 right of the middle sample.
  const score=(x:number)=>-((x-.3)**2);
  assert.ok(Math.abs(parabolaPeak(score(-1),score(0),score(1))-.3)<1e-9);
  assert.equal(parabolaPeak(1,1,1),0);                 // flat
  assert.equal(parabolaPeak(2,1,2),0);                 // a valley
  assert.equal(parabolaPeak(null,1,0),0);              // at the edge of the search
  assert.equal(parabolaPeak(0,1,1),.5);                // never further than half a step
});

test('a line through grid positions gives the origin and the pitch, also with cells missing', () => {
  const columns=[0,1,2,4,7,9].map(index=>({index,value:138+index*472/3}));
  const fit=fitLine(columns);
  assert.ok(Math.abs(fit.step-472/3)<1e-9);
  assert.ok(Math.abs(fit.origin-138)<1e-9);
  // Rows rounded to whole pixels still give the pitch closely.
  const rows=[393,636,878,1121].map((value,index)=>({index,value}));
  assert.ok(Math.abs(fitLine(rows).step-728/3)<.1);
  assert.deepEqual(fitLine([{index:3,value:50},{index:3,value:52}]),{origin:51,step:0});
  assert.deepEqual(fitLine([]),{origin:0,step:0});
});

test('summarize gives mean and spread', () => {
  assert.deepEqual(summarize([2,4,4,4,5,5,7,9]),{mean:5,sd:2});
  assert.deepEqual(summarize([]),{mean:0,sd:0});
});
