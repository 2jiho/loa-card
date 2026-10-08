import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeWithin } from '../src/features/card-scanner/initialization';
test('cancel immediately and dispose a resource created after cancellation', async () => {
  const controller = new AbortController(); let complete!: (value: number) => void, disposed = 0;
  const ready = initializeWithin(new Promise<number>(resolve => { complete = resolve; }), controller.signal, value => { disposed = value; });
  controller.abort(); await assert.rejects(ready, { name: 'AbortError' });
  complete(42); await Promise.resolve(); assert.equal(disposed, 42);
});
test('initialization failure propagates and normal completion is not disposed', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(initializeWithin(Promise.reject(new Error('offline')), signal, () => {}), /offline/);
  assert.equal(await initializeWithin(Promise.resolve(7), signal, () => assert.fail()), 7);
});
test('hung initialization times out and disposes a late result', async () => {
  let complete!: (value: number) => void, disposed = 0;
  const ready = initializeWithin(new Promise<number>(resolve => { complete = resolve; }), new AbortController().signal, value => { disposed = value; }, 5);
  await assert.rejects(ready, /초과/); complete(3); await Promise.resolve(); assert.equal(disposed, 3);
});
