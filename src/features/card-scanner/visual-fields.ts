import { packCount, matchCountPattern } from './count-pattern';
import type { ContrastPattern } from './count-pattern';
import { readStarObservation } from './star-pattern';
import { hasNameBand } from './text-mask';
import { nameMask } from './name-pattern';
import { blankNameLine } from './name-visibility';
import type { createPortraitMatcher } from './portrait-matcher';
import type { CountDiagnostics } from './recognizer';
import type { Raster, RasterContext } from './acquisition-raster';
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

export function inspectVisual(canvas: Raster, context: RasterContext, templates: number[][]) {
    context.drawImage(canvas, 0, 0, 140, 210);
    const pixels = context.getImageData(0, 0, 140, 210).data;
    const label = context.getImageData(6, 14, 128, 36).data;
    const labelPixels = Math.max(
      ...Array.from({ length: 5 }, (_, grade) =>
        nameMask(label, grade).reduce((n, v) => n + v, 0),
      ),
    );
    const jewels =
      readStarObservation(pixels, templates);
    const hasIcon=packCount(pixels,140,jewels?.offsetY??0).hasIcon;
    return {
      labelPixels,
      blankName: blankNameLine(pixels, 140, 210),
      hasNameBand: jewels === null && hasNameBand(label),
      awakening: jewels?.awakening??null,
      offsetY: jewels?.offsetY ?? 0,
      hasIcon,
    };
}
export function readFullAwakening(canvas: Raster, context: RasterContext,
  fields: ReturnType<typeof inspectVisual>, patterns: ContrastPattern[]) {
  if (fields.awakening !== 5) return undefined;
  if (fields.hasIcon) {
    context.drawImage(canvas, 0, 0, 140, 210);
    const pattern = matchCountPattern(context.getImageData(0, 0, 140, 210).data, patterns, fields.offsetY, 15);
    if (consistentAwakening(5, pattern.value) === null) return {
      awakening: null, extraCopies: pattern.value,
      countDiagnostics: { maximum: 15, reason: '5각 보석과 추가 장수 판독 상충',
        readings: [], pattern, iconPresent: true } as CountDiagnostics,
    };
  }
  return { awakening: 5, extraCopies: 0 };
}
export function readVisual(canvas: Raster, context: RasterContext, fields: ReturnType<typeof inspectVisual>, patterns: ContrastPattern[], maxAwakening?: number) {
 if(maxAwakening===0)return {awakening:0,extraCopies:0};
 const level=fields.awakening;
 const full=readFullAwakening(canvas,context,fields,patterns);if(full)return full;
 if(!fields.hasIcon)return {awakening:level,extraCopies:level===null?null:0,
  countDiagnostics:{maximum:level===null?15:15-level*(level+1)/2,
   reason:level===null?'추가 카드 표시 없음 · 각성 영역 미확정':'추가 카드 표시 없음 · 0장 후보',readings:[],iconPresent:false} as CountDiagnostics};
 const maximum=level===null?15:15-level*(level+1)/2;
 context.drawImage(canvas,0,0,140,210);
 const pattern=matchCountPattern(context.getImageData(0,0,140,210).data,patterns,fields.offsetY,maximum);
 return {awakening:level,extraCopies:pattern.value,countDiagnostics:{maximum,reason:pattern.reason,readings:[],pattern,iconPresent:true} as CountDiagnostics};
}
