import { packCount, matchCountPattern } from './count-pattern';
import type { ContrastPattern } from './count-pattern';
import { readStarObservation } from './star-pattern';
import { hasNameBand } from './text-mask';
import { nameMask } from './name-pattern';
import { blankNameLine } from './name-visibility';
import type { createPortraitMatcher } from './portrait-matcher';
import type { CountDiagnostics } from './recognizer';
import type { Raster, RasterContext } from './acquisition-raster';
import { pixelRegion } from './pixel-region';

/** Only native-size opaque rasters equal the existing draw/readback path.
 * This snapshot belongs to one invocation; never cache it across observations. */
export function reusableVisualPixels(pixels:Uint8ClampedArray,width:number,height:number):Uint8ClampedArray|undefined {
  if(width!==140||height!==210||pixels.length!==140*210*4)return;
  for(let i=3;i<pixels.length;i+=4)if(pixels[i]!==255)return;
  return pixels;
}
/** Require a readable positive counter, not the weaker icon/color hint. */
export function consistentAwakening(level: number | null, extraCopies: number | null) {
  return level === 5 && extraCopies !== null && Number.isInteger(extraCopies) &&
    extraCopies > 0 && extraCopies <= 15 ? null : level;
}
export function portraitIdentity(artwork: NonNullable<ReturnType<ReturnType<typeof createPortraitMatcher>>>) {
    return {
      id: artwork.card.id, name: artwork.card.name, confidence: artwork.portrait.correlation,
      nameEvidence: [{ rawText: "", engine: "artwork" as const,
        readingId: crypto.randomUUID(), fingerprint: "portrait", ocrConfidence: 0,
        score: artwork.portrait.correlation, gap: artwork.portrait.margin,
        exact: false, portrait: artwork.portrait }],
      review: [] as string[], identitySource: "artwork" as const, maxAwakening: artwork.card.maxAwakening,
    };
  }

export function inspectVisual(canvas: Raster, context: RasterContext, templates: number[][], snapshot?:Uint8ClampedArray) {
    if(!snapshot)context.drawImage(canvas, 0, 0, 140, 210);
    const pixels = snapshot??context.getImageData(0, 0, 140, 210).data;
    const label = snapshot?pixelRegion({data:snapshot,width:140,height:210},6,14,128,36)!.data:context.getImageData(6, 14, 128, 36).data;
    const labelPixels = Math.max(
      ...Array.from({ length: 5 }, (_, grade) =>
        nameMask(label, grade).reduce((n, v) => n + v, 0),
      ),
    );
    const jewels =
      readStarObservation(pixels, templates);
    const counter=packCount(pixels,140,jewels?.offsetY??0);
    return {
      labelPixels,
      blankName: blankNameLine(pixels, 140, 210),
      hasNameBand: jewels === null && hasNameBand(label),
      awakening: jewels?.awakening??null,
      offsetY: jewels?.offsetY ?? 0,
      hasIcon:counter.hasIcon,
      ...(counter.emptyEvidence?{emptyEvidence:counter.emptyEvidence}:{}),
    };
}
export function readFullAwakening(canvas: Raster, context: RasterContext,
  fields: ReturnType<typeof inspectVisual>, patterns: ContrastPattern[],snapshot?:Uint8ClampedArray) {
  if (fields.awakening !== 5) return undefined;
  if (fields.hasIcon !== false) {
    if(!snapshot)context.drawImage(canvas, 0, 0, 140, 210);
    // Five independently read jewels imply zero. A readable positive numeric
    // overlay contradicts that reading even when its icon is covered. Merely
    // bright artwork fragments must not invalidate a legitimate five-star card.
    const pattern = matchCountPattern(snapshot??context.getImageData(0, 0, 140, 210).data, patterns, fields.offsetY, 15, false);
    if (consistentAwakening(5, pattern.value) === null) return {
      awakening: null, extraCopies: pattern.value,
      countDiagnostics: { maximum: 15, reason: '5각 보석과 추가 장수 판독 상충',
        readings: [], pattern, iconPresent: fields.hasIcon??undefined } as CountDiagnostics,
    };
  }
  return { awakening: 5, extraCopies: 0 };
}
export function readVisual(canvas: Raster, context: RasterContext, fields: ReturnType<typeof inspectVisual>, patterns: ContrastPattern[], maxAwakening?: number,snapshot?:Uint8ClampedArray) {
 if(maxAwakening===0)return {awakening:0,extraCopies:0};
 const level=fields.awakening;
 const full=readFullAwakening(canvas,context,fields,patterns,snapshot);if(full)return full;
 if(fields.hasIcon===false)return {awakening:level,extraCopies:level===null?null:0,
  countDiagnostics:{maximum:level===null?15:15-level*(level+1)/2,
   reason:fields.emptyEvidence?'회색 카드 표식 · 빈 장수 배경 확인'+(level===null?' · 각성 영역 미확정':' · 0장 후보'):
    level===null?'추가 카드 표시 없음 · 각성 영역 미확정':'추가 카드 표시 없음 · 0장 후보',readings:[],iconPresent:false,
   ...(fields.emptyEvidence?{emptyEvidence:fields.emptyEvidence}:{})} as CountDiagnostics};
 const maximum=level===null?15:15-level*(level+1)/2;
 if(!snapshot)context.drawImage(canvas,0,0,140,210);
 const pattern=matchCountPattern(snapshot??context.getImageData(0,0,140,210).data,patterns,fields.offsetY,maximum);
 return {awakening:level,extraCopies:pattern.value,countDiagnostics:{maximum,reason:fields.hasIcon===null?'추가 장수 영역 가림 또는 불명확':pattern.reason,readings:[],pattern,iconPresent:fields.hasIcon??undefined} as CountDiagnostics};
}
