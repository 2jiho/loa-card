export interface GridMotion {
  accept: boolean;
  stable: boolean;
  rowShift: number | null;
  changed: boolean;
}
function distance(a: ArrayLike<number>, b: ArrayLike<number>) {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
/** Compare only the same column: vertical scrolling preserves column identity. */
export function estimateRowShift(
  previous: Uint8Array[],
  current: Uint8Array[],
) {
  if (previous.length !== 40 || current.length !== 40) return null;
  const candidates = [];
  for (let shift = -3; shift <= 3; shift++) {
    const scores = [];
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 10; col++) {
        const oldRow = row + shift;
        if (oldRow >= 0 && oldRow < 4)
          scores.push(
            distance(previous[oldRow * 10 + col], current[row * 10 + col]),
          );
      }
    if (scores.length >= 20)
      candidates.push({
        shift,
        score: scores.reduce((n, v) => n + v, 0) / scores.length,
        matched: scores.filter((s) => s < 6).length / scores.length,
      });
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  return best &&
    best.score < 6 &&
    best.matched >= 0.8 &&
    (candidates[1]?.score ?? Infinity) - best.score >= 3
    ? best.shift
    : null;
}
