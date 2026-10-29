import type { CountDiagnostics, ScannedCard } from './recognizer';

export interface CurrentFieldEvidence {
  latest: ReadonlyMap<string, number>;
  confirmed: ReadonlyMap<string, number>;
}

export const CURRENT_FIELD_REVIEW = '최신 각성·장수 확인';

/** Fresh observations retain at most 2,048 groups and one overflow warning. */
export const MAX_UNRESOLVED_FIELD_CHANGES = 2_049;
export interface UnresolvedFieldChangeSnapshot {
  unresolvedFieldChanges?: number;
  unresolvedFieldChangesUnavailable?: true;
}
/** A diagnostic count has no card identity. Do not clamp malformed proof into
 * a successful zero, or invoke a getter while projecting optional metadata. */
export function boundedUnresolvedFieldChanges(state: object | null | undefined): UnresolvedFieldChangeSnapshot {
  if (!state) return {};
  const descriptor = Object.getOwnPropertyDescriptor(state, 'unresolvedFieldChanges');
  if (!descriptor) return 'unresolvedFieldChanges' in state ? {unresolvedFieldChangesUnavailable:true} : {};
  if ('value' in descriptor && descriptor.value === undefined) return {};
  const value = 'value' in descriptor ? descriptor.value : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_UNRESOLVED_FIELD_CHANGES
    ? {unresolvedFieldChanges:value} : {unresolvedFieldChangesUnavailable:true};
}

function changedFieldReviews(state: object | null | undefined): number {
  const changes = boundedUnresolvedFieldChanges(state);
  return changes.unresolvedFieldChangesUnavailable ? 1 : changes.unresolvedFieldChanges ?? 0;
}

/** Capture order, rather than reader completion order, defines current proof. */
export function hasCurrentFieldProof(id: string, {latest, confirmed}: CurrentFieldEvidence): boolean {
  const order = latest.get(id), proof = confirmed.get(id);
  return order !== undefined && proof !== undefined && Number.isFinite(order) && Number.isFinite(proof) && proof >= order;
}

/** Preserve historical values and their source, but never publish them as fresh
 * proof after a newer unresolved capture. Consensus history is not modified. */
export function projectCurrentScanFields(cards: readonly ScannedCard[], evidence: CurrentFieldEvidence): ScannedCard[] {
  return cards.map(card => !evidence.latest.has(card.id) || hasCurrentFieldProof(card.id, evidence) ? card : {
    ...card,
    review: card.review.includes(CURRENT_FIELD_REVIEW) ? card.review : [...card.review, CURRENT_FIELD_REVIEW],
    countReliable: false,
  });
}

/** Older backups retained aggregate proof but not the affected identities. Do
 * not guess a card ID or silently treat this deficit as confirmed inventory. */
export function unattributedFieldReviewCount(state: {
  cards: readonly ScannedCard[]; currentRunNames?: number; currentRunRead?: number; unattributedFieldReviews?: number; unresolvedFieldChanges?: number;
} | null | undefined): number {
  const carried = Math.max(changedFieldReviews(state),
    Number.isInteger(state?.unattributedFieldReviews) && state!.unattributedFieldReviews! > 0 ? state!.unattributedFieldReviews! : 0);
  if (!state || !Number.isInteger(state.currentRunNames) || !Number.isInteger(state.currentRunRead) ||
      state.currentRunNames! < 0 || state.currentRunRead! < 0) return carried;
  const reviewed = state.cards.filter(card => card.review.includes(CURRENT_FIELD_REVIEW)).length;
  return Math.max(carried, state.currentRunNames! - state.currentRunRead! - reviewed);
}

/** A partial rescan cannot erase an old, unidentified proof gap. Only fresh
 * proof for every inventory row and the expected quantity can clear it. */
export function carryUnattributedFieldReviews(count: number, state: {
  cards: readonly ScannedCard[]; expected: number | null; currentRunNames?: number; currentRunRead?: number; unresolvedFieldChanges?: number;
}): number {
  const changes = changedFieldReviews(state);
  if (changes) return Math.max(count, changes);
  if (!count) return 0;
  const size = state.cards.length;
  return Number.isInteger(state.expected) && state.expected! > 0 && state.expected === size &&
    state.currentRunNames === size && state.currentRunRead === size &&
    state.cards.every(card => !card.review.length && card.countReliable === true) ? 0 : count;
}

export interface PendingCardFields {
  id: string;
  name: string;
  image: string;
  /** Optional lossless recognition input. UI continues to use image. */
  recognitionImage?: string;
  time: number;
  captureOrder?: number;
  reason: string;
  countReason?: string;
  countDiagnostics?: CountDiagnostics;
  stable?: boolean;
  borderAlignment?: number;
}

/** Numeric-reader evidence only. Keep all current reader variants (at most
 * nine), with room for twelve; never retain arbitrary nested image/trace data. */
export function boundedCountDiagnostics(diagnostic: CountDiagnostics | undefined): CountDiagnostics | undefined {
  if (!diagnostic) return undefined;
  const pattern = diagnostic.pattern;
  return {
    maximum: diagnostic.maximum, reason: diagnostic.reason.slice(0,300),
    iconPresent: diagnostic.iconPresent, reliability: diagnostic.reliability,
    ...(diagnostic.emptyEvidence==='gray-card-marker-and-visible-background'?{emptyEvidence:diagnostic.emptyEvidence}:{}),
    ocrConfirmedValue: diagnostic.ocrConfirmedValue, patternOcrAgreed: diagnostic.patternOcrAgreed,
    readings: diagnostic.readings.slice(0,12).map(({engine,text,confidence,value})=>({
      engine: engine.slice(0,48), text: text.slice(0,80), confidence, value,
    })),
    ...(pattern ? {pattern:{value:pattern.value,candidate:pattern.candidate,score:pattern.score,
      gap:pattern.gap,reason:pattern.reason.slice(0,300),
      ...(pattern.emptyEvidence==='gray-card-marker-and-visible-background'?{emptyEvidence:pattern.emptyEvidence}:{})}} : {}),
  };
}

/** Keep the latest failed capture separate from the preserved value's image.
 * References only; scanner bounds this metadata map to 1,000 identities. */
export function pendingScanFields(
  observations: Iterable<{card: ScannedCard; borderAlignment: number}>,
  evidence: CurrentFieldEvidence,
): PendingCardFields[] {
  return [...observations].filter(({card}) => evidence.latest.has(card.id) &&
      card.captureOrder === evidence.latest.get(card.id) && !hasCurrentFieldProof(card.id, evidence))
    .map(({card, borderAlignment}) => ({
      id: card.id, name: card.name, image: card.image, time: card.time, captureOrder: card.captureOrder,
      reason: card.review.filter(reason => /각성|장수/.test(reason)).join(' · ') || CURRENT_FIELD_REVIEW,
      countReason: card.countDiagnostics?.reason, stable: card.capturePosition?.stable, borderAlignment,
      ...(card.countDiagnostics ? {countDiagnostics:boundedCountDiagnostics(card.countDiagnostics)} : {}),
    }));
}
