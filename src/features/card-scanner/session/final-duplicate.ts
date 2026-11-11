import {catalogNameAmbiguityIndex, exactNameCompetitors, normalizeName, type CatalogName} from '../recognition/card-dictionary';
import type {NameAttempt} from '../recognition/name-diagnostics';

/** A final duplicate classification is diagnostic only: it never adds a card,
 * changes a value, or certifies a missing slot. It is considered only after the
 * scan has identified every expected card, so an extra observation cannot be
 * the only evidence for an absent card. */
export interface FinalDuplicateReading {
  card: {id: string; name: string};
  exact?: boolean;
  ocrConfidence?: number;
}

export const FINAL_DUPLICATE_MIN_CONFIDENCE = 60;

/** Accept an exact name of an already-collected card. The default requires
 * every longer catalog name containing that text to be collected as well. A
 * full-inventory scan may relax that check because an uncollected longer card
 * cannot be the observed inventory card. */
export interface FinalDuplicateOptions {
  /** Full-inventory scans may omit the longer-name check: an uncollected
   * competitor cannot be the observed inventory card. Defaults to strict. */
  requireCollectedCompetitors?: boolean;
  /** Exact normalized text for an owned card is sufficient evidence for a
   * duplicate diagnostic even when the OCR confidence is low. */
  exactTextBypassesConfidence?: boolean;
}

export function finalDuplicateIdentity(
  reading: FinalDuplicateReading | null | undefined,
  cards: readonly CatalogName[],
  collectedIds: ReadonlySet<string>,
  options: FinalDuplicateOptions = {},
): string | null {
  if (!reading || reading.exact !== true || !reading.card) return null;
  if (!Number.isFinite(reading.ocrConfidence) || (reading.ocrConfidence ?? 0) < FINAL_DUPLICATE_MIN_CONFIDENCE) return null;
  const id = reading.card.id;
  if (!collectedIds.has(id)) return null;
  if (options.requireCollectedCompetitors === false) return id;
  const index = catalogNameAmbiguityIndex(cards);
  const competitors = exactNameCompetitors(index, id, reading.card.name);
  return competitors.every(other => collectedIds.has(other)) ? id : null;
}

/** Fast path for attempts whose OCR text is already an exact normalized card
 * name. It avoids another OCR call; the same full-inventory and ambiguity
 * checks apply. */
export function exactDuplicateFromAttempts(
  attempts: readonly NameAttempt[],
  cards: readonly CatalogName[],
  collectedIds: ReadonlySet<string>,
  options: FinalDuplicateOptions = {},
): string | null {
  for (const attempt of attempts) {
    const text = normalizeName(attempt.text ?? '');
    if (!text) continue;
    const exact = attempt.candidates.find(candidate => normalizeName(candidate.name) === text);
    if (!exact) continue;
    const confidence=options.exactTextBypassesConfidence?Math.max(attempt.confidence,FINAL_DUPLICATE_MIN_CONFIDENCE):attempt.confidence;
    const id = finalDuplicateIdentity({card: {id: exact.id, name: exact.name}, exact: true,
      ocrConfidence: confidence}, cards, collectedIds, options);
    if (id) return id;
  }
  return null;
}

/** Fuzzy duplicate diagnostic for a full inventory: the OCR text is a close
 * spelling of an owned card (dictionary score >= .85, runner-up gap >= .2).
 * It never selects a card for the inventory; it only classifies an extra
 * observation as a duplicate. */
export const FUZZY_DUPLICATE_MIN_SCORE = .85;
export const FUZZY_DUPLICATE_MIN_GAP = .2;

export function fuzzyDuplicateFromAttempts(
  attempts: readonly NameAttempt[],
  collectedIds: ReadonlySet<string>,
): string | null {
  for (const attempt of attempts) {
    const candidates = attempt.candidates ?? [];
    if (candidates.length < 2) continue;
    const top = candidates[0];
    if (!collectedIds.has(top.id)) continue;
    const gap = top.score - candidates[1].score;
    if (top.score < FUZZY_DUPLICATE_MIN_SCORE || gap < FUZZY_DUPLICATE_MIN_GAP) continue;
    if (normalizeName(attempt.text ?? '').length < 2) continue;
    return top.id;
  }
  return null;
}

/** Final duplicate classification needs every expected card accounted for.
 * A pinned recognition-needed slot is an explicit known gap, so the inventory
 * may be full modulo those slots. */
export function canClassifyFinalDuplicates(
  cardCount: number,
  uniqueCount: number,
  expected: number | null,
  pinnedRecognition: number,
): boolean {
  if (expected === null || !Number.isSafeInteger(expected) || expected <= 0) return false;
  if (!Number.isSafeInteger(cardCount) || cardCount < 0 || uniqueCount !== cardCount) return false;
  if (cardCount === expected) return true;
  return pinnedRecognition > 0 && cardCount + pinnedRecognition === expected;
}
