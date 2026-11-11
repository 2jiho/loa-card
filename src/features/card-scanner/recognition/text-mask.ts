import { nameMask } from "./name-pattern";

/** Saturated rarity ink rejects similarly colored, low-saturation artwork. */
export function strongNameMask(rgba: ArrayLike<number>, grade: number) {
  return nameMask(rgba, grade).map((value, i) => {
    const r = rgba[i * 4],
      g = rgba[i * 4 + 1],
      b = rgba[i * 4 + 2];
    const saturated =
      grade === 4
        ? b < g * 0.3
        : grade === 3
          ? g < Math.min(r, b) * 0.5
          : grade === 2
            ? r < Math.min(g, b) * 0.4
            : grade === 1
              ? b < g * 0.25
              : true;
    return value & Number(saturated);
  });
}

/** A fast-scroll crop with no complete jewels needs a plausible full name band. */
export function hasNameBand(rgba: ArrayLike<number>) {
  return Array.from({ length: 5 }, (_, grade) =>
    strongNameMask(rgba, grade),
  ).some((mask) => {
    const visited = new Uint8Array(128 * 18);
    let ink = 0;
    for (let start = 0; start < visited.length; start++) {
      if (visited[start] || !mask[start]) continue;
      const queue = [start];
      visited[start] = 1;
      let left = 128,
        right = 0,
        top = 18,
        bottom = 0;
      for (let at = 0; at < queue.length; at++) {
        const i = queue[at],
          x = i % 128,
          y = Math.floor(i / 128);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          const sx = x + dx,
            sy = y + dy,
            j = sy * 128 + sx;
          if (
            sx >= 0 &&
            sx < 128 &&
            sy >= 0 &&
            sy < 18 &&
            !visited[j] &&
            mask[j]
          ) {
            visited[j] = 1;
            queue.push(j);
          }
        }
      }
      const height = bottom - top + 1;
      if (
        top >= 1 &&
        top <= 6 &&
        bottom <= 16 &&
        height >= 9 &&
        right - left < 24 &&
        left > 0 &&
        right < 127
      )
        ink += queue.length;
    }
    return ink >= 35;
  });
}
