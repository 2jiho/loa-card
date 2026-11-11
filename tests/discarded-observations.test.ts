import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discardRemainingObservations} from '../src/features/card-scanner/session/discarded-observations';

test('discarded observations preserve evidence and never invent a value', () => {
  const input = [
    {group: 7, captureOrder: 42, time: 1.5, reason: '이름 확인 필요', image: 'data:image/png;base64,AA'},
    {group: 8, captureOrder: 43, time: 2, reason: '   '},
  ];
  const output = discardRemainingObservations(input);
  assert.deepEqual(output, [
    {group: 7, captureOrder: 42, time: 1.5, reason: '이름 확인 필요', image: 'data:image/png;base64,AA'},
    {group: 8, captureOrder: 43, time: 2, reason: '판독 불가'},
  ]);
  assert.equal(input[1].reason, '   ', 'the source evidence is not mutated');
  assert.deepEqual(discardRemainingObservations([]), []);
});
