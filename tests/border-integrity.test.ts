import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alignCardBorders } from "../src/features/card-scanner/card-borders";
import { borderIntegrity } from "../src/features/card-scanner/border-integrity";

test("border allocation optimization preserves all geometry and scores from the previous implementation", () => {
  const samples = JSON.parse(readFileSync(new URL("./fixtures/border-integrity-samples.json", import.meta.url), "utf8"));
  const cases = JSON.parse(readFileSync(new URL("./fixtures/border-alignment-equivalence.json", import.meta.url), "utf8"));
  for (const item of cases) {
    const sample = samples[item.sample];
    const box = { ...sample.box, x: sample.box.x + item.dx, y: sample.box.y + item.dy };
    assert.deepEqual(alignCardBorders(Uint8Array.from(Buffer.from(sample.rgba, "base64")), sample.width, sample.height, box, item.scale), item.expected,
      `${sample.name}: scale=${item.scale}, offset=${item.dx},${item.dy}`);
  }
});
test("all five real rarity borders remain intact while the actual tooltip-covered card is excluded", () => {
  const samples = JSON.parse(readFileSync(new URL("./fixtures/border-integrity-samples.json", import.meta.url), "utf8"));
  for (const sample of samples) {
    const result = borderIntegrity(Uint8Array.from(Buffer.from(sample.rgba, "base64")), sample.width, sample.height, sample.box);
    assert.equal(result.intact, sample.intact, sample.name);
    const acquired = alignCardBorders(Uint8Array.from(Buffer.from(sample.rgba, "base64")), sample.width, sample.height, sample.box);
    assert.equal(acquired.intact, sample.intact, `production acquisition: ${sample.name}`);
  }
});
test("dim continuous borders survive, but a missing bottom or a large scroll displacement does not", () => {
  const width = 180, height = 250, box = { x: 20, y: 20, width: 140, height: 210 };
  const rgba = new Uint8Array(width * height * 4).fill(20);
  const paint = (x: number, y: number) => rgba.set([33, 33, 33, 255], (y * width + x) * 4);
  for (let y = 20; y < 230; y++) { paint(20, y); paint(158, y); }
  for (let x = 20; x < 160; x++) { paint(x, 22); paint(x, 227); }
  assert.equal(borderIntegrity(rgba, width, height, box).intact, true);
  assert.equal(borderIntegrity(rgba, width, height, { ...box, y: 32 }).intact, false);
  for (let y = 220; y < 236; y++) for (let x = 20; x < 160; x++) rgba.set([20, 20, 20, 255], (y * width + x) * 4);
  assert.equal(borderIntegrity(rgba, width, height, box).intact, false);
});
