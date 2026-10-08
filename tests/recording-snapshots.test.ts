import { test } from "node:test";
import assert from "node:assert/strict";
import { DebugRecorder } from "../src/features/card-scanner/debug-capture";
import type { DebugCapture } from "../src/features/card-scanner/debug-capture";
import { recorderSnapshotParts } from "../src/features/card-scanner/recording-snapshots";

test("initial scanning sees the same archived and current PNG parts as file replay", async () => {
  const archive = new Map<number, DebugCapture>();
  const recorder = new DebugRecorder({ source: "screen", rowMode: "all", captureOnly: false, seed: [] },
    async part => { archive.set(part.part!, part); }, { bytes: 1000, frames: 1 });
  for (const time of [0, 1, 2]) recorder.add({ image: "data:image/png;base64,AAAA", time, elapsed: time * 1000 });
  const times: number[] = [];
  for await (const part of recorderSnapshotParts(recorder, async (_id, index) => archive.get(index), new AbortController().signal))
    times.push(...part.frames.map(frame => frame.time));
  assert.deepEqual(times, [0, 1, 2]);
  archive.delete(1);
  await assert.rejects(async () => {
    for await (const part of recorderSnapshotParts(recorder, async (_id, index) => archive.get(index), new AbortController().signal)) void part;
  }, /원본 캡처 구간/);
});

test("cancellation prevents loading or decoding snapshot parts", async () => {
  const recorder = new DebugRecorder({ source: "screen", rowMode: "all", captureOnly: false, seed: [] });
  recorder.add({ image: "data:image/png;base64,AAAA", time: 0, elapsed: 0 });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(async () => {
    for await (const part of recorderSnapshotParts(recorder, async () => assert.fail(), abort.signal)) void part;
  }, { name: "AbortError" });
});
