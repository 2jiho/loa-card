import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FinishTimer} from '../src/features/card-scanner/finish-timing';

test('ten-second measurement includes OCR backlog and later repeated input does not restart it', () => {
  const timer = new FinishTimer();
  timer.record('a', 2000); timer.record('b', 3000); timer.record('a', 8000);
  const timing = timer.coverage(['a','b'], 2, 9000)!;
  assert.equal(timing.lastCardInputMs, 3000);
  assert.equal(timer.finish(timing, 13000).withinTarget, true);
  assert.equal(timer.finish(timing, 13001).withinTarget, false);
  assert.equal(timer.finish(timing, 15000).afterLastCardMs, 12000);
});

test('unknown totals and missing current-run captures cannot certify a timing baseline', () => {
  const timer = new FinishTimer(); timer.record('a', 500);
  assert.equal(timer.coverage(['a'], null, 1000), undefined);
  assert.equal(timer.coverage(['a'], 2, 1000), undefined);
  assert.equal(timer.coverage(['a','a'], 2, 1000), undefined);
  assert.equal(timer.coverage(['a','restored'], 2, 1000), undefined);
  assert.equal(timer.coverage(['a'], 1, 400), undefined);
});
