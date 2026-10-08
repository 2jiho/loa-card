import { test } from "node:test";
import assert from "node:assert/strict";
import { CandidateQueue } from "../src/features/card-scanner/candidate-queue";
test("pending images coalesce by observation group and release superseded rasters", () => {
  const released: number[] = [], queue = new CandidateQueue<{ group: number; id: number }>(2, item => released.push(item.id));
  assert.equal(queue.push({ group: 1, id: 1 }), true); queue.push({ group: 2, id: 2 });
  assert.equal(queue.push({ group: 1, id: 3 }), true);
  assert.deepEqual(released, [1]); assert.equal(queue.length, 2);
  assert.equal(queue.push({ group: 3, id: 4 }), false);
  assert.equal(queue.shift()?.id, 3); assert.equal(queue.shift()?.id, 2); assert.equal(queue.shift(), undefined);
});
test("canceling the pipeline releases every retained image", () => {
  const released: number[] = [], queue = new CandidateQueue<{ group: number }>(10, item => released.push(item.group));
  queue.push({ group: 4 }); queue.push({ group: 8 }); queue.clear();
  assert.deepEqual(released, [4,8]); assert.equal(queue.length, 0);
});
