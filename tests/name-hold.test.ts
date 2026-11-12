import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNameHold} from '../dev/name-hold';

test('a refused place is held for the hold time and then read again', () => {
  const hold=createNameHold(1);
  assert.equal(hold.held(12,17,5),false);
  hold.refused(12,17,5);
  assert.equal(hold.held(12,17,5.03),true);
  assert.equal(hold.held(12,17,5.99),true);
  assert.equal(hold.held(12,17,6),false);
});

test('the hold belongs to one slot at one scroll position', () => {
  const hold=createNameHold(1);
  hold.refused(12,17,5);
  assert.equal(hold.held(12,18,5.1),false);          // another slot
  assert.equal(hold.held(13,17,5.1),false);          // the list moved: other cards are there now
  assert.equal(hold.held(null,17,5.1),false);        // scroll position unknown is its own place
  hold.refused(null,17,5);
  assert.equal(hold.held(null,17,5.1),true);
});

test('a later refusal extends the hold; a hold of zero never holds', () => {
  const hold=createNameHold(1);
  hold.refused(3,4,5);hold.refused(3,4,6.2);
  assert.equal(hold.held(3,4,7.1),true);
  assert.equal(hold.held(3,4,7.2),false);
  const none=createNameHold(0);
  none.refused(3,4,5);
  assert.equal(none.held(3,4,5.01),false);
});
