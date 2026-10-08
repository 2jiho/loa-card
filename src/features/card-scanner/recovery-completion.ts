import type { ScannedCard } from './recognizer';

export interface RecoveryCompletion {
  expected:number|null;
  finalExpected:number|null;
  cards:readonly ScannedCard[];
  latest:ReadonlyMap<string,number>;
  confirmed:ReadonlyMap<string,number>;
  pending:number;
  unresolved:number;
  dropped:number;
  inputSettled:boolean;
  tailFresh:boolean;
}

type ReadingEvidence = Pick<RecoveryCompletion, 'cards' | 'latest' | 'confirmed'>;

function freshlyConfirmed(card:ScannedCard,{latest,confirmed}:ReadingEvidence):boolean {
  const order=latest.get(card.id),proof=confirmed.get(card.id);
  return order!==undefined && proof!==undefined && Number.isFinite(order) && Number.isFinite(proof) && proof>=order &&
    !card.review.length && card.countReliable===true && card.awakening!==null && card.extraCopies!==null &&
    Number.isInteger(card.awakening)&&card.awakening>=0&&card.awakening<=5&&
    Number.isInteger(card.extraCopies)&&card.extraCopies>=0&&card.extraCopies<=15-card.awakening*(card.awakening+1)/2;
}

/** Unique, fully read cards supported by this scan's latest observations, never seeds alone. */
export function confirmedReadingCount(input:ReadingEvidence):number {
  return new Set(input.cards.filter(card=>freshlyConfirmed(card,input)).map(card=>card.id)).size;
}

/** Use only at an idle boundary, after acquired frames and readers settle.
 * Count equality, seed inventories, or older reliable counts are insufficient. */
export function canSkipRecovery(input:RecoveryCompletion):boolean {
  const {expected,finalExpected,cards,latest}=input;
  if(!input.inputSettled || !input.tailFresh || input.pending || input.unresolved || input.dropped ||
    expected===null || !Number.isInteger(expected) || expected<=0 || finalExpected!==expected ||
    cards.length!==expected || latest.size!==expected || new Set(cards.map(c=>c.id)).size!==expected)return false;
  return cards.every(card=>freshlyConfirmed(card,input));
}
