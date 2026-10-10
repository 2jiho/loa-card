import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreparedSlot } from '../src/features/card-scanner/prepared-slot.ts';

test('prepared engine transfers once without being destroyed by effect cleanup', async () => {
  let disposed = 0;
  let signal!: AbortSignal;
  const engine = { dispose() { disposed++; } };
  const slot = createPreparedSlot(async s => { signal = s; return engine; });
  assert.equal(slot.take(), undefined);
  await slot.ready;
  assert.equal(slot.take(), engine);
  assert.equal(slot.take(), undefined);
  await slot.dispose();
  assert.equal(signal.aborted, false);
  assert.equal(disposed, 0);
  engine.dispose();
  assert.equal(disposed, 1);
});

test('unused ready engine is disposed exactly once', async () => {
  let disposed = 0;
  const slot = createPreparedSlot(async () => ({ dispose() { disposed++; } }));
  await slot.ready;
  await slot.dispose();
  await slot.dispose();
  assert.equal(slot.take(), undefined);
  assert.equal(disposed, 1);
});

test('unmount during preparation cancels and disposes a late engine', async () => {
  let resolve!: (value: {dispose(): void}) => void;
  let disposed = 0;
  let signal!: AbortSignal;
  const slot = createPreparedSlot(s => { signal = s; return new Promise(r => { resolve = r; }); });
  const rejected = assert.rejects(slot.ready, { name: 'AbortError' });
  await slot.dispose();
  assert.equal(signal.aborted, true);
  resolve({ dispose() { disposed++; } });
  await rejected;
  assert.equal(slot.take(), undefined);
  assert.equal(disposed, 1);
});

test('failed preparation exposes the error and permits a fresh retry', async () => {
  const failed = createPreparedSlot(async () => { throw new Error('offline'); });
  await assert.rejects(failed.ready, /offline/);
  assert.equal(failed.take(), undefined);
  await failed.dispose();
  const retry = createPreparedSlot(async () => ({ dispose() {} }));
  await retry.ready;
  assert.ok(retry.take());
});
