import type {RecoveryCompletion} from './recovery-completion';
import {canSkipRecovery,confirmedReadingCount} from './recovery-completion';

export type CaptureCompletion = Pick<RecoveryCompletion, 'expected' | 'finalExpected' | 'cards' | 'latest' | 'confirmed' | 'inputSettled' | 'fieldChangesSettled'> & {
  /** Current-run name proofs; restored inventories cannot supply these. */
  confirmedNames: ReadonlyMap<string, number>;
  headerAvailable: boolean;
};

export function confirmedCaptureCount(input: Pick<CaptureCompletion, 'cards' | 'latest' | 'confirmedNames'>): number {
  return input.cards.filter(card => {
    const order = input.latest.get(card.id), proof = input.confirmedNames.get(card.id);
    return !card.review.includes('이름 확인') && order !== undefined && proof !== undefined &&
      Number.isFinite(order) && Number.isFinite(proof) && proof >= order;
  }).length;
}

/** Check current-run evidence before reserving a pause in acquisition/readers.
 * In-flight input may still change it; settling and final-header verification
 * remain mandatory before stopping the share. Queued duplicates need not drain. */
export function hasCompleteCaptureEvidence(input: Pick<CaptureCompletion, 'expected' | 'cards' | 'latest' | 'confirmedNames' | 'confirmed' | 'fieldChangesSettled'>): boolean {
  const {expected, cards, latest, confirmedNames} = input;
  if (input.fieldChangesSettled===false || expected === null || !Number.isInteger(expected) || expected <= 0 ||
    cards.length !== expected || latest.size !== expected || new Set(cards.map(c => c.id)).size !== expected) return false;
  return confirmedCaptureCount({cards, latest, confirmedNames}) === expected &&
    confirmedReadingCount(input) === expected;
}

/** Keep acquiring better observations until names AND latest fields are proven.
 * Queued/noisy observations still remain available to post-share verification. */
export function canStopSharing(input: CaptureCompletion): boolean {
  return input.inputSettled && input.headerAvailable && input.finalExpected === input.expected &&
    hasCompleteCaptureEvidence(input);
}

/** An ended input can gain its last field proof after sharing has stopped.
 * Call only after acquired inputs/readers join and a fresh final header passes.
 * Unmatched crops remain in diagnostics; only their archive replay is skipped. */
export function canFinishEndedCapture(input: CaptureCompletion &
  Pick<RecoveryCompletion, 'pending' | 'unresolved' | 'dropped' | 'tailFresh'> &
  {inputClosed:boolean;headerVerified:boolean}): boolean {
  return input.inputClosed && input.headerVerified && canStopSharing(input) &&
    canSkipRecovery({...input,unresolved:0});
}

/** Gate for the encoder's mandatory per-original covered-receipt checks only.
 * Parallel readers may still have work. This cannot certify completion or
 * skip unknown future frames; every omitted original must separately prove
 * all its exact observations are covered by confirmed capture orders. */
export function canSkipCoveredOriginals(input:Omit<CaptureCompletion,'inputSettled'> & {
  inputClosed:boolean;headerVerified:boolean;metadataSettled:boolean;tailFresh:boolean;dropped:number;
}):boolean {
  return input.inputClosed&&input.headerVerified&&input.headerAvailable&&input.metadataSettled&&input.tailFresh&&
    input.dropped===0&&input.finalExpected===input.expected&&hasCompleteCaptureEvidence(input);
}

/** Desktop capture can stop delivering frames when pixels do not change.
 * Stable identity coverage must not require another frame to end sharing. */
export class AutoCompletionHold {
  private signature='';
  private since=0;
  reset(){this.signature='';}
  observe(input:CaptureCompletion,now:number):boolean {
    if(!Number.isFinite(now)||!canStopSharing(input)){this.reset();return false;}
    const signature=JSON.stringify([input.expected,input.cards.map(c=>c.id).sort()]);
    if(signature!==this.signature||now<this.since){
      this.signature=signature;this.since=now;return false;
    }
    return now-this.since>=1000;
  }
}

/** Track.stop() does not dispatch ended. Notify the scanner explicitly; never
 * abort its signal, because queued result publication/cleanup must finish. */
export function stopCompletedShare(stream:Pick<MediaStream,'getTracks'>,onStopped:()=>void) {
  stream.getTracks().forEach(track=>track.stop());
  onStopped();
}
