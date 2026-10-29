import type {ScannedCard} from './recognizer';

/** Exact retries are not independent votes. Retain differing OCR evidence and
 * every fresh capture; arbitrary tail truncation would change consensus. */
export function appendObservation(history:ScannedCard[],next:ScannedCard) {
  const sameFrame=history.filter(old=>next.captureOrder!==undefined&&old.captureOrder===next.captureOrder&&
    !!next.capturePosition?.frame&&old.capturePosition?.frame===next.capturePosition.frame);
  const signature=(card:ScannedCard)=>JSON.stringify({id:card.id,name:card.name,awakening:card.awakening,
    extraCopies:card.extraCopies,countReliable:card.countReliable,confidence:card.confidence,review:card.review,manual:card.manual,
    // IDs are allocated anew by OCR retries of an unchanged frame.
    evidence:card.nameEvidence?.map(({readingId,...proof})=>{void readingId;return proof;}),diagnostics:card.countDiagnostics});
  if(sameFrame.length&&sameFrame.some(old=>signature(old)===signature(next)))return false;
  history.push(next);return true;
}
