import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FreshObservations} from '../src/features/card-scanner/fresh-observation';

test('new stable pixels reopen exhausted unresolved work, not active work or exact repeats', () => {
  const gate = new FreshObservations<object>(), observation = {};
  gate.remember(1, 'a', 1, observation);
  assert.equal(gate.retry(1, 'b', 2, true, () => false), false);
  gate.finish(observation);
  assert.equal(gate.retry(1, 'a', 2, true, () => false), false);
  assert.equal(gate.retry(1, 'b', 2, false, () => false), false);
  assert.equal(gate.retry(1, 'b', 1.5, true, () => false), false);
  assert.equal(gate.retry(1, 'b', NaN, true, () => false), false);
  assert.equal(gate.retry(1, 'b', 2, true, () => true), false);
  assert.equal(gate.retry(1, 'b', 2, true, () => false), true);
  gate.remember(1, 'b', 2, {});
  assert.equal(gate.retry(1, 'c', 3, true, () => false), false);
});

test('late completion of superseded work cannot reopen its replacement; metadata is bounded', () => {
  const gate = new FreshObservations<object>(2), old = {}, replacement = {};
  gate.remember(1, 'a', 0, old);
  gate.remember(1, 'b', 1, replacement);
  gate.finish(old);
  assert.equal(gate.retry(1, 'c', 3, true, () => false), false);
  gate.finish(replacement);
  assert.equal(gate.retry(1, 'c', 3, true, () => false), true);
  gate.remember(2, 'd', 1, {}); gate.remember(3, 'e', 1, {});
  assert.equal(gate.retry(1, 'c', 3, true, () => false), false);
});
