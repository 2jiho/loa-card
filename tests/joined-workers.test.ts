import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJoinedWorkers } from '../src/features/card-scanner/joined-workers';

test('consumers share pending jobs without duplicate processing', async () => {
  const pending = Array.from({length: 30}, (_, i) => i), completed: number[] = [];
  await runJoinedWorkers(Array.from({length: 3}, () => async stopped => {
    while (!stopped() && pending.length) {
      const item = pending.shift()!;
      await Promise.resolve();
      completed.push(item);
    }
  }));
  assert.deepEqual(completed.sort((a,b) => a-b), Array.from({length:30}, (_,i) => i));
});

test('first failure waits for in-flight consumers and prevents their next job', async () => {
  let release!: () => void, settled = false, completed = false, sawStop = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const failure = new Error('reader failed');
  const run = runJoinedWorkers([
    async () => { throw failure; },
    async stopped => { await gate; sawStop = stopped(); completed = true; },
  ]);
  const assertion = assert.rejects(run, error => { settled = true; return error === failure; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await assertion;
  assert.equal(completed, true);
  assert.equal(sawStop, true);
});
