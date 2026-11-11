/** Bounded image-only retries for a final duplicate re-read. They never run on
 * the live recognition path and never supply a card identity by themselves. */
export const FINAL_DUPLICATE_VARIANTS = ['stretch+unsharp', 'shiftLeft4', 'shiftRight2'] as const;
export type FinalDuplicateVariant = typeof FINAL_DUPLICATE_VARIANTS[number];

function copy(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 140; canvas.height = 210;
  const context = canvas.getContext('2d', {willReadFrequently: true})!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, 140, 210);
  return canvas;
}

function stretch(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d', {willReadFrequently: true})!;
  const data = context.getImageData(0, 0, 140, 210);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.data.length; i += 4) {
    const gray = Math.round(.299 * data.data[i] + .587 * data.data[i + 1] + .114 * data.data[i + 2]);
    histogram[gray]++;
  }
  const total = data.data.length / 4, lowCount = total * .02, highCount = total * .98;
  let acc = 0, low = 0, high = 255;
  for (let value = 0; value < 256; value++) { acc += histogram[value]; if (acc >= lowCount) { low = value; break; } }
  acc = 0;
  for (let value = 0; value < 256; value++) { acc += histogram[value]; if (acc >= highCount) { high = value; break; } }
  const scale = high > low ? 255 / (high - low) : 1;
  for (let i = 0; i < data.data.length; i += 4) {
    for (let c = 0; c < 3; c++) data.data[i + c] = Math.max(0, Math.min(255, Math.round((data.data[i + c] - low) * scale)));
  }
  context.putImageData(data, 0, 0);
}

function unsharp(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d', {willReadFrequently: true})!;
  const source = context.getImageData(0, 0, 140, 210).data;
  const out = new Uint8ClampedArray(source);
  for (let y = 1; y < 209; y++) for (let x = 1; x < 139; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        sum += source[((y + dy) * 140 + (x + dx)) * 4 + c];
      }
      const index = (y * 140 + x) * 4 + c;
      out[index] = Math.max(0, Math.min(255, Math.round(source[index] + (source[index] - sum / 9))));
    }
  }
  context.putImageData(new ImageData(out, 140, 210), 0, 0);
}

export function finalDuplicateCanvas(source: HTMLCanvasElement, variant: FinalDuplicateVariant): HTMLCanvasElement {
  if (variant === 'shiftLeft4' || variant === 'shiftRight2') {
    const canvas = document.createElement('canvas');
    canvas.width = 140; canvas.height = 210;
    const context = canvas.getContext('2d', {willReadFrequently: true})!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, variant === 'shiftLeft4' ? -4 : 2, 0, 140, 210);
    return canvas;
  }
  const canvas = copy(source);
  stretch(canvas);
  unsharp(canvas);
  return canvas;
}
