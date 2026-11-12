import {emptyCounterProof} from '../recognition/count-pattern';
import type {EmptyPreviewEvidence} from '../recognition/count-pattern';
import type {CountDiagnostics} from '../recognition/recognizer-types';

/** Which stored preview may confirm "no extra copies" for a card at the end of a scan.
 *
 * Previews are given in the order they should be preferred. A preview that shows an empty
 * counter is accepted only when no LATER capture of the same card showed a counter with a
 * positive count: a later observation overrides an earlier one, never the reverse. */
export interface PreviewCountReading {
  /** Capture order of the preview (larger is later). */
  readonly order:number;
  /** The preview shows an explicit empty counter. */
  readonly zero:boolean;
  /** The preview shows a counter icon with a positive count. */
  readonly positive:boolean;
}

/** Index of the preview to accept, or -1 when none may confirm zero. */
export function selectZeroPreview(readings:readonly PreviewCountReading[]):number {
  let latestPositive=-Infinity;
  for(const reading of readings)if(reading.positive&&reading.order>latestPositive)latestPositive=reading.order;
  return readings.findIndex(reading=>reading.zero&&reading.order>=latestPositive);
}

/** Whether a card still needs the end-of-scan re-read of its stored previews: its awakening is
 * read, its count is missing or an unconfirmed zero, and its review asks for the count. A
 * confirmed value never re-enters. */
export function needsPreviewZeroProof(card:{readonly awakening:number|null;readonly extraCopies:number|null;readonly countReliable?:boolean;readonly review:readonly string[]}):boolean {
  const needsZeroProof=card.extraCopies===null||(card.extraCopies===0&&card.countReliable===false);
  return card.awakening!==null&&needsZeroProof&&card.review.some(reason=>reason.includes('장수'));
}

/** What one stored preview of a card says about its count, from a re-read of that same capture
 * (never a new observation). `zero`: the reader read an explicit zero with no icon and the
 * card's awakening, or the counter area passes the strict empty-counter proof. `positive`: the
 * preview shows a counter icon with a positive count. */
export function previewZeroReading(input:{
  readonly values:{readonly awakening:number|null;readonly extraCopies:number|null;readonly countDiagnostics?:CountDiagnostics};
  /** The preview's counter area (`packCount` with diagnostics). */
  readonly packed:EmptyPreviewEvidence;
  readonly card:{readonly awakening:number;readonly observations:number};
  /** The scan reads still images (one observation of a still image is its own proof). */
  readonly stillImage:boolean;
}):{zero:boolean;positive:boolean;diagnostics:CountDiagnostics|undefined} {
  const {values,card}=input;
  let diagnostics=values.countDiagnostics;
  let zero=values.extraCopies===0&&diagnostics?.iconPresent===false&&values.awakening===card.awakening;
  if(!zero){
    const proof=emptyCounterProof(input.packed,card.observations,input.stillImage);
    if(proof){
      const maximum=15-card.awakening*(card.awakening+1)/2;
      diagnostics={maximum,reason:proof==='still-image'
          ?'정지 이미지 확인 · 빈 장수 배경 확인'
          :proof==='repeated-observations'
            ?'저장 이미지 재확인 · 다중 관측 빈 장수 배경 확인'
            :`저장 이미지 재확인 · 관측 ${card.observations}회 빈 장수 배경 확인 · 이후 관측으로 갱신`,
        readings:[],iconPresent:false};
      zero=true;
    }
  }
  return {zero,diagnostics,
    positive:!zero&&typeof values.extraCopies==='number'&&values.extraCopies>0&&values.countDiagnostics?.iconPresent!==false};
}

/** The reason recorded when the chosen preview's own reading gave none. */
export const PREVIEW_ZERO_REASON='저장 이미지 재확인 · 추가 카드 표시 없음 · 0장 후보';

/** Where the 140×210 field area lies inside a stored picture of a card.
 *
 * A stored preview is not the crop the reader read: it is the card with its crest, one field
 * unit wider on the left, right and bottom and three taller on top (`card-borders.ts`), at the
 * capture's own scale, so 142×214 units. Stretching the whole picture onto 140×210 moves the
 * count and awakening fields off their coordinates. A picture with exactly the field
 * proportions (a read crop kept as the picture, 140×210) is used whole; a preview has them
 * only by coincidence of rounding at some scales (never at scale 1).
 *
 * The scale is taken from the picture's size; the up-to-one-pixel widening that rounding the
 * box to whole pixels adds on each axis is split evenly between both sides, so the region is
 * exact when the card lies on whole pixels and within half a source pixel otherwise. */
export function previewFieldRegion(width:number,height:number):{x:number;y:number;width:number;height:number} {
  if(!(width>0&&height>0)||width*3===height*2)return {x:0,y:0,width,height};
  const scale=Math.min(width/142,height/214);
  return {x:scale+(width-142*scale)/2,y:3*scale+(height-214*scale)/2,width:140*scale,height:210*scale};
}
