/** A guessed name must not donate counters/jewels to a confirmed DB identity.
 * Keep tentative values available when no confirmed observation exists yet. */
export function identityFieldPool<T extends { review: string[]; manual?: string[] }>(observations: T[]) {
  const confirmed = observations.filter(card => card.manual?.includes("name") ||
    !card.review.some(reason => reason === "이름 확인" || reason === "카드 식별 확인"));
  return confirmed.length ? confirmed : observations;
}
