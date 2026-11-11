export interface DiscardableObservation {
  time: number;
  reason?: string;
}

/** Move remaining hard-to-read observations out of the unresolved list without
 * inventing a card, name, awakening, or copy count. The original object and its
 * evidence fields are preserved; only a missing reason gets a UI fallback. */
export function discardRemainingObservations<T extends DiscardableObservation>(
  observations: readonly T[],
): (T & {reason: string})[] {
  return observations.map(observation => ({
    ...observation,
    reason: observation.reason?.trim() || '판독 불가',
  }));
}
