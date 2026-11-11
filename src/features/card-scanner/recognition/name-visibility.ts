/** Reject only a nearly uniform first-name line, never infer a card identity.
 * RGB range preserves dim/gray ink that the rarity-color test cannot see.
 * The inset excludes the frame and artwork; a second line cannot replace a
 * missing first line. Textured or text-bearing overlays remain uncertain.
 */
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
