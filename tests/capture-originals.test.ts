import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptureOriginals } from "../src/features/card-scanner/capture-originals.ts";
import type { DebugCapture } from "../src/features/card-scanner/debug-capture.ts";

test("normal capture originals span archive boundaries and remove only their own temporary parts", async () => {
  const saved = new Map<string, DebugCapture>();
  saved.set("user-recording:1", {} as DebugCapture);
  const deleted: string[] = [];
  const originals = createCaptureOriginals({ rowMode: "all", captureOnly: false }, new AbortController().signal, {
    async save(part) { saved.set(`${part.recordingId}:${part.part}`, structuredClone(part)); },
    async load(id, part) { return saved.get(`${id}:${part}`); },
    async delete(id, part) { const key = `${id}:${part}`; deleted.push(key); saved.delete(key); },
  }, { frames: 2, bytes: 10000 });
  for (let i = 0; i < 5; i++) originals.add({ image: "data:image/png;base64,YQ==", time: i, elapsed: i * 1000 });
  const parts = [];
  for await (const part of originals.parts()) parts.push(part);
  assert.deepEqual(parts.flatMap(part => part.frames.map(frame => frame.time)), [0, 1, 2, 3, 4]);
  assert.ok(parts.every(part => part.seed.length === 0));
  assert.equal(originals.active, true);
  await originals.dispose();
  assert.equal(deleted.length, 2);
  assert.deepEqual([...saved.keys()], ["user-recording:1"]);
  assert.equal(parts.at(-1)!.frames.length, 0);
});

test("a failed temporary archive reports incomplete originals instead of silently claiming a complete replay", async () => {
  const originals = createCaptureOriginals({ rowMode: "all", captureOnly: false }, new AbortController().signal, {
    async save() { throw new Error("quota"); }, async load() { return undefined; }, async delete() {},
  }, { frames: 1, bytes: 10000 });
  originals.add({ image: "data:image/png;base64,YQ==", time: 0, elapsed: 0 });
  originals.add({ image: "data:image/png;base64,YQ==", time: 1, elapsed: 1000 });
  const parts = [];
  for await (const part of originals.parts()) parts.push(part);
  assert.equal(originals.active, false);
  assert.ok(originals.failure.includes("저장"));
  assert.deepEqual(parts.flatMap(part => part.frames.map(frame => frame.time)), [0, 1]);
  await originals.dispose();
});
