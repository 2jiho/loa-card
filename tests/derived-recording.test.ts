import assert from 'node:assert/strict';
import test from 'node:test';
import {derivedLines,derivedOrder,derivedRuns} from '../dev/recording-store';

test('a derived recording plays the frames bottom-up, or from the middle down and back up', () => {
  assert.deepEqual(derivedOrder(5,'reverse'),[4,3,2,1,0]);
  assert.deepEqual(derivedOrder(5,{middle:2}),[2,3,4,3,2,1,0]);
  assert.deepEqual(derivedRuns([2,3,4,3,2,1,0]),[{first:2,last:4,down:false},{first:3,last:0,down:true}]);
  assert.deepEqual(derivedRuns([5,4,3,2,1,0],3),[{first:5,last:3,down:true},{first:2,last:0,down:true}]);
});

test('a derived recording keeps the cadence of the source frames', () => {
  const lines=[0,33,66,100].map((t,seq)=>({seq,mediaTimeMs:1000+t,deliveredAtMs:t,receivedAtMs:t+5}));
  const out=derivedLines(lines,derivedOrder(4,'reverse'));
  assert.deepEqual(out.map(line=>line.seq),[0,1,2,3]);
  assert.deepEqual(out.map(line=>line.deliveredAtMs),[100,134,167,200]);
  assert.deepEqual(out.map(line=>line.mediaTimeMs),[1100,1134,1167,1200]);
});
