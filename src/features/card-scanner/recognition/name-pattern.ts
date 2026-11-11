/** Fixed game label area only: excludes artwork below the name and all counters. */
export const NAME_WIDTH = 128;
export const NAME_HEIGHT = 36;
export function nameMask(rgba: ArrayLike<number>, rarity: number): Uint8Array {
  const mask = new Uint8Array(NAME_WIDTH * NAME_HEIGHT);
  for (let i = 0; i < mask.length; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const selected = rarity === 4 ? r > 100 && g > 70 && b < g * .8 && r > g * 1.12
      : rarity === 3 ? r > 85 && b > 90 && g < Math.min(r, b) * .88
      : rarity === 2 ? g > 90 && b > 100 && r < Math.min(g, b) * .8
      : rarity === 1 ? g > 100 && r > 40 && b < g * .65 && g > r * 1.1
      : Math.min(r, g, b) > 160 && Math.max(r, g, b) - Math.min(r, g, b) < 45;
    mask[i] = selected ? 1 : 0;
  }
  return mask;
}
/** Presence check only: preserve each rarity's 35-pixel rule without creating
 * five full masks or scanning the complete label after evidence is sufficient. */
export function hasNamePixels(rgba: ArrayLike<number>, offset = 0, stride = NAME_WIDTH): boolean {
  let normal = 0, uncommon = 0, rare = 0, epic = 0, legendary = 0;
  for (let y = 0; y < NAME_HEIGHT; y++) for (let x = 0, index = offset+y*stride*4; x < NAME_WIDTH; x++, index+=4) {
    const r = rgba[index], g = rgba[index + 1], b = rgba[index + 2];
    const minimum = Math.min(r, g, b);
    if (minimum > 160 && Math.max(r, g, b) - minimum < 45 && ++normal >= 35) return true;
    if (g > 100 && r > 40 && b < g * .65 && g > r * 1.1 && ++uncommon >= 35) return true;
    if (g > 90 && b > 100 && r < Math.min(g, b) * .8 && ++rare >= 35) return true;
    if (r > 85 && b > 90 && g < Math.min(r, b) * .88 && ++epic >= 35) return true;
    if (r > 100 && g > 70 && b < g * .8 && r > g * 1.12 && ++legendary >= 35) return true;
  }
  return false;
}
export function packName(mask: ArrayLike<number>, dx = 0, dy = 0) {
  const bits = new Uint32Array(NAME_WIDTH * NAME_HEIGHT / 32);
  let pixels = 0;
  for (let y = 0; y < NAME_HEIGHT; y++) for (let x = 0; x < NAME_WIDTH; x++) {
    const sx = x - dx, sy = y - dy;
    if (sx < 0 || sy < 0 || sx >= NAME_WIDTH || sy >= NAME_HEIGHT || !mask[sy * NAME_WIDTH + sx]) continue;
    const index = y * NAME_WIDTH + x;
    bits[index >>> 5] |= 1 << (index & 31);
    pixels++;
  }
  return { bits, pixels };
}
function popcount(value: number) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export function nameSimilarity(a: Uint32Array, aPixels: number, b: Uint32Array, bPixels: number) {
  if (aPixels < 35 || bPixels < 35) return 0;
  let overlap = 0;
  for (let i = 0; i < a.length; i++) overlap += popcount(a[i] & b[i]);
  return overlap / Math.sqrt(aPixels * bPixels);
}
