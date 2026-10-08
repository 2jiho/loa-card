import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingBitrate } from "../src/features/card-scanner/capture-settings";
test("capture encoder scales its budget for sharp text at higher resolutions and frame rates", () => {
  assert.equal(recordingBitrate({}), 12_000_000);
  assert.equal(recordingBitrate({ width: 2560, height: 1440, frameRate: 30 }), 16_588_800);
  assert.equal(recordingBitrate({ width: 2560, height: 1440, frameRate: 60 }), 33_177_600);
  assert.equal(recordingBitrate({ width: 7680, height: 4320, frameRate: 120 }), 64_000_000);
  assert.equal(recordingBitrate({ width: NaN, height: -1, frameRate: Infinity }), 12_000_000);
});
