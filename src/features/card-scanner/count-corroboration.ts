import type { CountPatternReading } from "./count-pattern";
/** Independent digit recognition can corroborate an ambiguous pattern, but
 * cannot rescue absent icons, contradictory values or impossible levels. */
export function corroboratedCount(input: {
  pattern?: CountPatternReading; awakening: number | null; value: number | null;
  iconPresent?: boolean; ocrAgreed?: boolean; ocrConfirmedValue?: number;
}) {
  const { pattern: p, awakening: a, value: v } = input;
  const valid = input.iconPresent === true && !!p &&
    a !== null && Number.isInteger(a) && a >= 0 && a < 5 &&
    v !== null && Number.isInteger(v) && v > 0 && v <= 15 - a * (a + 1) / 2 &&
    p.candidate === v && Number.isFinite(p.score) && Number.isFinite(p.gap);
  if (!valid || !p) return false;
  // Two validated numeric readings can resolve a close pattern ranking. Keep
  // the original pattern-only separation floor unless that proof is present.
  if (input.ocrConfirmedValue === v && (p.value === null || p.value === v) &&
      p.score >= .40 && p.gap >= 0) return true;
  return input.ocrAgreed === true && p.value === v && p.score >= .30 && p.gap >= .018;
}
