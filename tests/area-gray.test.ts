import { test } from "node:test";
import assert from "node:assert/strict";
import { areaGray } from "../src/features/card-scanner/area-gray";
test("fractional portrait bins integrate pixels rather than sampling a single location", () => {
  const pixels = Uint8Array.from([0, 0, 0, 255, 60, 60, 60, 255, 120, 120, 120, 255]);
  assert.deepEqual(Array.from(areaGray(pixels, 3, 1, 2, 1)), [20, 100]);
});
test("area integration preserves constant colors and the global gray mean", () => {
  const pixels = Uint8Array.from({ length: 140 * 210 * 4 }, (_, i) => i % 4 === 3 ? 255 : Math.floor(i / 4) % 256);
  const output = areaGray(pixels, 140, 210);
  const inputMean = Array.from({ length: 140 * 210 }, (_, i) => pixels[4 * i]).reduce((a, b) => a + b, 0) / (140 * 210);
  assert.ok(Math.abs(output.reduce((a, b) => a + b, 0) / output.length - inputMean) < .00001);
  assert.throws(() => areaGray(new Uint8Array(4), 1, 1));
});
