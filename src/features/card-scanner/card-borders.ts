import type { Box } from "./detector";
import { borderIntegrity } from "./border-integrity";

/** Coarse window geometry locates the grid; paired border strokes refine translation. */
export function alignCardBorders(rgba: ArrayLike<number>, width: number, height: number, box: Box, scale = 1) {
  const brightness = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (y * width + x) * 4;
    return Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
  };
  const contrast = (inside: number | null, outside: number | null) => {
    if (inside === null || outside === null) return 0;
    // Cap artwork highlights; a border must be supported along both opposite sides.
    return Math.min(1, Math.max(0, inside - outside) / 45);
  };
  // Along-edge sample coordinates do not depend on the tested translation.
  // Keep the original floating-point expression and rounding boundaries.
  const samples = 24;
  const xs = new Array<number>(samples), ys = new Array<number>(samples);
  for (let i = 0; i < samples; i++) {
    const fraction = .16 + .68 * i / (samples - 1);
    xs[i] = Math.round(box.x + box.width * fraction);
    ys[i] = Math.round(box.y + box.height * fraction);
  }
  const edge = (axis: "x" | "y", delta: number, side: number) => {
    let score = 0;
    if (axis === "x") {
      const x = box.x + delta + (side ? box.width - 2 * scale : 0);
      const inside = Math.round(x), outside = Math.round(x + (side ? 3 : -3) * scale);
      for (let i = 0; i < samples; i++)
        score += contrast(brightness(inside, ys[i]), brightness(outside, ys[i]));
    } else {
      const y = box.y + delta + (side ? box.height - 3 * scale : 2 * scale);
      const inside = Math.round(y), outside = Math.round(y + (side ? 4 : -4) * scale);
      for (let i = 0; i < samples; i++)
        score += contrast(brightness(xs[i], inside), brightness(xs[i], outside));
    }
    return score / samples;
  };
  const refine = (axis: "x" | "y") => {
    const radius = Math.max(2, Math.round(3 * scale));
    const score = (delta: number) => Math.min(edge(axis, delta, 0), edge(axis, delta, 1));
    const original = score(0);
    let best = { delta: 0, score: original };
    for (let delta = -radius; delta <= radius; delta++) {
      const value = delta === 0 ? original : score(delta);
      if (value > best.score + .001 || (Math.abs(value - best.score) < .001 && Math.abs(delta) < Math.abs(best.delta))) best = { delta, score: value };
    }
    return best.score >= .6 && best.score - original >= .12 ? best.delta : 0;
  };
  const refined = { ...box, x: box.x + refine("x"), y: box.y + refine("y") };
  const integrity = borderIntegrity(rgba, width, height, refined, scale);
  // Only translate to a four-sided edge location; never align to an isolated
  // portrait highlight or a tooltip edge, and never stretch the card fields.
  const content = integrity.intact
    ? { ...refined, x: refined.x + integrity.dx, y: refined.y + integrity.dy }
    : refined;
  const alignment = integrity.minimum;
  // The decorative crest extends above the 140×210 field coordinate system.
  // Keep its original pixels in thumbnails without rescaling OCR field offsets.
  const left = Math.max(0, Math.floor(content.x - scale));
  const top = Math.max(0, Math.floor(content.y - 3 * scale));
  const right = Math.min(width, Math.ceil(content.x + content.width + scale));
  const bottom = Math.min(height, Math.ceil(content.y + content.height + scale));
  return { content, alignment, intact: integrity.intact, borderSides: integrity.sides, preview: { x: left, y: top, width: right - left, height: bottom - top } };
}
