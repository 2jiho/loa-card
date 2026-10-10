export type ScanWorkPhase = 'capture' | 'reading' | 'recovery' | 'verifying' | 'cleanup';
export interface ReadSample { time: number; completed: number }

export function formatScanTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return value < 60 ? `${value}초` : `${Math.floor(value / 60)}분 ${value % 60}초`;
}

/** A recent, advancing post-capture sample can estimate reading, not final cleanup. */
export function readingEstimate(samples: readonly ReadSample[], total: number | null, collected: number) {
  if (total === null || !Number.isInteger(total) || total <= 0 || collected < total || samples.length < 2) return null;
  const end = samples.at(-1)!;
  const recent = samples.filter(sample => end.time - sample.time <= 20);
  const first = recent[0];
  if (!first || end.completed >= total || end.time - first.time < 5) return null;
  if (recent.some((sample, i) => i > 0 && sample.completed < recent[i - 1].completed)) return null;
  const gain = end.completed - first.completed;
  const lastAdvance = recent.findLast((sample, i) => i > 0 && sample.completed > recent[i - 1].completed);
  if (gain < 3 || !lastAdvance || end.time - lastAdvance.time >= 5) return null;
  const seconds = (total - end.completed) * (end.time - first.time) / gain;
  return { low: Math.max(5, Math.floor(seconds * .75 / 5) * 5), high: Math.max(10, Math.ceil(seconds * 1.5 / 5) * 5) };
}
