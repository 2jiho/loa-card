import type {EvaluationCard, EvaluationRun} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function review(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string');
}

function card(value: unknown, index: number): EvaluationCard {
  if (!isRecord(value)) throw new Error(`allCards[${index}] must be an object`);
  if (typeof value.id !== 'string' || value.id.length === 0) throw new Error(`allCards[${index}].id must be a string`);
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : null,
    awakening: nullableNumber(value.awakening),
    extraCopies: nullableNumber(value.extraCopies),
    review: review(value.review),
  };
}

/** Adapt a scanner result report without changing or inferring any value. */
export function toEvaluationRun(input: unknown): EvaluationRun {
  if (!isRecord(input)) throw new Error('run result must be an object');
  const source = Array.isArray(input.allCards) ? input.allCards : Array.isArray(input.cards) ? input.cards : null;
  if (!source) throw new Error('run result must contain allCards[] or cards[]; a numeric cards count is not enough');
  return {
    expected: typeof input.expected === 'number' && Number.isSafeInteger(input.expected) && input.expected >= 0
      ? input.expected : null,
    cards: source.map(card),
    unidentified: count(input.unidentified),
    unresolvedObservations: count(input.unresolvedObservations),
    discardedObservations: count(input.discardedObservations),
    recognitionNeeded: Array.isArray(input.recognitionNeeded) ? input.recognitionNeeded.length : 0,
    completionReasons: Array.isArray(input.completionReasons)
      ? input.completionReasons.filter(item => typeof item === 'string') : [],
  };
}
