import { test } from "node:test";
import assert from "node:assert/strict";
import { DebugRecorder, parseDebugCapture, MAX_DEBUG_FRAMES, assertNextDebugPart } from "../src/features/card-scanner/debug-capture";

const settings = { source: "screen" as const, rowMode: "all" as const, captureOnly: false, seed: [] };
const frame = { image: "data:image/png;base64,AAAA", time: 0, elapsed: 0 };
test("capture debug round trip preserves input order, time, source and scan settings", () => {
  const recorder = new DebugRecorder(settings);
  recorder.add(frame);
  recorder.add({ ...frame, time: 2, elapsed: 43 });
  const loaded = parseDebugCapture(JSON.stringify(recorder.session));
  assert.equal(loaded.source, "screen");
  assert.equal(loaded.captureOnly, false);
  assert.deepEqual(loaded.frames, [frame, { ...frame, time: 2, elapsed: 43 }]);
  assert.notEqual(loaded.source, "images");
});
test("recording owns its initial inventory and never changes the live seed", () => {
  const seed = [{ id: "1", name: "test", awakening: 0, extraCopies: 0, confidence: 1,
    review: [], image: frame.image, time: 0, observations: 1 }];
  const recorder = new DebugRecorder({ ...settings, seed });
  seed[0].extraCopies = 3;
  assert.equal(recorder.session.seed[0].extraCopies, 0);
  recorder.add(frame);
  assert.equal(parseDebugCapture(JSON.stringify(recorder.session)).seed[0].extraCopies, 0);
});
test("capture limits preserve the start of a recording and report truncation", () => {
  const recorder = new DebugRecorder(settings);
  for (let i = 0; i < MAX_DEBUG_FRAMES + 2; i++) recorder.add({ ...frame, elapsed: i });
  assert.equal(recorder.session.frames.length, MAX_DEBUG_FRAMES);
  assert.equal(recorder.session.truncated, true);
  assert.equal(recorder.session.frames[0].elapsed, 0);
  assert.equal(parseDebugCapture(JSON.stringify(recorder.session)).truncated, true);
});
test("debug replay rejects remote images, invalid times and incomplete files", () => {
  const recorder = new DebugRecorder(settings);
  recorder.add(frame);
  for (const data of [{ ...recorder.session, version: 2 },
    { ...recorder.session, frames: [] },
    { ...recorder.session, source: "other" },
    { ...recorder.session, frames: [{ ...frame, image: "https://example.com/frame.png" }] },
    { ...recorder.session, frames: [{ ...frame, elapsed: -1 }] },
    { ...recorder.session, frames: [{ ...frame, elapsed: 2 }, frame] },
    { ...recorder.session, seed: [{ id: "broken" }] }])
    assert.throws(() => parseDebugCapture(JSON.stringify(data)));
});
test("archive rollover keeps the boundary frame and releases completed chunks", async () => {
  const archived: ReturnType<typeof parseDebugCapture>[] = [];
  const recorder = new DebugRecorder(settings, async part => { archived.push(structuredClone(part)); },
    { bytes: frame.image.length * 2, frames: 600 });
  for (let i = 0; i < 7; i++) recorder.add({ ...frame, elapsed: i });
  await recorder.ready();
  assert.equal(recorder.totalFrames, 7);
  assert.equal(recorder.archivedParts, 3);
  assert.equal(recorder.session.frames.length, 1);
  assert.equal(recorder.session.truncated, false);
  const parts = [...archived, recorder.session].map(part => parseDebugCapture(JSON.stringify(part)));
  assert.deepEqual(parts.flatMap(part => part.frames.map(f => f.elapsed)), [0, 1, 2, 3, 4, 5, 6]);
  for (let i = 1; i < parts.length; i++) assertNextDebugPart(parts[0], parts[i], i + 1, parts[i - 1].frames.at(-1)!.elapsed);
  assert.throws(() => assertNextDebugPart(parts[0], parts[2], 2, 1));
  assert.throws(() => assertNextDebugPart(parts[0], { ...parts[1], recordingId: "other" }, 2, 1));
  assert.throws(() => assertNextDebugPart(parts[0], parts[1], 2, 5));
});
test("storage failure stops recording while keeping unsaved boundary data exportable", async () => {
  const recorder = new DebugRecorder(settings, async () => { throw new Error("quota"); }, { bytes: 1000, frames: 1 });
  recorder.add(frame); recorder.add({ ...frame, elapsed: 1 });
  await recorder.ready();
  recorder.add({ ...frame, elapsed: 2 });
  assert.equal(recorder.totalFrames, 2);
  assert.equal(recorder.session.truncated, true);
  assert.ok(recorder.failure.includes("저장"));
  assert.equal(recorder.unsavedParts.get(1)!.frames[0].elapsed, 0);
  assert.equal(recorder.session.frames[0].elapsed, 1);
});
