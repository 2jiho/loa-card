import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consistentAwakening} from '../src/features/card-scanner/visual-fields';

test('a readable positive count contradicts full awakening, while an icon alone does not',()=>{
  for(const count of [1,12,15]) assert.equal(consistentAwakening(5,count),null);
  for(const count of [null,0,-1,16,NaN]) assert.equal(consistentAwakening(5,count),5);
  for(const level of [null,0,1,2,3,4])
    for(const count of [null,0,12])assert.equal(consistentAwakening(level,count),level);
});
