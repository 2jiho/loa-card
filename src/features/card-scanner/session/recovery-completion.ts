import type { ScannedCard } from '../recognition/recognizer-types';
import { hasCurrentFieldProof } from './current-scan-fields';

export interface RecoveryCompletion {
  expected:number|null;
  finalExpected:number|null;
  cards:readonly ScannedCard[];
  latest:ReadonlyMap<string,number>;
  confirmed:ReadonlyMap<string,number>;
  agreed?:ReadonlyMap<string,number>;
  pending:number;
  unresolved:number;
  dropped:number;
  inputSettled:boolean;
  tailFresh:boolean;
  /** New raw-field selections must resolve even when the old inventory is complete. */
  fieldChangesSettled:boolean;
}

type ReadingEvidence = Pick<RecoveryCompletion, 'cards' | 'latest' | 'confirmed' | 'agreed'>;

/** A verified auto-stop can tolerate a transient failed layout detection after
 * its recent header. Manual stops still require the final view to be located. */
export function freshCaptureTail(located:boolean,verifiedAutoStop:boolean,lastLocated:number,endedAt:number|undefined) {
  return (located||verifiedAutoStop)&&Number.isFinite(lastLocated)&&endedAt!==undefined&&Number.isFinite(endedAt)&&
    lastLocated>=endedAt-1&&lastLocated<=endedAt;
}

function freshlyConfirmed(card:ScannedCard,{latest,confirmed,agreed}:ReadingEvidence):boolean {
  return hasCurrentFieldProof(card.id,{latest,confirmed,agreed}) &&
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
  if(input.fieldChangesSettled!==true || !input.inputSettled || !input.tailFresh || input.pending!==0 || input.unresolved!==0 || input.dropped!==0 ||
    expected===null || !Number.isInteger(expected) || expected<=0 || finalExpected!==expected ||
    cards.length!==expected || latest.size!==expected || new Set(cards.map(c=>c.id)).size!==expected)return false;
  return cards.every(card=>freshlyConfirmed(card,input));
}

/** A verified stop does not make unmatched observations disappear. All
 * unresolved groups still require recovery or explicit review. */
export function canFinishVerifiedCapture(input:RecoveryCompletion, verifiedAutoStop:boolean):boolean {
  return verifiedAutoStop && canSkipRecovery(input);
}
