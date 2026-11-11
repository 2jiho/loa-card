/** A book effect is active when enough member cards are owned and their
 * combined level reaches the threshold. Missing levels count as zero. */
export function bookEffectActive(
  book: {cardIds: readonly string[]},
  effect: {requiredCount: number; threshold: number},
  levels: ReadonlyMap<string, number>,
): boolean {
  let count = 0, sum = 0;
  for (const id of book.cardIds) {
    const level = levels.get(id);
    if (level !== undefined) {
      count++;
      sum += level;
    }
  }
  return count >= effect.requiredCount && sum >= effect.threshold;
}
