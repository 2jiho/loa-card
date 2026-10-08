import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_WIDTH, NAME_HEIGHT, nameMask, packName, nameSimilarity } from "../src/features/card-scanner/name-pattern.ts";

test("packed name pixels retain unsigned word boundaries and distinct rows", () => {
  const mask = new Uint8Array(NAME_WIDTH * NAME_HEIGHT);
  for (const position of [0, 31, 32, 63, 127, 128, 4607]) mask[position] = 1;
  const packed = packName(mask);
  assert.equal(packed.pixels, 7);
  assert.deepEqual(Array.from(packed.bits.slice(0, 5)), [0x80000001, 0x80000001, 0, 0x80000000, 1]);
  assert.equal(packed.bits.at(-1), 0x80000000);
  assert.ok(packed.bits.slice(5, -1).every(word => word === 0));
  assert.equal(packName(mask, NAME_WIDTH, 0).pixels, 0);
  assert.equal(packName(mask, 0, NAME_HEIGHT).pixels, 0);
});

test("empty, shifted and overlapping glyph shapes have meaningful similarity", () => {
  const mask = new Uint8Array(NAME_WIDTH * NAME_HEIGHT);
  for (let y = 5; y < 20; y++) for (let x = 10; x < 30; x++) mask[y * NAME_WIDTH + x] = 1;
  const a = packName(mask), shifted = packName(mask, 1, -1), empty = packName(new Uint8Array(mask.length));
  assert.equal(nameSimilarity(a.bits, a.pixels, a.bits, a.pixels), 1);
  assert.ok(nameSimilarity(a.bits, a.pixels, shifted.bits, shifted.pixels) > .8);
  assert.equal(nameSimilarity(a.bits, a.pixels, empty.bits, 0), 0);
  assert.equal(packName(mask, -128, 0).pixels, 0); // cannot wrap across rows
});
test("rarity masks extract label color before monochrome shape matching", () => {
  const pixels = new Uint8Array(NAME_WIDTH * NAME_HEIGHT * 4);
  pixels.set([210, 150, 40, 255], 0); // legendary
  pixels.set([125, 45, 165, 255], 4); // epic
  pixels.set([35, 155, 195, 255], 8); // rare
  assert.deepEqual(Array.from(nameMask(pixels, 4).slice(0, 3)), [1, 0, 0]);
  assert.deepEqual(Array.from(nameMask(pixels, 3).slice(0, 3)), [0, 1, 0]);
  assert.deepEqual(Array.from(nameMask(pixels, 2).slice(0, 3)), [0, 0, 1]);
});
