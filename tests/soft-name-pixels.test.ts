import { test } from "node:test";
import assert from "node:assert/strict";
import { softNamePixels, normalizeSoftNamePixels } from "../src/features/card-scanner/soft-name-pixels.ts";

test("name retries retain observed luminance without converting faint strokes to solid white", () => {
  const rgba = new Uint8ClampedArray(128 * 36 * 4);
  rgba.set([130, 40, 150, 255], 0);
  rgba.set([240, 80, 245, 255], 4);
  rgba.set([180, 180, 180, 255], 8);
  rgba.set([90, 75, 100, 255], 12);
  const pixels = softNamePixels(rgba, 3);
  assert.deepEqual(Array.from(pixels.slice(0, 16)), [79,79,79,255,147,147,147,255,0,0,0,255,0,0,0,255]);
  assert.equal(softNamePixels(rgba, 4)[0], 0);
});

test("line normalization preserves ink ratios and background without letting the second line set gain", () => {
  const source = new Uint8ClampedArray(128 * 36 * 4);
  for (let i = 3; i < source.length; i += 4) source[i] = 255;
  source.set([40,40,40,255], 0); source.set([80,80,80,255], 4);
  source.set([255,255,255,255], 128 * 18 * 4);
  const normalized = normalizeSoftNamePixels(source);
  assert.equal(normalized.length, 128 * 18 * 4);
  assert.deepEqual(Array.from(normalized.slice(0,12)), [128,128,128,255,255,255,255,255,0,0,0,255]);
  assert.equal(source[0], 40);
  assert.ok(normalizeSoftNamePixels(new Uint8ClampedArray(128 * 36 * 4)).every(value => value === 0));
});
