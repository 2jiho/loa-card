import { packCount, matchCountPattern } from './count-pattern';
import type { ContrastPattern } from './count-pattern';
import { readStarObservation } from './star-pattern';
import { hasNameBand } from './text-mask';
import { nameMask } from './name-pattern';
import { blankNameLine } from './name-visibility';
import type { createPortraitMatcher } from './portrait-matcher';
import type { CountDiagnostics } from './recognizer';
import type { Raster, RasterContext } from './acquisition-raster';
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
    return {
      labelPixels,
      blankName: blankNameLine(pixels, 140, 210),
      hasNameBand: jewels === null && hasNameBand(label),
      awakening: jewels?.awakening ?? null,
      offsetY: jewels?.offsetY ?? 0,
      hasIcon: packCount(pixels, 140, jewels?.offsetY ?? 0).hasIcon,
    };
}
export function readVisual(canvas: Raster, context: RasterContext, fields: ReturnType<typeof inspectVisual>, patterns: ContrastPattern[], maxAwakening?: number) {
 if(maxAwakening===0)return {awakening:0,extraCopies:0};
 const level=fields.awakening;
 if(level===5)return {awakening:level,extraCopies:0};
 if(!fields.hasIcon)return {awakening:level,extraCopies:level===null?null:0,
  countDiagnostics:{maximum:level===null?15:15-level*(level+1)/2,
   reason:level===null?'추가 카드 표시 없음 · 각성 영역 미확정':'추가 카드 표시 없음 · 0장 후보',readings:[],iconPresent:false} as CountDiagnostics};
 const maximum=level===null?15:15-level*(level+1)/2;
 context.drawImage(canvas,0,0,140,210);
 const pattern=matchCountPattern(context.getImageData(0,0,140,210).data,patterns,fields.offsetY,maximum);
 return {awakening:level,extraCopies:pattern.value,countDiagnostics:{maximum,reason:pattern.reason,readings:[],pattern,iconPresent:true} as CountDiagnostics};
}
