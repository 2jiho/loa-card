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

test('the wait after a delivery can follow the value delivered (slower while frames are taken)', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const values: string[] = [];
  const publisher = createLatestPublisher<string>(v => values.push(v), v => v.startsWith('capture') ? 1000 : 200);
  publisher.publish('capture 1');
  publisher.publish('capture 2');
  t.mock.timers.tick(999);
  assert.deepEqual(values, ['capture 1'], 'nothing more within a second while capturing');
  publisher.publish('reading 1');
  t.mock.timers.tick(1);
  assert.deepEqual(values, ['capture 1', 'reading 1'], 'the newest value only');
  publisher.publish('reading 2');
  t.mock.timers.tick(200);
  assert.deepEqual(values, ['capture 1', 'reading 1', 'reading 2'], 'after reading values the shorter wait');
  publisher.publish('done');
  publisher.flush();
  assert.deepEqual(values.at(-1), 'done', 'flush still delivers at once');
});
