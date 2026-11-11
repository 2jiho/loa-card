import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRecognitionNeeded,
  recognitionNeededSlotLabel,
  recognitionNeededSlots,
  recordRecognitionNeeded,
} from '../src/features/card-scanner/session/recognition-needed';

test('obstructed slots keep the newest positive capture and clear only after a later clean one', () => {
  const slots = new Map<number, {slot: number; captureTime: number; reason: string}>();
  recordRecognitionNeeded(slots, 14, 10, '툴팁 패널 가림');
  assert.deepEqual(recognitionNeededSlots(slots), [{slot: 14, captureTime: 10, reason: '툴팁 패널 가림'}]);
  recordRecognitionNeeded(slots, 14, 5, '오래된 가림');
  assert.equal(slots.get(14)?.captureTime, 10, 'an older obstruction cannot replace a newer one');
  clearRecognitionNeeded(slots, 14, 9);
  assert.equal(slots.has(14), true, 'an older clean capture cannot clear a newer obstruction');
  clearRecognitionNeeded(slots, 14, 10);
  assert.equal(slots.has(14), false);
});

test('invalid slots, times and reasons never create a warning', () => {
  const slots = new Map<number, {slot: number; captureTime: number; reason: string}>();
  for (const [slot, time, reason] of [
    [-1, 1, '가림'],
    [40, 1, '가림'],
    [1.5, 1, '가림'],
    [3, NaN, '가림'],
    [3, -1, '가림'],
    [3, 1, ''],
    [3, 1, '   '],
    [3, 1, undefined as unknown as string],
  ] as const) recordRecognitionNeeded(slots, slot, time, reason);
  assert.equal(slots.size, 0);
  clearRecognitionNeeded(slots, -1, 1);
  clearRecognitionNeeded(slots, 3, NaN);
  assert.equal(slots.size, 0);
});

test('a pinned target slot is not cleared by a later clean capture of the same screen slot', () => {
  const slots = new Map<number, {slot: number; captureTime: number; reason: string; pinned?: true}>();
  recordRecognitionNeeded(slots, 7, 11.4, '툴팁 가림', true);
  clearRecognitionNeeded(slots, 7, 12);
  assert.equal(slots.get(7)?.pinned, true);
  assert.equal(slots.size, 1);
});

test('the presentation list is ordered and the slot label stays a screen position', () => {
  const slots = new Map<number, {slot: number; captureTime: number; reason: string}>();
  recordRecognitionNeeded(slots, 27, 20, '커서 가림');
  recordRecognitionNeeded(slots, 3, 10, '툴팁 패널 가림');
  recordRecognitionNeeded(slots, 14, 15, '이름 영역 가림');
  assert.deepEqual(recognitionNeededSlots(slots).map(item => item.slot), [3, 14, 27]);
  assert.equal(recognitionNeededSlotLabel(0), '최근 화면 1행 1열');
  assert.equal(recognitionNeededSlotLabel(39), '최근 화면 4행 10열');
  assert.equal(recognitionNeededSlotLabel(40), '위치 확인 불가');
});
