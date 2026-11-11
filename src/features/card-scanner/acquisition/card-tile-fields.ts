import type {ScannedCard} from '../recognition/recognizer-types';
import {CURRENT_FIELD_REVIEW} from '../session/current-scan-fields';

/** Display only values that have current field evidence. Historical values
 * remain on the card for recovery, but are not represented as current. */
export function displayCardFields(card:Pick<ScannedCard,'awakening'|'extraCopies'|'review'|'countReliable'>) {
  const latestUnresolved=card.review.includes(CURRENT_FIELD_REVIEW);
  const awakeningUnresolved=latestUnresolved||card.review.some(reason=>reason.includes('각성'));
  const copiesUnresolved=latestUnresolved||card.countReliable===false||card.review.some(reason=>reason.includes('장수'));
  return {
    awakening:awakeningUnresolved?null:card.awakening,
    extraCopies:copiesUnresolved?null:card.extraCopies,
  };
}
