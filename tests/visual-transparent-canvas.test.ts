import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { alignCardBorders } from '../src/features/card-scanner/acquisition/card-borders';
import { integerCropPixels } from '../src/features/card-scanner/acquisition/integer-crop-pixels';
import { packCount, prepareContrastPattern } from '../src/features/card-scanner/recognition/count-pattern';
import { currentCountReliability } from '../src/features/card-scanner/recognition/count-confidence';
import { drawVisualRaster, inspectVisual, readVisual, reusableVisualPixels } from '../src/features/card-scanner/recognition/visual-fields';
import type { Raster, RasterContext } from '../src/features/card-scanner/acquisition/acquisition-raster';

test('transparent counter pixels cannot inherit a previous canvas or certify zero', async () => {
  const samples = JSON.parse(await readFile('tests/fixtures/border-integrity-samples.json', 'utf8'));
  const stars = JSON.parse(await readFile('public/scanner/stars.json', 'utf8'));
  const atlas = JSON.parse(await readFile('public/scanner/counter-patterns.json', 'utf8'));
  const sample = samples.find((entry: { name: string }) => entry.name === '검은 산의 포식자');
  assert.ok(sample);
  const pixels = new Uint8ClampedArray(Buffer.from(sample.rgba, 'base64'));
  const borders = alignCardBorders(pixels, sample.width, sample.height, sample.box);
  const previous = integerCropPixels(pixels, sample.width, sample.height, borders.content);
  assert.ok(previous);
  const next = previous.slice();
  // This is a synthetic transparent field, not a claim about a game capture.
  for (let y = 141; y < 172; y++) for (let x = 56; x < 139; x++)
    next.fill(0, (y * 140 + x) * 4, (y * 140 + x + 1) * 4);
  assert.equal(reusableVisualPixels(next, 140, 210), undefined);
  assert.equal(packCount(next).hasIcon, null);

  let scratch = new Uint8ClampedArray(140 * 210 * 4);
  const context = {
    globalCompositeOperation: 'source-over',
    drawImage(source: Uint8ClampedArray) {
      if (this.globalCompositeOperation === 'copy') scratch = source.slice();
      else for (let i = 0; i < scratch.length; i += 4) {
        assert.ok(source[i + 3] === 0 || source[i + 3] === 255);
        if (source[i + 3] === 255) scratch.set(source.subarray(i, i + 4), i);
      }
    },
    getImageData(x: number, y: number, width: number, height: number) {
      const data = integerCropPixels(scratch, 140, 210, { x, y, width, height });
      assert.ok(data);
      return { data };
    },
  };
  const rasterContext = context as unknown as RasterContext;
  const templates = [stars.gray[0], stars.gold[0]];
  const oldFields = inspectVisual(previous as unknown as Raster, rasterContext, templates);
  assert.equal(oldFields.hasIcon, false, 'the prior crop must exercise the stale-zero path');
  const fields = inspectVisual(next as unknown as Raster, rasterContext, templates);
  assert.equal(fields.hasIcon, null);
  assert.equal(context.globalCompositeOperation, 'source-over');
  const reading = readVisual(next as unknown as Raster, rasterContext, fields, atlas.patterns.map(prepareContrastPattern));
  assert.equal(reading.extraCopies, null);
  assert.equal(currentCountReliability({ stable: false, borderAlignment: borders.alignment,
    awakening: reading.awakening, extraCopies: reading.extraCopies,
    iconPresent: reading.countDiagnostics?.iconPresent, pattern: reading.countDiagnostics?.pattern }), 'unconfirmed');
});

test('visual draw restores the caller composite mode if drawing fails', () => {
  const context = { globalCompositeOperation: 'source-over', drawImage() { throw new Error('draw failed'); } };
  assert.throws(() => drawVisualRaster({} as Raster, context as unknown as RasterContext), /draw failed/);
  assert.equal(context.globalCompositeOperation, 'source-over');
});
