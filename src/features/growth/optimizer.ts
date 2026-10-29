import { growthSequence } from './growth-sequence';
import type { GrowthSequenceStep } from './growth-sequence';
/** Costs are incremental. Bonus values are integer hundredths of a percentage point. */
export type Cost = { xp: number; silver: number; copies: number };
export type GrowthCard = { id: string; name: string; rarity: number; steps: Cost[] };
export type BookEffect = { threshold: number; requiredCount: number; target: string; value: number };
export type CollectionEffect = { requiredCount: number; stats: { stat: string; value: number }[] };
export type GrowthBook = { id: string; name: string; cardIds: string[]; effects: BookEffect[]; collectionEffects?: CollectionEffect[] };
export type GrowthMaster = { version: string; targets: { id: string; name: string }[]; stats?: { id: string; name: string }[]; cards: GrowthCard[]; books: GrowthBook[] };
export type OwnedCard = { id: string; awakening: number | null; extraCopies: number | null; review: string[]; countReliable?: boolean };
export type GrowthComparisonRequest = { master: GrowthMaster; cards: OwnedCard[]; xp: number; target: string };
export type GrowthComparison = { collectionCandidates: GrowthSequenceStep[] };

/** Missing optional members cannot erase a reward proved by enough confirmed members. */
export function bookEffectActive(book: GrowthBook, effect: BookEffect, levels: ReadonlyMap<string, number>): boolean {
  let count=0,sum=0;
  for(const id of book.cardIds){const level=levels.get(id);if(level!==undefined){count++;sum+=level;}}
  return count>=effect.requiredCount && sum>=effect.threshold;
}

/** Plan sequential upgrades, carrying forward spent resources and activated effects. */
export function compareGrowthCandidates(request: GrowthComparisonRequest): GrowthComparison {
  if (!Number.isSafeInteger(request.xp) || request.xp < 0 || !request.master.targets.some(t => t.id === request.target)) {
    throw new Error('보유 경험치와 피해 증가 대상을 확인해 주세요.');
  }
  const { owned, valid } = trustedInventory(request.master, request.cards);
  return { collectionCandidates: growthSequence(request, valid, owned) };
}
const triangular = (n: number) => n * (n + 1) / 2;

function trusted(card: OwnedCard, master: GrowthCard) {
  const a = card.awakening, n = card.extraCopies, max = master.steps.length;
  return !card.review.length && card.countReliable !== false && a !== null && n !== null &&
    Number.isInteger(a) && Number.isInteger(n) && a >= 0 && a <= max && n >= 0 &&
    n <= triangular(max) - triangular(a);
}

export function trustedInventory(master: GrowthMaster, cards: OwnedCard[]) {
  const duplicates = new Set<string>(), owned = new Map<string, OwnedCard>();
  for (const card of cards) {
    if (owned.has(card.id)) duplicates.add(card.id);
    owned.set(card.id, card);
  }
  const valid = master.cards.filter(c => !duplicates.has(c.id) && owned.has(c.id) && trusted(owned.get(c.id)!, c));
  return { owned, valid };
}

/** Current inventory evidence only; never interprets an absent card as zero awakening. */
export function currentBookProgress(master: GrowthMaster, cards: OwnedCard[]) {
  const { owned, valid } = trustedInventory(master, cards);
  const validIds = new Set(valid.map(c => c.id));
  const names = new Map(master.cards.map(c => [c.id, c.name]));
  const books = master.books.map(book => {
    const unregistered = book.cardIds.filter(id => !owned.has(id)).map(id => names.get(id) ?? id);
    const unreadable = book.cardIds.filter(id => owned.has(id) && !validIds.has(id)).map(id => names.get(id) ?? id);
    const missing = book.cardIds.filter(id => !validIds.has(id)).map(id => names.get(id) ?? id);
    const confirmedSum = book.cardIds.reduce((sum, id) => sum + (validIds.has(id) ? owned.get(id)!.awakening! : 0), 0);
    const sum = missing.length ? null : confirmedSum;
    return { ...book, missing, unregistered, unreadable, sum, confirmedSum, confirmedCards: book.cardIds.length - missing.length,
      collectionEffects: (book.collectionEffects ?? []).map(effect => ({ ...effect, active: book.cardIds.length - missing.length >= effect.requiredCount ? true : null })),
      effects: book.effects.map(effect => ({ ...effect, active: book.cardIds.length-missing.length >= effect.requiredCount && confirmedSum >= effect.threshold ? true : sum === null ? null : false })) };
  });
  const targets = master.targets.map(target => {
    const relevant = books.filter(book => book.effects.some(e => e.target === target.id));
    return { ...target, current: relevant.reduce((n, book) => n + book.effects.reduce((v, e) => v + (e.target === target.id && e.active === true ? e.value : 0), 0), 0),
      maximum: relevant.reduce((n, book) => n + book.effects.reduce((v, e) => v + (e.target === target.id ? e.value : 0), 0), 0),
      unknownBooks: relevant.filter(book => book.unreadable.length > 0 && book.effects.some(e=>e.target===target.id && e.active===null)).length, totalBooks: relevant.length };
  });
  const stats = (master.stats ?? []).map(stat => ({ ...stat,
    current: books.reduce((sum, book) => sum + book.collectionEffects.reduce((n, effect) =>
      n + (effect.active ? effect.stats.filter(s => s.stat === stat.id).reduce((v, s) => v + s.value, 0) : 0), 0), 0),
    maximum: books.reduce((sum, book) => sum + book.collectionEffects.reduce((n, effect) =>
      n + effect.stats.filter(s => s.stat === stat.id).reduce((v, s) => v + s.value, 0), 0), 0),
    unknownBooks: books.filter(book => book.unreadable.length > 0 && book.collectionEffects.some(effect => !effect.active && effect.stats.some(s => s.stat === stat.id))).length,
  }));
  const totalEffects = books.reduce((n, book) => n + book.effects.length + book.collectionEffects.length, 0);
  const activeEffects = books.reduce((n, book) => n + book.effects.filter(e => e.active === true).length + book.collectionEffects.filter(e => e.active === true).length, 0);
  return { books, targets, stats, totalEffects, activeEffects };
}
