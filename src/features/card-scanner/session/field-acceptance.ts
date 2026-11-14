import {currentCountReliability} from '../recognition/count-confidence';
import type {CountReliability} from '../recognition/count-confidence';
import type {CountDiagnostics,ScannedCard} from '../recognition/recognizer-types';

/** The acceptance of ONE identified crop's values, shared by every path that reads a crop
 * (the scanner's candidate path and the row-centred path), so the rules cannot drift apart:
 * the count's reliability comes from this crop alone, an unconfirmed zero stays unread, and a
 * value that was not read is flagged for review instead of being filled in.
 *
 * Nothing here names a card, merges observations or completes a scan. */
export interface ReadFieldValues {
  awakening:number|null;
  extraCopies:number|null;
  countDiagnostics?:CountDiagnostics;
}

/** How far this crop's count can be trusted, from this crop's own evidence (pattern, text reader, the
 * empty counter on an intact card; count-confidence.ts, currentCountReliability).
 *
 * A still list alone certifies nothing: a misread repeats exactly on the same pixels. It still counts
 * for a value the text reader read on its own (where the count patterns cannot read the digits, as
 * on a 1920x1080 window): such a value read on a still list is as trusted as before. A value from the
 * count patterns alone is not, however still the list. */
export function readFieldReliability(values:ReadFieldValues,crop:{stable:boolean;borderAlignment:number;maxAwakening?:number}):CountReliability {
  const own=currentCountReliability({stable:crop.stable,borderAlignment:crop.borderAlignment,awakening:values.awakening,
    maxAwakening:crop.maxAwakening,extraCopies:values.extraCopies,
    pattern:values.countDiagnostics?.pattern,
    iconPresent:values.countDiagnostics?.iconPresent,
    patternOcrAgreed:values.countDiagnostics?.patternOcrAgreed,
    ocrConfirmedValue:values.countDiagnostics?.ocrConfirmedValue});
  if(own!=='unconfirmed'||!crop.stable)return own;
  return values.extraCopies!==null&&values.countDiagnostics?.ocrConfirmedValue===values.extraCopies?'stable-frame':own;
}

/** A crop's count as an independent text reading: a fresh reading by the text reader (not reused from
 * its cache) that agrees with the count patterns' first candidate, on an intact card. Null otherwise. */
export interface TextCountReading {readonly frameId:number;readonly time:number;readonly awakening:number|null;readonly value:number}
export function textCountReading(values:ReadFieldValues,crop:{frameId:number;time:number;borderAlignment:number}):TextCountReading|null {
  const count=values.countDiagnostics;
  if(values.extraCopies===null||values.extraCopies<=0||crop.borderAlignment<.8||count?.reason==='캐시 판독')return null;
  if(count?.ocrConfirmedValue!==values.extraCopies||count.pattern?.candidate!==values.extraCopies)return null;
  return {frameId:crop.frameId,time:crop.time,awakening:values.awakening,value:values.extraCopies};
}
/** Whether an earlier text reading of the same card, from another frame at least 0.25 s apart, read the
 * same awakening and count: two independent readings then confirm it. A retry of the same frame is
 * not another reading. */
export function agreesWithEarlierReading(earlier:readonly TextCountReading[],reading:TextCountReading):boolean {
  return earlier.some(other=>other.frameId!==reading.frameId&&Math.abs(other.time-reading.time)>=.25&&
    other.awakening===reading.awakening&&other.value===reading.value);
}

/** Settle the values of a crop once its count reliability is final. Changes `values` in place:
 * a zero that could not be confirmed becomes unread (null), never an observed zero. Returns
 * the review flags of the observation: the identity's own, plus one per value left unread. */
export function settleReadFields(values:ReadFieldValues,identityReview:readonly string[],reliability:CountReliability):string[] {
  if(values.extraCopies===0&&reliability==='unconfirmed'){
    values.extraCopies=null;
    if(values.countDiagnostics)values.countDiagnostics.reason='추가 카드 표시 없음 · 온전한 카드 또는 안정된 장수 영역 확인 필요';
  }
  if(values.countDiagnostics)values.countDiagnostics.reliability=reliability;
  const review=[...identityReview];
  if(values.awakening===null)review.push('각성 확인');
  if(values.extraCopies===null)review.push('추가 장수 확인');
  return review;
}

/** The observation a settled crop contributes: one crop, one observation, at its capture order. */
export function observedCard<Identity extends {nameEvidence:NonNullable<ScannedCard['nameEvidence']>},Values extends ReadFieldValues>(input:{
  identity:Identity;values:Values;review:string[];reliability:CountReliability;
  /** Preview image (data URL), or '' when there is none yet. */
  image:string;time:number;order:number;stable:boolean;
  position:NonNullable<ScannedCard['capturePosition']>;
}):Identity&Values&Pick<ScannedCard,'review'|'image'|'time'|'captureOrder'|'capturePosition'|'countReliable'|'observations'|'nameEvidence'> {
  const {identity,values,position}=input;
  return {
    ...identity,
    ...values,
    nameEvidence:identity.nameEvidence.map(reading=>({...reading,stable:input.stable,frame:position.frame})),
    review:input.review,
    image:input.image,
    time:input.time,
    captureOrder:input.order,
    capturePosition:position,
    countReliable:input.reliability!=='unconfirmed',
    observations:1,
  };
}
