import type { Box } from "./detector";

/** Four continuous edge locations, independent of rarity, brightness and OCR.
 * A dark but present edge differs from a missing edge behind a tooltip. */
export function borderIntegrity(rgba: ArrayLike<number>, width: number, height: number, box: Box, scale = 1) {
  const contrast = (x: number, y: number, nx: number, ny: number) => {
    x = Math.round(x); y = Math.round(y); nx = Math.round(nx); ny = Math.round(ny);
    if (Math.min(x, nx) < 0 || Math.min(y, ny) < 0 || Math.max(x, nx) >= width || Math.max(y, ny) >= height) return false;
    const a = (y * width + x) * 4, b = (ny * width + nx) * 4;
    return Math.max(Math.abs(rgba[a] - rgba[b]), Math.abs(rgba[a + 1] - rgba[b + 1]),
      Math.abs(rgba[a + 2] - rgba[b + 2])) >= 10;
  };
  const side = (axis: "x" | "y", delta: number, end: boolean) => {
    let visible = 0;
    for (let i = 0; i < 24; i++) {
      const fraction = .12 + .76 * i / 23;
      const x = axis === "x" ? box.x + delta + (end ? box.width - 2 * scale : 0) : box.x + box.width * fraction;
      const y = axis === "y" ? box.y + delta + (end ? box.height - 3 * scale : 2 * scale) : box.y + box.height * fraction;
      visible += Number(contrast(x, y, x + (axis === "x" ? (end ? 3 : -3) * scale : 0),
        y + (axis === "y" ? (end ? 4 : -4) * scale : 0)));
    }
    return visible / 24;
  };
  const radius = Math.max(1, Math.round(3 * scale));
  let best = { dx: 0, dy: 0, minimum: 0, sides: [0, 0, 0, 0] };
  const offsets = Array.from({ length: 2 * radius + 1 }, (_, i) => i - radius);
  const horizontal = offsets.map(delta => [side("x", delta, false), side("x", delta, true)]);
  const vertical = offsets.map(delta => [side("y", delta, false), side("y", delta, true)]);
  for (let yi = 0; yi < offsets.length; yi++) for (let xi = 0; xi < offsets.length; xi++) {
    const dx = offsets[xi], dy = offsets[yi];
    const minimum = Math.min(horizontal[xi][0], horizontal[xi][1], vertical[yi][0], vertical[yi][1]);
    if (minimum > best.minimum || (minimum === best.minimum && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy)))
      best = { dx, dy, minimum, sides: [horizontal[xi][0], horizontal[xi][1], vertical[yi][0], vertical[yi][1]] };
  }
  return { ...best, intact: best.minimum >= .85 };
}
