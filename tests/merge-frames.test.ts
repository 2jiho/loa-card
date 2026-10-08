import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFrames } from "../src/features/card-scanner/merge-frames";
test("replay retains video and sharp PNG observations in order including equal timestamps", async () => {
  async function* input(times: number[], kind: string) { for (const time of times) yield { time, kind }; }
  const result = [];
  for await (const frame of mergeFrames(input([0, 1, 2], "video"), input([.5, 1, 3], "png"), new AbortController().signal)) result.push(frame);
  assert.deepEqual(result.map(f => [f.time, f.kind]), [[0, "video"], [.5, "png"], [1, "video"], [1, "png"], [2, "video"], [3, "png"]]);
});
test("canceling a mixed replay closes both decoders without advancing held canvas pixels", async () => {
  const closed: string[] = [], advanced: string[] = [];
  async function* input(time: number, kind: string) { try { advanced.push(kind); yield { time }; advanced.push(kind); yield { time: time + 1 }; } finally { closed.push(kind); } }
  const control = new AbortController();
  const frames = mergeFrames(input(0, "a"), input(.5, "b"), control.signal);
  assert.deepEqual((await frames.next()).value, { time: 0 });
  assert.deepEqual(advanced, ["a", "b"]);
  control.abort();
  await assert.rejects(frames.next(), { name: "AbortError" });
  assert.deepEqual(advanced, ["a", "b"]);
  assert.deepEqual(closed.sort(), ["a", "b"]);
});
