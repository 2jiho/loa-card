import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectZeroPreview} from '../src/features/card-scanner/session/preview-zero';

test('the first preferred preview that shows an empty counter is accepted', () => {
  assert.equal(selectZeroPreview([{order:5,zero:false,positive:false},{order:9,zero:true,positive:false},{order:7,zero:true,positive:false}]),1);
});

test('an empty counter seen before a later positive count does not confirm zero', () => {
  // The stable (preferred) preview is older than a capture that showed copies.
  assert.equal(selectZeroPreview([{order:3,zero:true,positive:false},{order:8,zero:false,positive:true}]),-1);
});

test('an empty counter seen after the positive count still confirms zero', () => {
  assert.equal(selectZeroPreview([{order:3,zero:true,positive:false},{order:8,zero:false,positive:true},{order:9,zero:true,positive:false}]),2);
});

test('no empty counter, no confirmation', () => {
  assert.equal(selectZeroPreview([]),-1);
  assert.equal(selectZeroPreview([{order:1,zero:false,positive:false}]),-1);
});
