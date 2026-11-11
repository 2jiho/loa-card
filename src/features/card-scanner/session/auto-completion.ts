import type {RecoveryCompletion} from './recovery-completion';
import {canSkipRecovery,confirmedReadingCount} from './recovery-completion';

/** Optional presentation work does not inspect pixels or update recognition
 * evidence. Capture may finish while such work is pending; its bounded drain
 * remains a separate prerequisite for final projection and persistence. */
export function captureInputSettled(input:{collectionBusy:boolean;readingJobs:number;acquisitionSettled:boolean;queueSettled:boolean}):boolean {
  return input.collectionBusy===false && input.readingJobs===0 && input.acquisitionSettled===true && input.queueSettled===true;
}

export type CaptureCompletion = Pick<RecoveryCompletion, 'expected' | 'finalExpected' | 'cards' | 'latest' | 'confirmed' | 'inputSettled' | 'fieldChangesSettled' | 'unresolved' | 'dropped'> & {
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
 * remain mandatory before stopping the share. Pending work must be processed
 * or retired by explicit proof before inputSettled permits the final stop. */
export function hasCompleteCaptureEvidence(input: Pick<CaptureCompletion, 'expected' | 'cards' | 'latest' | 'confirmedNames' | 'confirmed' | 'fieldChangesSettled' | 'unresolved' | 'dropped'>): boolean {
  return input.unresolved===0 && input.dropped===0 && hasVerifiedInventoryEvidence(input);
}

/** Per-original reuse still needs an exact receipt for each input; this
 * inventory-only check must never be used to end the scan. */
function hasVerifiedInventoryEvidence(input: Pick<CaptureCompletion, 'expected' | 'cards' | 'latest' | 'confirmedNames' | 'confirmed' | 'fieldChangesSettled'>): boolean {
  const {expected, cards, latest, confirmedNames} = input;
  if (input.fieldChangesSettled!==true || expected === null || !Number.isInteger(expected) || expected <= 0 ||
    cards.length !== expected || latest.size !== expected || new Set(cards.map(c => c.id)).size !== expected) return false;
  return confirmedCaptureCount({cards, latest, confirmedNames}) === expected &&
    confirmedReadingCount(input) === expected;
}

/** Keep acquiring better observations until names AND latest fields are proven.
 * Callers must also settle queued and active work before stopping capture. */
export function canStopSharing(input: CaptureCompletion): boolean {
  return input.inputSettled && input.headerAvailable && input.finalExpected === input.expected &&
    hasCompleteCaptureEvidence(input);
}

/** A previously located header cannot certify the currently unlocated view. */
export function currentHeaderAvailable(located:boolean,width:number,height:number,lastLocatedTime:number):boolean {
  return located&&Number.isFinite(width)&&width>0&&Number.isFinite(height)&&height>0&&Number.isFinite(lastLocatedTime);
}

/** An ended input can gain its last field proof after sharing has stopped.
 * Call only after acquired inputs/readers join and a fresh final header passes.
 * Unmatched observations must remain in recovery until independently resolved. */
export function canFinishEndedCapture(input: CaptureCompletion &
  Pick<RecoveryCompletion, 'pending' | 'unresolved' | 'dropped' | 'tailFresh'> &
  {inputClosed:boolean;headerVerified:boolean}): boolean {
  return input.inputClosed && input.headerVerified && canStopSharing(input) &&
    canSkipRecovery(input);
}

/** Gate for the encoder's mandatory per-original covered-receipt checks only.
 * Parallel readers may still have work. This cannot certify completion or
 * skip unknown future frames; every omitted original must separately prove
 * all its exact observations are covered by confirmed capture orders. */
export function canSkipCoveredOriginals(input:Omit<CaptureCompletion,'inputSettled'> & {
  inputClosed:boolean;headerVerified:boolean;metadataSettled:boolean;tailFresh:boolean;dropped:number;
}):boolean {
  return input.inputClosed&&input.headerVerified&&input.headerAvailable&&input.metadataSettled&&input.tailFresh&&
    input.dropped===0&&input.finalExpected===input.expected&&hasVerifiedInventoryEvidence(input);
}

/** Desktop capture can stop delivering frames when pixels do not change.
 * Stable identity coverage must not require another frame to end sharing. */
export class AutoCompletionHold {
  private signature='';
  private since=0;
  reset(){this.signature='';}
  observe(input:CaptureCompletion,now:number):boolean {
    if(!Number.isFinite(now)||!canStopSharing(input)){this.reset();return false;}
    // Repeat captures with the same verified values do not restart the hold.
    // A newly confirmed awakening/count does, even if the card ID is unchanged.
    const signature=JSON.stringify([input.expected,input.cards.map(c=>[c.id,c.awakening,c.extraCopies])
      .sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
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
