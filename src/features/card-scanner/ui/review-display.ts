/** Only card IDs support a count in kinds. Unattributed observations are a
 * separate warning and may outnumber, or overlap with, identifiable cards. */
export function knownReviewCardCount(reviewCards:readonly {id:string}[],missingCards:readonly {id:string}[]):number {
  return new Set([...reviewCards,...missingCards].map(card=>card.id)).size;
}
