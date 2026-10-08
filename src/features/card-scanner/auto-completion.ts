import type {RecoveryCompletion} from './recovery-completion';

export type CaptureCompletion = Pick<RecoveryCompletion, 'expected' | 'finalExpected' | 'cards' | 'latest' | 'inputSettled'> & {
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

/** Ending capture does not certify fields or skip recovery. Every identity
 * still needs a current-run proof and a captured header rechecked before stop.
 * Queued/noisy duplicate observations remain available to post-share recovery. */
export function canStopSharing(input: CaptureCompletion): boolean {
  const {expected, cards, latest, confirmedNames} = input;
  if (!input.inputSettled || !input.headerAvailable ||
    expected === null || !Number.isInteger(expected) || expected <= 0 || input.finalExpected !== expected ||
    cards.length !== expected || latest.size !== expected || new Set(cards.map(c => c.id)).size !== expected) return false;
  return confirmedCaptureCount({cards, latest, confirmedNames}) === expected;
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
