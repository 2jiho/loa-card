import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankNameLine } from '../src/features/card-scanner/name-visibility';
import { inspectCapture, CaptureObservations } from '../src/features/card-scanner/capture-quality';
import { alignCardBorders } from '../src/features/card-scanner/card-borders';
import { observationPixels } from '../src/features/card-scanner/observation-pixels';

type Sample = { name: string; intact: boolean; width: number; height: number; rgba: string;
  box: { x: number; y: number; width: number; height: number } };
const samples: Sample[] = JSON.parse(readFileSync('tests/fixtures/border-integrity-samples.json', 'utf8'));

test('real names survive while a flat inner cover is rejected before observation grouping', () => {
  for (const sample of samples.filter(s => s.intact)) {
    const original = Uint8Array.from(Buffer.from(sample.rgba, 'base64'));
    const covered = original.slice(), b = sample.box;
    for (let y = Math.ceil(b.y + 14); y < Math.floor(b.y + 48); y++)
      for (let x = Math.ceil(b.x + 12); x < Math.floor(b.x + b.width - 12); x++)
        covered.set([20, 20, 20, 255], (y * sample.width + x) * 4);
    assert.equal(alignCardBorders(covered, sample.width, sample.height, b).intact, true, sample.name);
    const crop = (source: Uint8Array) => {
      const out = new Uint8Array(b.width * b.height * 4);
      for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
        const index = ((b.y + y) * sample.width + b.x + x) * 4;
        out.set(source.subarray(index, index + 4), (y * b.width + x) * 4);
      }
      return out;
    };
    const good = crop(original), bad = crop(covered);
    assert.equal(blankNameLine(good, b.width, b.height), false, sample.name);
    assert.equal(blankNameLine(bad, b.width, b.height), true, sample.name);
    const observations = new CaptureObservations();
    const accepted = [bad, bad, good].filter(pixels => inspectCapture(pixels, b.width, b.height, true, true, true, true).usable);
    assert.equal(accepted.length, 1, sample.name);
    assert.equal(observations.offerDetailed(observationPixels(accepted[0], b.width, b.height).feature, 0, 10, true).decision, 'new');
  }
});

test('real name shapes survive grayscale low contrast, scaling and vertical shifts', () => {
  const patterns: { id: string; bits: string }[] = JSON.parse(readFileSync('tests/fixtures/name-visibility-samples.json', 'utf8')).patterns;
  for (const pattern of patterns) {
    const bits = Buffer.from(pattern.bits, 'base64');
    for (const scale of [.75, 1, 1.5]) for (const shift of [-2, 0, 2]) {
      const width = Math.round(140 * scale), height = Math.round(210 * scale);
      const rgba = new Uint8Array(width * height * 4).fill(30);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const lx = Math.floor(x / scale) - 6, ly = Math.floor(y / scale) - 14 - shift;
        if (lx < 0 || lx >= 128 || ly < 0 || ly >= 36) continue;
        const index = ly * 128 + lx;
        if ((bits[index >>> 3] >>> (index & 7)) & 1) rgba.set([38, 38, 38, 255], (y * width + x) * 4);
      }
      assert.equal(blankNameLine(rgba, width, height), false, `${pattern.id}: scale=${scale}, shift=${shift}`);
    }
  }
});

test('uniform colored overlays and small compression noise have no readable strokes', () => {
  for (const color of [[20,20,20], [190,190,190], [40,160,190]]) {
    const rgba = new Uint8Array(140 * 210 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([...color.map(c => c + (i % 7)), 255], i);
    assert.equal(blankNameLine(rgba, 140, 210), true);
    assert.equal(inspectCapture(rgba, 140, 210, true, true, true, true).usable, false);
  }
  assert.equal(blankNameLine(new Uint8Array(4), 140, 210), false);
  assert.equal(blankNameLine(new Uint8Array(20 * 30 * 4), 20, 30), false);
});
