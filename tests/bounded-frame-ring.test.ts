import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BoundedFrameRing} from '../src/features/card-scanner/capture/bounded-frame-ring';

const frames = () => {
  const resized: string[] = [];
  const ring = new BoundedFrameRing<{ id: number; width: number; height: number }, { time: number }>(
    2,
    () => ({ id: resized.length, width: 0, height: 0 }),
    (frame, width, height) => { frame.width = width; frame.height = height; resized.push(`${width}x${height}`); },
  );
  return { ring, resized };
};

test('ring keeps only the newest bounded frames and drops replaced bindings', () => {
  const { ring } = frames();
  const first = ring.next(100, 50);
  ring.bind(first, 7, { time: 1 });
  const second = ring.next(100, 50);
  ring.bind(second, 8, { time: 2 });
  assert.equal(ring.size, 2);
  assert.equal(ring.find(7)?.meta.time, 1);
  assert.equal(ring.find(8)?.meta.time, 2);
  const third = ring.next(100, 50);
  ring.bind(third, 9, { time: 3 });
  assert.equal(ring.size, 2);
  assert.equal(ring.find(7), undefined, 'the oldest frame is evicted, never overwritten silently');
  assert.equal(ring.find(8)?.meta.time, 2);
  assert.equal(ring.find(9)?.meta.time, 3);
  assert.deepEqual(ring.entries().map(entry => entry.frameId), [9, 8]);
});

test('a repeated frame id moves to the new frame and dimensions are delegated', () => {
  const { ring, resized } = frames();
  const first = ring.next(140, 210);
  ring.bind(first, 4, { time: 1 });
  const second = ring.next(280, 420);
  assert.deepEqual([second.width, second.height], [280, 420]);
  ring.bind(second, 4, { time: 2 });
  assert.equal(ring.find(4)?.frame, second);
  assert.deepEqual(resized, ['140x210', '280x420']);
  ring.clear();
  assert.equal(ring.find(4), undefined);
  assert.equal(ring.size, 0);
});

test('ring rejects invalid limits, dimensions and frame ids', () => {
  assert.throws(() => new BoundedFrameRing(0, () => ({}), () => {}), RangeError);
  const { ring } = frames();
  assert.throws(() => ring.next(0, 10), RangeError);
  const frame = ring.next(10, 10);
  assert.throws(() => ring.bind(frame, -1, { time: 0 }), RangeError);
  assert.throws(() => ring.bind({ id: 99, width: 0, height: 0 }, 1, { time: 0 }), /does not belong/);
});
