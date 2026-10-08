import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebugBundle, isDebugBundle, indexDebugBundle, readDebugBundlePart, readContinuousRecording } from "../src/features/card-scanner/debug-bundle";
import type { DebugCapture } from "../src/features/card-scanner/debug-capture";
const part = (index: number): DebugCapture => ({ kind: "loacard-capture", version: 1, createdAt: "2026-10-03",
  source: "screen", rowMode: "stable", captureOnly: true, seed: [], recordingId: "test", part: index,
  frames: [{ image: "data:image/png;base64,AAAA", time: index, elapsed: index * 100 }], truncated: false });

test("a single recording file keeps all parts, original timestamps and scanner settings", async () => {
  const bundle = await createDebugBundle(3, async i => part(i));
  assert.equal(await isDebugBundle(bundle), true);
  const ranges = await indexDebugBundle(bundle);
  assert.equal(ranges.length, 3);
  for (const [i, range] of ranges.entries()) assert.deepEqual(await readDebugBundlePart(bundle, range), part(i + 1));
  assert.equal(await isDebugBundle(new Blob([JSON.stringify(part(1))])), false);
});
test("missing or unrelated chunks fail the whole export instead of silently dropping frames", async () => {
  await assert.rejects(createDebugBundle(3, async i => i === 2 ? undefined : part(i)), /2번/);
  await assert.rejects(createDebugBundle(2, async i => ({ ...part(i), recordingId: String(i) })), /연속 구간/);
  await assert.rejects(createDebugBundle(1, async () => part(2)), /첫 기록/);
  await assert.rejects(createDebugBundle(0, async i => part(i)), /구간 수/);
});
test("truncated files, forged lengths and appended bytes are rejected before replay", async () => {
  const bundle = await createDebugBundle(1, async i => part(i));
  await assert.rejects(indexDebugBundle(bundle.slice(0, bundle.size - 1)), /잘렸/);
  await assert.rejects(indexDebugBundle(new Blob([bundle, "extra"])), /예상하지/);
  await assert.rejects(indexDebugBundle(new Blob(["LOACARD1\n"])), /잘렸/);
  const bytes = new Uint8Array(await bundle.arrayBuffer());
  new DataView(bytes.buffer).setUint32(13, 0xffffffff, true);
  await assert.rejects(indexDebugBundle(new Blob([bytes])), /용량/);
});
test("standalone JSON recordings are rejected by the single-file replay reader", async () => {
  await assert.rejects(indexDebugBundle(new Blob([JSON.stringify(part(1))])), /파일 형식/);
});
test("continuous video survives the single-file round trip and corruption is rejected", async () => {
  const video = { blob: new Blob(["encoded-webm"], { type: "video/webm;codecs=vp9" }), duration: 6.25 };
  const bundle = await createDebugBundle(2, async i => part(i), video);
  const ranges = await indexDebugBundle(bundle);
  assert.deepEqual(await readDebugBundlePart(bundle, ranges[0]), part(1));
  const restored = await readContinuousRecording(bundle, ranges);
  assert.ok(restored); assert.equal(restored.duration, 6.25);
  assert.equal(restored.blob.type, video.blob.type); assert.equal(await restored.blob.text(), "encoded-webm");
  await assert.rejects(indexDebugBundle(bundle.slice(0, bundle.size - 1)), /잘렸/);
  await assert.rejects(indexDebugBundle(new Blob([bundle, "extra"])), /용량/);
  const invalid = await createDebugBundle(1, async i => part(i), { ...video, duration: -1 });
  await assert.rejects(indexDebugBundle(invalid), /형식/);
});
