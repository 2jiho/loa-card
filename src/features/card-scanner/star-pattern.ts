/** Native 140x210 card: shape validates all slots before color counts awakening. */
export function readStarObservation(
  pixels: ArrayLike<number>,
  templates: number[][],
): { awakening: number; offsetY: number } | null {
  const positions: { x: number; y: number }[] = [];
  // Border correction can move the field coordinates in either direction.
  // Search around the old origin instead of clipping jewels shifted upward.
  const gray = new Float32Array(140 * 31);
  for (let y = 0; y < 31; y++)
    for (let x = 0; x < 140; x++) {
      const i = ((172 + y) * 140 + x) * 4;
      gray[y * 140 + x] =
        0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    }
  for (let slot = 0; slot < 5; slot++) {
    const cx = 140 * (0.205 + slot * 0.143),
      left = Math.floor(cx - 8);
    let best = 0,
      bestX = 0,
      bestY = 0;
    for (const template of templates) {
      const mean = template.reduce((sum, v) => sum + v, 0) / 170;
      const variance = template.reduce((sum, v) => sum + (v - mean) ** 2, 0);
      for (let dy = -4; dy <= 10; dy++)
        for (let dx = -4; dx <= 10; dx++) {
          let sum = 0,
            squares = 0,
            cross = 0;
          for (let y = 0; y < 17; y++)
            for (let x = 0; x < 10; x++) {
              const value = gray[(4 + dy + y) * 140 + left + dx + x];
              sum += value;
              squares += value * value;
              cross += value * (template[y * 10 + x] - mean);
            }
          const denominator = Math.sqrt(
            Math.max(0, squares - (sum * sum) / 170) * variance,
          );
          if (denominator > 0 && cross / denominator > best) {
            best = cross / denominator;
            bestX = dx;
            bestY = dy;
          }
        }
    }
    if (best < 0.75) return null;
    positions.push({ x: left + bestX, y: 176 + bestY });
  }
  const heights = positions.map(position => position.y - 176).sort((a, b) => a - b);
  if (heights[4] - heights[0] > 2) return null;
  // Native still captures peak at rows 2 or 3. Other peaks reveal a small
  // scrolling displacement that must also be applied to the text crops.
  const median = heights[2];
  const offsetY = median < 2 ? median - 2 : median > 3 ? median - 3 : 0;
  let level = 0,
    gap = false;
  for (let slot = 0; slot < 5; slot++) {
    const position = positions[slot];
    let gold = 0,
      total = 0;
    // The matched 10x17 jewel includes its outline. Count color only inside
    // that shape: the old surrounding rectangle included the gold hover glow
    // beneath gray jewels and could turn two active jewels into four.
    for (let y = position.y + 2; y < position.y + 14; y++)
      for (let x = position.x + 3; x < position.x + 7; x++) {
        const i = (y * 140 + x) * 4,
          r = pixels[i],
          g = pixels[i + 1],
          b = pixels[i + 2];
        if (r > 135 && g > 85 && r > b * 1.5 && g > b * 1.35) gold++;
        total++;
      }
    const active = gold / total > 0.15;
    if (active && gap) return null;
    if (active) level++;
    else gap = true;
  }
  return { awakening: level, offsetY };
}

export function readStarPatterns(
  pixels: ArrayLike<number>,
  templates: number[][],
): number | null {
  return readStarObservation(pixels, templates)?.awakening ?? null;
}
