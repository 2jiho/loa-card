import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { prepareContrastPattern, readContrastCount } from "../src/features/card-scanner/count-pattern.ts";

test("bright artwork and every previously unreadable +7 retain manually read counts", async () => {
  const atlas = JSON.parse(await readFile("public/scanner/counter-patterns.json", "utf8"));
  const patterns = atlas.patterns.map(prepareContrastPattern);
  assert.deepEqual([...new Set(patterns.map((p: { value: number }) => p.value))].sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
  const samples = JSON.parse(await readFile("tests/fixtures/counter-samples.json", "utf8"));
  for (const sample of samples) {
    const pixels = new Uint8Array(140 * 210 * 4), strip = Buffer.from(sample.rgba, "base64");
    for (let y = 0; y < 25; y++) pixels.set(strip.subarray(y * 86 * 4, (y + 1) * 86 * 4), ((141 + y) * 140 + 54) * 4);
    assert.equal(readContrastCount(pixels, patterns), sample.value, sample.name);
    for (const offset of [-18, 18]) {
      const changed = Uint8Array.from(pixels, (v, i) => i % 4 === 3 || !pixels[i - i % 4 + 3] ? v : Math.max(0, Math.min(255, v + offset)));
      const read = readContrastCount(changed, patterns);
      assert.ok(read === null || read === sample.value, `${sample.name}: brightness must not invent a different number`);
    }
    // Without an inventory stack icon, artwork must never create a count.
    for (let y = 141; y < 172; y++) pixels.fill(0, (y * 140 + 56) * 4, (y * 140 + 108) * 4);
    assert.equal(readContrastCount(pixels, patterns), null);
  }
});

test("a uniformly white number area with an inventory icon has no glyph outline", async () => {
  const atlas = JSON.parse(await readFile("public/scanner/counter-patterns.json", "utf8"));
  const pixels = new Uint8Array(140 * 210 * 4);
  for (let y = 144; y < 164; y++) for (let x = 60; x < 82; x++) pixels.set([40, 190, 200, 255], (y * 140 + x) * 4);
  for (let y = 143; y < 165; y++) for (let x = 89; x < 139; x++) pixels.set([255, 255, 255, 255], (y * 140 + x) * 4);
  assert.equal(readContrastCount(pixels, atlas.patterns.map(prepareContrastPattern)), null);
});
