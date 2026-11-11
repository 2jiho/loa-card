import type {CatalogName} from '../recognition/card-dictionary';
import {exactDuplicateFromAttempts, fuzzyDuplicateFromAttempts} from './final-duplicate';
import type {NameAttempt} from '../recognition/name-diagnostics';

export interface DuplicateObservation {
  nameAttempts?: readonly NameAttempt[];
}

export interface SlowDuplicateCandidate<T> {
  item: T;
  confidence: number;
  score: number;
  textLength: number;
}

/** Add exact and fuzzy duplicate observations that can be classified without
 * another OCR call. The caller already established full-inventory eligibility. */
export function collectFastDuplicateItems<T extends DuplicateObservation>(
  unidentified: readonly T[],
  catalog: readonly CatalogName[],
  collectedIds: ReadonlySet<string>,
  target: Set<T> = new Set(),
): Set<T> {
  for (const item of unidentified) {
    if (target.has(item)) continue;
    if (exactDuplicateFromAttempts(item.nameAttempts ?? [], catalog, collectedIds,
      {requireCollectedCompetitors: false, exactTextBypassesConfidence: true})) {
      target.add(item);
    }
  }
  for (const item of unidentified) {
    if (target.has(item)) continue;
    if (fuzzyDuplicateFromAttempts(item.nameAttempts ?? [], collectedIds)) target.add(item);
  }
  return target;
}

/** Order the bounded final re-read. Short OCR strings go first because they are
 * more likely to be partial names; score and confidence break ties. */
export function rankSlowDuplicateCandidates<T extends DuplicateObservation>(
  unidentified: readonly T[],
  collectedIds: ReadonlySet<string>,
): SlowDuplicateCandidate<T>[] {
  return unidentified
    .map(item => {
      const attempts = item.nameAttempts ?? [];
      const score = Math.max(0, ...attempts.flatMap(attempt => attempt.candidates)
        .filter(candidate => collectedIds.has(candidate.id)).map(candidate => candidate.score));
      const confidence = attempts.reduce((max, attempt) => Math.max(max, attempt.confidence), 0);
      const textLength = Math.max(0, ...attempts.map(attempt =>
        attempt.text.replace(/[^가-힣A-Za-z0-9]/g, '').length));
      return {item, confidence, score, textLength};
    })
    .filter(({score}) => score > 0)
    .sort((a, b) =>
      (a.textLength <= 4 ? 0 : 1) - (b.textLength <= 4 ? 0 : 1) ||
      b.score - a.score || b.confidence - a.confidence);
}

export function hasCollectedNameCandidate(
  item: DuplicateObservation,
  collectedIds: ReadonlySet<string>,
): boolean {
  return (item.nameAttempts ?? []).some(attempt =>
    attempt.candidates.some(candidate => collectedIds.has(candidate.id)));
}
