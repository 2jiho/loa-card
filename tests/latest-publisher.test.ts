import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestPublisher } from '../src/latest-publisher';

test('presentation coalesces a burst without losing the newest inventory', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const values: number[] = [];
  const publisher = createLatestPublisher<number>(v => values.push(v), 200);
  publisher.publish(1);
  for (let n = 2; n <= 385; n++) publisher.publish(n);
  assert.deepEqual(values, [1]);
  t.mock.timers.tick(199);
  assert.deepEqual(values, [1]);
  t.mock.timers.tick(1);
  assert.deepEqual(values, [1, 385]);
  t.mock.timers.tick(1000);
  assert.deepEqual(values, [1, 385]);
});

test('completion flushes immediately and never delivers a stale timer later', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const values: string[] = [];
  const publisher = createLatestPublisher<string>(v => values.push(v), 200);
  publisher.publish('running');
  publisher.publish('complete');
  publisher.flush();
  t.mock.timers.tick(1000);
  assert.deepEqual(values, ['running', 'complete']);
});

test('cancelled scans cannot overwrite a new scan', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const values: number[] = [];
  const publisher = createLatestPublisher<number>(v => values.push(v), 200);
  publisher.publish(1);
  publisher.publish(2);
  publisher.cancel();
  publisher.flush();
  t.mock.timers.tick(1000);
  assert.deepEqual(values, [1]);
});

test('file input keeps immediate presentation', () => {
  const values: number[] = [];
  const publisher = createLatestPublisher<number>(v => values.push(v), 0);
  publisher.publish(1); publisher.publish(2); publisher.flush();
  assert.deepEqual(values, [1, 2]);
});
