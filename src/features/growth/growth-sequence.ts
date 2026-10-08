import { collectionCandidates } from './collection-candidates';
import type { CollectionCandidate } from './collection-candidates';
import type { Cost, GrowthComparisonRequest, GrowthCard, OwnedCard } from './optimizer';

export type AvailableGrowth = Cost & {
  cards: CollectionCandidate['cards'];
  gain: number;
  missingCopies: number;
  conditional: boolean;
  xpShortfall: number;
  usedXp: number;
  gained: number;
  remainingXp: number;
};

export type GrowthSequenceStep = CollectionCandidate & {
  milestones: { bookId: string; name: string; from: number; to: number; thresholds: number[] }[];
  status: 'ready' | 'xp-needed' | 'cards-needed';
  cumulativeXp: number;
  cumulativeGain: number;
  cumulativeMissingCopies: number;
  prerequisiteMissingCopies: number;
  remainingXp: number;
  available: AvailableGrowth;
};

/** Greedy marginal-efficiency sequence. Never mutates scanned inventory.
 * Select by marginal efficiency regardless of available XP or missing cards.
 * Every chosen bundle changes the baseline for all overlapping books.
 */
export function growthSequence(request: GrowthComparisonRequest, valid: GrowthCard[], owned: Map<string, OwnedCard>): GrowthSequenceStep[] {
  const inventory = new Map([...owned].map(([id, card]) => [id, { ...card }]));
  const eligible = new Map(valid.map(card => [card.id, card]));
  const catalog = new Map(request.master.cards.map(card => [card.id, card]));
  const bookById = new Map(request.master.books.map(book => [book.id, book]));
  // A separate execution ledger skips unavailable rows instead of spending
  // hypothetical resources or inheriting unrelated missing-card prerequisites.
  const actual = new Map(valid.map(card => [card.id, { ...owned.get(card.id)! }]));
  const actualLevels = new Map(valid.map(card => [card.id, owned.get(card.id)!.awakening!]));
  const score = (levels: Map<string, number>) => request.master.books.reduce((total, book) => {
    if (!book.cardIds.every(id => levels.has(id))) return total;
    const sum = book.cardIds.reduce((n, id) => n + levels.get(id)!, 0);
    return total + book.effects.reduce((n, effect) => n + (effect.target === request.target &&
      book.cardIds.length >= effect.requiredCount && sum >= effect.threshold ? effect.value : 0), 0);
  }, 0);
  let usedXp = 0, gained = 0;
  const result: GrowthSequenceStep[] = [];
  let cumulativeXp = 0, cumulativeGain = 0, cumulativeMissingCopies = 0, conditional = false;
  // Each positive-gain step consumes at least one previously inactive effect.
  const limit = request.master.books.reduce((n, book) => n + book.effects.filter(effect => effect.target === request.target).length, 0);
  for (let iteration = 0; iteration < limit; iteration++) {
    const candidates = collectionCandidates({ ...request, xp: Math.max(0, request.xp - cumulativeXp) }, [...eligible.values()], inventory);
    if (!candidates.length) break;
    const next = candidates[0];
    const upgrades = new Map(next.cards.map(card => [card.id, card.to]));
    const milestones = next.bookIds.map(id => {
      const book = bookById.get(id)!;
      const from = book.cardIds.reduce((n, cardId) => n + (inventory.get(cardId)?.awakening ?? 0), 0);
      const to = book.cardIds.reduce((n, cardId) => n + (upgrades.get(cardId) ?? inventory.get(cardId)?.awakening ?? 0), 0);
      const registered = book.cardIds.every(cardId => inventory.has(cardId));
      const thresholds = [...new Set(book.effects.filter(e => e.target === request.target && e.threshold <= to &&
        (!registered || e.threshold > from)).map(e => e.threshold))].sort((a, b) => a - b);
      return { bookId: id, name: book.name, from, to, thresholds };
    });
    const prerequisiteMissingCopies = cumulativeMissingCopies;
    cumulativeXp += next.xp;
    cumulativeGain += next.gain;
    cumulativeMissingCopies += next.missingCopies;
    conditional ||= next.conditional;
    const xpShortfall = Math.max(0, cumulativeXp - request.xp);
    for (const upgrade of next.cards) {
      const previous = inventory.get(upgrade.id);
      inventory.set(upgrade.id, { id: upgrade.id, awakening: upgrade.to,
        extraCopies: Math.max(0, (previous?.extraCopies ?? 0) - upgrade.copies), review: [], countReliable: true });
      eligible.set(upgrade.id, catalog.get(upgrade.id)!);
    }
    // Rebuild this row's complete prerequisites from the actual ledger. Reading
    // only next.cards would omit shared growth performed by a skipped earlier row.
    const requiredIds = new Set(next.bookIds.flatMap(id => bookById.get(id)!.cardIds));
    const cards: CollectionCandidate['cards'] = [];
    const proposed = new Map(actualLevels);
    for (const id of requiredIds) {
      const to = inventory.get(id)!.awakening!, previous = actual.get(id);
      const from = previous?.awakening ?? 0, absent = !previous;
      if (!absent && from >= to) continue;
      const card = catalog.get(id)!;
      const cost = card.steps.slice(from, to).reduce((n, s) => ({ xp: n.xp + s.xp,
        silver: n.silver + s.silver, copies: n.copies + s.copies }), { xp: 0, silver: 0, copies: 0 });
      cards.push({ ...cost, id, name: card.name, rarity: card.rarity, from, to, absent,
        missing: Math.max(0, cost.copies - (previous?.extraCopies ?? 0)) + (absent ? 1 : 0) });
      proposed.set(id, to);
    }
    const cost = cards.reduce((n, c) => ({ xp: n.xp + c.xp, silver: n.silver + c.silver,
      copies: n.copies + c.copies }), { xp: 0, silver: 0, copies: 0 });
    const missingCopies = cards.reduce((n, c) => n + c.missing, 0);
    const shortfall = Math.max(0, cost.xp - (request.xp - usedXp));
    const gain = score(proposed) - score(actualLevels);
    const status = missingCopies > 0 ? 'cards-needed' : shortfall > 0 ? 'xp-needed' : 'ready';
    if (status === 'ready') {
      usedXp += cost.xp; gained += gain;
      for (const upgrade of cards) {
        actual.set(upgrade.id, { ...actual.get(upgrade.id)!, awakening: upgrade.to,
          extraCopies: actual.get(upgrade.id)!.extraCopies! - upgrade.copies });
        actualLevels.set(upgrade.id, upgrade.to);
      }
    }
    result.push({ ...next, milestones, key: `${iteration}:${next.key}`, conditional, xpShortfall, status,
      cumulativeXp, cumulativeGain, cumulativeMissingCopies, prerequisiteMissingCopies,
      remainingXp: Math.max(0, request.xp - cumulativeXp),
      available: { ...cost, cards, gain, missingCopies, conditional: cards.some(c => c.absent),
        xpShortfall: shortfall, usedXp, gained, remainingXp: request.xp - usedXp } });
  }
  return result;
}
