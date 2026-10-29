import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfirmedNameGroups } from '../src/features/card-scanner/confirmed-name-groups';

test('late recovery timeout stays resolved after a newer read of the same observation group', () => {
  const names = new ConfirmedNameGroups();
  assert.equal(names.covers(3, 110), false);
  names.confirm(3, 'card-a', 690, []);
  names.confirm(3, 'card-a', 170, []); // older OCR finishes later
  assert.equal(names.covers(3, 110), true);
  assert.equal(names.covers(3, 690), true);
  assert.equal(names.covers(3, 691), false); // fresh input still needs inspection
  assert.equal(names.covers(4, 110), false); // same slot/new group is not enough
});

test('uncertain names and conflicting identities cannot hide unknown cards', () => {
  const names = new ConfirmedNameGroups();
  names.confirm(3, 'card-a', 200, ['이름 확인']);
  assert.equal(names.covers(3, 100), false);
  names.confirm(3, 'card-a', 200, []);
  names.confirm(3, 'card-b', 300, []);
  names.confirm(3, 'card-a', 400, []);
  assert.equal(names.covers(3, 100), false);
});

test('missing capture evidence and previous runs never suppress a warning', () => {
  const names = new ConfirmedNameGroups();
  names.confirm(3, 'card-a', 200, []);
  assert.equal(names.covers(3, undefined), false);
  assert.equal(names.covers(undefined, 100), false);
  assert.equal(names.covers(3, NaN), false);
  assert.equal(new ConfirmedNameGroups().covers(3, 100), false);
});
