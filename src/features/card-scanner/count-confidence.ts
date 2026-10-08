import type { CountPatternReading } from "./count-pattern";
import { corroboratedCount } from "./count-corroboration";

export type CountReliability = "stable-frame" | "clear-pattern" | "distinct-pattern" | "repeated-pattern" | "pattern-ocr" | "empty-counter" | "fixed-zero" | "unconfirmed";

type CountInput = {
  borderAlignment: number; awakening: number | null; extraCopies: number | null;
  pattern?: CountPatternReading;
};
/** All 15 values are ranked before applying the awakening limit. Preserve
 * the matcher's minimum contrast and separation; an upper bound is not a vote. */
function validPositive(input: CountInput) {
  const p = input.pattern;
  return input.borderAlignment >= .8 && input.awakening !== null &&
    Number.isInteger(input.awakening) && input.awakening >= 0 && input.awakening <= 5 &&
    input.extraCopies !== null && Number.isInteger(input.extraCopies) && input.extraCopies > 0 &&
    input.extraCopies <= 15 - input.awakening * (input.awakening + 1) / 2 && !!p &&
    p.value === input.extraCopies && p.candidate === input.extraCopies &&
    Number.isFinite(p.score) && Number.isFinite(p.gap) && p.score >= .30 && p.gap >= .018;
}

/** DB identity links observations; only the counter pixels need to settle.
 * Duplicate retries of a frame cannot manufacture temporal evidence. */
export class CountObservations {
  private cards = new Map<string, { frame: string; value: number; awakening: number; pixels: Uint8Array }[]>();
  offer(id: string, frame: string, vector: Uint8Array, input: CountInput) {
    if (!validPositive(input) || vector.length !== 3240 || !frame) return false;
    const pixels = vector.slice(864, 2016), recent = this.cards.get(id) ?? [];
    const repeated = recent.some(previous => {
      if (previous.frame === frame || previous.value !== input.extraCopies || previous.awakening !== input.awakening) return false;
      let difference = 0;
      for (let i = 0; i < pixels.length; i++) difference += Math.abs(pixels[i] - previous.pixels[i]);
      return difference / pixels.length < 2.5;
    });
    if (!recent.some(previous => previous.frame === frame)) {
      recent.push({ frame, value: input.extraCopies!, awakening: input.awakening!, pixels });
      this.cards.set(id, recent.slice(-6));
    }
    return repeated;
  }
}

/** Temporal stability and clear field evidence are independent routes. A page
 * change need not repeat if the complete card and its count glyphs are intact. */
export function countReliability(input: {
  stable: boolean;
  repeatedCount?: boolean;
  borderAlignment: number;
  awakening: number | null;
  maxAwakening?: number;
  extraCopies: number | null;
  pattern?: CountPatternReading;
  iconPresent?: boolean;
  patternOcrAgreed?: boolean;
  ocrConfirmedValue?: number;
}): CountReliability {
  if (input.extraCopies === null) return "unconfirmed";
  if (input.extraCopies === 0 && (input.awakening === 5 || input.maxAwakening === 0))
    return "fixed-zero";
  if (input.stable) return "stable-frame";
  if (corroboratedCount({ pattern: input.pattern, awakening: input.awakening,
      value: input.extraCopies, iconPresent: input.iconPresent, ocrAgreed: input.patternOcrAgreed,
      ocrConfirmedValue: input.borderAlignment >= .8 ? input.ocrConfirmedValue : undefined })) return "pattern-ocr";
  // The game omits the extra-copy overlay for zero copies; there is no '0'
  // glyph to OCR. Absence must be explicitly inspected on an intact card.
  if (input.extraCopies === 0 && input.iconPresent === false &&
      input.borderAlignment >= .8 && input.awakening !== null &&
      Number.isInteger(input.awakening) && input.awakening >= 0 && input.awakening <= 5)
    return "empty-counter";
  const pattern = input.pattern;
  if (validPositive(input) && pattern) {
    if (pattern.score >= .4 && pattern.gap >= .035) return "clear-pattern";
    // Contrast is not a recognition probability. Moderate contrast can still
    // distinguish one of the 15 patterns if both absolute and relative gaps hold.
    if (pattern.gap >= .035 && pattern.gap / pattern.score >= .10) return "distinct-pattern";
    if (input.repeatedCount) return "repeated-pattern";
  }
  return "unconfirmed";
}
