import { confirmArtwork } from "./artwork-verifier";
import { confirmPortrait, confirmPortraitWithText } from "./portrait-matcher";
import { normalizeName } from "./card-dictionary";
export interface NameMatchEvidence {
  exact: boolean;
  score: number;
  gap: number;
  ocrConfidence: number;
  artwork?: import("./artwork-verifier").ArtworkEvidence;
  ctc?: { relativeLikelihood: number; margin: number };
  portrait?: import("./portrait-matcher").PortraitEvidence;
  rawText?: string;
  complete?: boolean;
  card?: { name: string };
}

/** A clear closed-vocabulary correction can outweigh one wrong Hangul stroke. */
export function confirmName(reading: NameMatchEvidence, stable: boolean) {
  if (reading.portrait) return confirmPortrait(reading.portrait) || confirmPortraitWithText(reading.portrait,
    { ...reading, canonicalName: reading.card?.name });
  if (reading.artwork) return confirmArtwork(reading.artwork, reading.ocrConfidence / 100);
  if (reading.ctc) return reading.ocrConfidence >= 65 && reading.score >= .8 &&
    reading.ctc.margin >= .9 && reading.ctc.relativeLikelihood >= (stable ? .85 : .95);
  if (reading.exact) return true;
  if (reading.ocrConfidence >= 50 && reading.score >= .9) return true;
  const visible = normalizeName(reading.rawText ?? ""), canonical = normalizeName(reading.card?.name ?? "");
  // Physical completeness is independent of whether another video frame repeats.
  // Accept a whole-name correction only when the runner-up is clearly separated.
  if (reading.complete && visible.length >= 2 && visible.length === canonical.length &&
      !/[ㄱ-ㅎㅏ-ㅣ]/.test(visible) && reading.ocrConfidence >= 65 &&
      reading.score >= .83 && reading.gap >= .40) return true;
  return stable && reading.ocrConfidence >= 60 && reading.score >= .83 && reading.gap >= .2;
}

/** A nearest catalog name is a hypothesis, even with confident OCR or a
 * lexicon score. Require independent artwork for a non-exact correction so
 * an absent name cannot silently become a similar registered card. */
export function confirmCatalogName(reading: NameMatchEvidence, stable: boolean) {
  return !!(reading.exact || reading.artwork || reading.portrait) && confirmName(reading, stable);
}
