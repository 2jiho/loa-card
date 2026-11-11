import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FinishTimer} from '../src/features/card-scanner/session/finish-timing';

test('ten-second measurement includes OCR backlog and later repeated input does not restart it', () => {
  const timer = new FinishTimer();
  timer.record('a', 2000); timer.record('b', 3000); timer.record('a', 8000);
  const timing = timer.coverage(['a','b'], 2, 9000)!;
  assert.equal(timing.lastCardInputMs, 3000);
  assert.equal(timing.measurementBasis, 'first-identified-card-captures');
  assert.equal(timing.sufficientInputVerified, false);
  assert.equal(timer.finish(timing, 13000).identifiedCaptureWithinTarget, true);
  assert.equal(timer.finish(timing, 13001).identifiedCaptureWithinTarget, false);
  assert.equal(timer.finish(timing, 13000).goalWithinTarget, null);
  assert.equal(timer.finish(timing, 15000).afterLastCardMs, 12000);
});

test('automatic share stop and final processing are separate scanner clock events', () => {
  const timer = new FinishTimer(); timer.record('a', 500);
  const timing = timer.coverage(['a'], 1, 1000)!;
  const stopped = timer.stopSharing(timing, 1400);
  assert.equal(stopped.autoStoppedMs, 1400);
  assert.equal(stopped.afterLastIdentifiedToAutoStopMs, 900);
  assert.equal(timer.finish(stopped, 1700).finishedMs, 1700);
  assert.equal(timer.finish(stopped, 1700).goalWithinTarget, null);
  assert.equal(timer.finish(timing, 1700).autoStoppedMs, undefined, 'natural end is not an automatic stop');
  for (const now of [NaN, Infinity, 999]) assert.throws(() => timer.stopSharing(timing, now), RangeError);
  assert.throws(() => timer.stopSharing(stopped, 1500), RangeError);
  assert.throws(() => timer.finish(stopped, 1399), RangeError);
});

test('invalid or reversed completion clocks cannot be reported as zero-delay success', () => {
  const timer = new FinishTimer(); timer.record('a', 500);
  const timing = timer.coverage(['a'], 1, 1000)!;
  for (const now of [NaN, Infinity, -Infinity, 499, 999])
    assert.throws(() => timer.finish(timing, now), RangeError);
  const result = timer.finish(timing, 1000);
  assert.equal(result.afterLastCardMs, 500);
  assert.equal(result.sufficientInputVerified, false);
});

test('unknown totals and missing current-run captures cannot certify a timing baseline', () => {
  const timer = new FinishTimer(); timer.record('a', 500);
  assert.equal(timer.coverage(['a'], null, 1000), undefined);
  assert.equal(timer.coverage(['a'], 2, 1000), undefined);
  assert.equal(timer.coverage(['a','a'], 2, 1000), undefined);
  assert.equal(timer.coverage(['a','restored'], 2, 1000), undefined);
  assert.equal(timer.coverage(['a'], 1, 400), undefined);
});
