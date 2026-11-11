import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordedShareSchedule,summarizeDeliveryLateness} from '../dev/recorded-share-schedule';

test('the schedule keeps recorded intervals relative to the first frame', () => {
  const schedule = createRecordedShareSchedule();
  assert.equal(schedule.dueMs(12.5), 0, 'the first frame is due immediately, whatever its absolute time');
  assert.ok(Math.abs(schedule.dueMs(12.6) - 100) < 1e-6);
  assert.equal(Math.round(schedule.dueMs(13.5)), 1000);
});

test('a late frame is delivered immediately and reported as late, never dropped', () => {
  const schedule = createRecordedShareSchedule();
  schedule.dueMs(0);
  assert.equal(schedule.delayMs(0.5, 100), 400);
  assert.equal(schedule.delayMs(0.5, 700), 0);
  assert.equal(schedule.lateMs(0.5, 700), 200);
  assert.equal(schedule.lateMs(0.5, 100), 0);
});

test('queries for the same frame agree regardless of order', () => {
  const schedule = createRecordedShareSchedule();
  schedule.dueMs(1);
  const first = schedule.dueMs(1.25);
  assert.equal(schedule.delayMs(1.25, 0), first);
  assert.equal(schedule.lateMs(1.25, first + 5), 5);
  assert.equal(schedule.dueMs(1.25), first);
});

test('speed and gap cap are explicit and validated', () => {
  const fast = createRecordedShareSchedule({ speed: 2 });
  fast.dueMs(0);
  assert.equal(fast.dueMs(1), 500);
  const capped = createRecordedShareSchedule({ maxGapSeconds: 0.5 });
  capped.dueMs(0);
  assert.equal(capped.dueMs(10), 500, 'a 10 s idle gap is compressed to the cap');
  assert.ok(Math.abs(capped.dueMs(10.2) - 700) < 1e-6);
  assert.throws(() => createRecordedShareSchedule({ speed: 0 }), RangeError);
  assert.throws(() => createRecordedShareSchedule({ speed: Number.NaN }), RangeError);
  assert.throws(() => createRecordedShareSchedule({ maxGapSeconds: -1 }), RangeError);
});

test('invalid or decreasing frame times are rejected instead of reordered', () => {
  const schedule = createRecordedShareSchedule();
  schedule.dueMs(1);
  schedule.dueMs(2);
  assert.throws(() => schedule.dueMs(1.5), RangeError);
  assert.throws(() => createRecordedShareSchedule().dueMs(-1), RangeError);
  assert.throws(() => createRecordedShareSchedule().dueMs(Number.NaN), RangeError);
});

test('delivery lateness is summarized without hiding the worst case', () => {
  assert.deepEqual(summarizeDeliveryLateness([]), { delivered: 0, lateOver33Ms: 0, maxLateMs: 0, meanLateMs: 0 });
  const stats = summarizeDeliveryLateness([0, 10, 40, 100]);
  assert.equal(stats.delivered, 4);
  assert.equal(stats.lateOver33Ms, 2);
  assert.equal(stats.maxLateMs, 100);
  assert.equal(stats.meanLateMs, 37.5);
  assert.throws(() => summarizeDeliveryLateness([-1]), RangeError);
});
