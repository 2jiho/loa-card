/** Reject only a nearly uniform first-name line, never infer a card identity.
 * RGB range preserves dim/gray ink that the rarity-color test cannot see.
 * The inset excludes the frame and artwork; a second line cannot replace a
 * missing first line. Textured or text-bearing overlays remain uncertain.
 */
/** How far the name band's strokes stand out from its plate: the larger of how far its brightest
 * pixels stand above its middle and its darkest below it (luminance, 95th - 50th and 50th - 5th
 * percentile). Text stands well out either way (light strokes on a dark plate, or dark on light); an
 * empty slot, a plate washed out by the hover glow or a covered band does not. */
export function nameBandSpread(rgba: ArrayLike<number>, width: number, height: number): number {
  if (width < 70 || height < 105 || rgba.length !== width * height * 4) return Infinity;
  const left = Math.ceil(width * 12 / 140), right = Math.floor(width * 128 / 140);
  const top = Math.ceil(height * 15 / 210), bottom = Math.floor(height * 35 / 210);
  const counts = new Uint32Array(256);let n = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = (y * width + x) * 4;counts[Math.round(.299 * rgba[i] + .587 * rgba[i + 1] + .114 * rgba[i + 2])]++;n++;
  }
  const at = (share: number) => {let seen = 0;for (let v = 0; v < 256; v++) {seen += counts[v];if (seen > share * n) return v;}return 255;};
  const middle = at(.5);
  return Math.max(at(.95) - middle, middle - at(.05));
}
export function blankNameLine(rgba: ArrayLike<number>, width: number, height: number): boolean {
  if (width < 70 || height < 105 || rgba.length !== width * height * 4) return false;
  const left = Math.ceil(width * 12 / 140), right = Math.floor(width * 128 / 140);
  const top = Math.ceil(height * 17 / 210), bottom = Math.floor(height * 30 / 210);
  const low = [255, 255, 255], high = [0, 0, 0];
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const offset = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const value = rgba[offset + channel];
      low[channel] = Math.min(low[channel], value);
      high[channel] = Math.max(high[channel], value);
      if (high[channel] - low[channel] > 6) return false;
    }
  }
  return true;
}
