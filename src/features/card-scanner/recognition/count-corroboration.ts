import type { CountPatternReading } from "./count-pattern";
import { countStrongGap, countAgreementScore, countScoreAtCropSize, COUNT_UNEXPLAINED_TRAILING_GLYPH } from "./count-pattern";
/** Independent digit recognition can corroborate an ambiguous pattern, but
 * cannot rescue absent icons, contradictory values or impossible levels. */
export function corroboratedCount(input: {
  pattern?: CountPatternReading; awakening: number | null; value: number | null;
  iconPresent?: boolean; ocrAgreed?: boolean; ocrConfirmedValue?: number;
}) {
  const { pattern: p, awakening: a, value: v } = input;
  // OCR agreeing with a partial pattern cannot erase visible unexplained ink
  // unless the single-digit candidate is strong and two readings agree. A
  // low-gap or weak candidate remains a second-digit veto.
  const strongTrailing = p?.reason === COUNT_UNEXPLAINED_TRAILING_GLYPH &&
    p.candidate === v && Number.isFinite(p.score) && p.score >= (p.strongScore ?? .45) &&
    Number.isFinite(p.gap) && p.gap >= countStrongGap(p) && input.ocrConfirmedValue === v;
  if (p?.reason === COUNT_UNEXPLAINED_TRAILING_GLYPH && !strongTrailing) return false;
  const valid = input.iconPresent === true && !!p &&
    a !== null && Number.isInteger(a) && a >= 0 && a < 5 &&
    v !== null && Number.isInteger(v) && v > 0 && v <= 15 - a * (a + 1) / 2 &&
    p.candidate === v && Number.isFinite(p.score) && Number.isFinite(p.gap);
  if (!valid || !p) return false;
  // Two validated numeric readings can resolve a close pattern ranking. Keep
  // the original pattern-only separation floor unless that proof is present.
  if (input.ocrConfirmedValue === v && (p.value === null || p.value === v) &&
      p.score >= countAgreementScore(.40, p) && p.gap >= 0) return true;
  return input.ocrAgreed === true && p.value === v && p.score >= countScoreAtCropSize(.30, p) && p.gap >= .018;
}
