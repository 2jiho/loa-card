import { nameMask } from "./name-pattern";

/** Remove artwork while retaining observed glyph luminance instead of
 * binarizing strokes. Used only for failed-name OCR retries.
 */
export function softNamePixels(rgba: ArrayLike<number>, grade: number) {
  const mask = nameMask(rgba, grade);
  const pixels = new Uint8ClampedArray(mask.length * 4);
  for (let i = 0; i < mask.length; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const maximum = Math.max(r, g, b), minimum = Math.min(r, g, b);
    const foreground = mask[i] && maximum > 110 &&
      (grade === 0 || maximum - minimum > maximum * .275);
    const value = foreground ? .299 * r + .587 * g + .114 * b : 0;
    pixels.set([value, value, value, 255], i * 4);
  }
  return pixels;
}

/** Expand the observed ink range continuously; do not threshold or invent
 * strokes. Normalize one line so artwork/second-line ink cannot set its gain. */
export function normalizeSoftNamePixels(pixels: Uint8ClampedArray, height = 18) {
  const output = pixels.slice(0, 128 * height * 4);
  let maximum = 0;
  for (let i = 0; i < output.length; i += 4) maximum = Math.max(maximum, output[i]);
  if (!maximum) return output;
  for (let i = 0; i < output.length; i += 4) {
    const value = output[i] * 255 / maximum;
    output[i] = output[i + 1] = output[i + 2] = value;
  }
  return output;
}
