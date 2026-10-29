import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  readStarPatterns,
  readStarObservation,
} from "../src/features/card-scanner/star-pattern.ts";
import { packCount } from "../src/features/card-scanner/count-pattern.ts";

test("visually checked game jewel samples retain their awakening levels in Worker matching", async () => {
  const stars = JSON.parse(await readFile("public/scanner/stars.json", "utf8"));
  const samples = JSON.parse(
    await readFile("tests/fixtures/star-samples.json", "utf8"),
  );
  for (const sample of samples) {
    const pixels = new Uint8Array(140 * 210 * 4);
    pixels.set(Buffer.from(sample.rgba, "base64"), 176 * 140 * 4);
    assert.equal(
      readStarPatterns(pixels, [stars.gray[0], stars.gold[0]]),
      sample.awakening,
      sample.name,
    );
    // A cropped or loading row must remain unknown, never become zero awakening.
    pixels.fill(0, 176 * 140 * 4, 190 * 140 * 4);
    assert.equal(
      readStarPatterns(pixels, [stars.gray[0], stars.gold[0]]),
      null,
    );
  }
});

test("small scrolling displacement is measured without changing jewel counts", async () => {
  const stars = JSON.parse(await readFile("public/scanner/stars.json", "utf8"));
  const samples = JSON.parse(
    await readFile("tests/fixtures/star-samples.json", "utf8"),
  );
  for (const sample of samples)
    for (const offset of [-4, -2, 3, 4]) {
      const source = Buffer.from(sample.rgba, "base64"),
        pixels = new Uint8Array(140 * 210 * 4);
      for (let row = 0; row < source.length / (140 * 4); row++) {
        const y = 176 + row + offset;
        if (y >= 0 && y < 210)
          pixels.set(
            source.subarray(row * 140 * 4, (row + 1) * 140 * 4),
            y * 140 * 4,
          );
      }
      const result = readStarObservation(pixels, [
        stars.gray[0],
        stars.gold[0],
      ]);
      assert.equal(
        result?.awakening,
        sample.awakening,
        `${sample.name}: ${offset}`,
      );
      assert.ok(
        result && Math.abs(result.offsetY - offset) <= 1,
        `${sample.name}: alignment`,
      );
    }
});

test("gold hover glow below intact jewels cannot activate their gray interiors", async () => {
  const stars = JSON.parse(await readFile("public/scanner/stars.json", "utf8"));
  const samples = JSON.parse(await readFile("tests/fixtures/star-samples.json", "utf8"));
  for (const sample of samples)
    for (const shift of [-2, 0, 3]) {
      const pixels = new Uint8Array(140 * 210 * 4);
      pixels.set(Buffer.from(sample.rgba, "base64"), (176 + shift) * 140 * 4);
      // A wide gold halo immediately below the jewel outlines. The game hover
      // can light this background while the inactive jewel centers stay gray.
      for (let y = 196 + shift; y < Math.min(210, 205 + shift); y++)
        for (let x = 16; x < 124; x++)
          pixels.set([236, 194, 58, 255], (y * 140 + x) * 4);
      assert.equal(readStarPatterns(pixels, [stars.gray[0], stars.gold[0]]),
        sample.awakening, `${sample.name}: footer glow at ${shift}`);
    }
});

test("jewel interior color follows the matched shape during horizontal and vertical crop displacement", async () => {
  const stars = JSON.parse(await readFile("public/scanner/stars.json", "utf8"));
  const samples = JSON.parse(await readFile("tests/fixtures/star-samples.json", "utf8"));
  for (const sample of samples)
    for (const [dx, dy] of [[-3, -2], [3, 3]]) {
      const source = Buffer.from(sample.rgba, "base64"), pixels = new Uint8Array(140 * 210 * 4);
      for (let row = 0; row < source.length / (140 * 4); row++)
        for (let x = 0; x < 140; x++) {
          const targetX = x + dx, targetY = 176 + row + dy;
          if (targetX >= 0 && targetX < 140 && targetY >= 0 && targetY < 210)
            pixels.set(source.subarray((row * 140 + x) * 4, (row * 140 + x + 1) * 4),
              (targetY * 140 + targetX) * 4);
        }
      const result = readStarObservation(pixels, [stars.gray[0], stars.gold[0]]);
      assert.equal(result?.awakening, sample.awakening, `${sample.name}: ${dx},${dy}`);
      assert.ok(result && Math.abs(result.offsetY - dy) <= 1, `${sample.name}: text offset retained`);
    }
});

test("a gold jewel after gray ones still rejects an impossible awakening prefix", async () => {
  const stars = JSON.parse(await readFile("public/scanner/stars.json", "utf8"));
  const samples = JSON.parse(await readFile("tests/fixtures/star-samples.json", "utf8"));
  const gray = samples.find((sample:{awakening:number}) => sample.awakening === 0);
  const gold = samples.find((sample:{awakening:number}) => sample.awakening === 2);
  const pixels = new Uint8Array(140 * 210 * 4), source = Buffer.from(gold.rgba, "base64");
  pixels.set(Buffer.from(gray.rgba, "base64"), 176 * 140 * 4);
  // Move an actual active first jewel to the third slot of an all-gray row.
  for (let row = 0; row < 27; row++)
    pixels.set(source.subarray((row * 140 + 20) * 4, (row * 140 + 40) * 4),
      ((176 + row) * 140 + 60) * 4);
  assert.equal(readStarObservation(pixels, [stars.gray[0], stars.gold[0]]), null);
});

test("white count-like artwork without the cyan card icon is not a positive count", () => {
  const pixels = new Uint8Array(140 * 210 * 4);
  for (let y = 148; y < 160; y++)
    for (let x = 100; x < 110; x++)
      pixels.fill(255, (y * 140 + x) * 4, (y * 140 + x + 1) * 4);
  const result = packCount(pixels);
  assert.ok(result.pixels > 35);
  assert.equal(result.hasIcon, false);
});
