import type { ScannedCard } from './card-scanner/recognizer';
import type { OwnedCard } from './growth/optimizer';

/** Ignore thumbnails, diagnostics and processing counters when scheduling calculations. */
export function resultCardsKey(cards: readonly ScannedCard[]) {
  return JSON.stringify(cards.map(c => [c.id, c.name, c.awakening, c.extraCopies, c.countReliable, c.review]));
}

/** Before a complete inventory, absence means unknown, not an unregistered card. */
export function growthInput(cards: OwnedCard[], catalog: readonly { id: string }[], complete: boolean): OwnedCard[] {
  if (complete) return cards;
  const present = new Set(cards.map(c => c.id));
  return [...cards, ...catalog.filter(c => !present.has(c.id)).map(c => ({
    id: c.id, awakening: null, extraCopies: null, countReliable: false, review: ['미스캔'],
  }))];
}
