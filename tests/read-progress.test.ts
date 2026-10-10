import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatScanTime, readingEstimate } from '../src/features/card-scanner/read-progress';

test('reading ETA needs the full collection and a sustained recent rate', () => {
  const samples = [{time:0,completed:0},{time:3,completed:3},{time:6,completed:6}];
  assert.deepEqual(readingEstimate(samples,18,18),{low:5,high:20});
  assert.equal(readingEstimate(samples,18,17),null);
  assert.equal(readingEstimate(samples,null,18),null);
  assert.equal(readingEstimate(samples.slice(0,2),18,18),null);
  assert.equal(readingEstimate([{time:0,completed:0},{time:6,completed:2}],18,18),null);
});

test('stalls, backwards revisions and completion hide ETA instead of counting down to zero', () => {
  const start = [{time:0,completed:0},{time:6,completed:6}];
  assert.equal(readingEstimate([...start,{time:11,completed:6}],18,18),null);
  assert.equal(readingEstimate([...start,{time:7,completed:5},{time:8,completed:8}],18,18),null);
  assert.equal(readingEstimate([...start,{time:8,completed:18}],18,18),null);
  assert.equal(readingEstimate([...start,{time:40,completed:6}],18,18),null);
  assert.equal(formatScanTime(65.9),'1분 5초');
  assert.equal(formatScanTime(-1),'0초');
});
