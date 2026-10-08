import type { Cost, GrowthBook, GrowthCard, GrowthComparisonRequest, OwnedCard } from './optimizer';

export type CollectionCandidate = Cost & {
  key: string; gain: number; efficiency: number | null; missingCopies: number;
  xpShortfall: number; conditional: boolean;
  cards: (Cost & { id: string; name: string; rarity: number; from: number; to: number; missing: number; absent: boolean })[];
  books: string[]; bookIds: string[];
};
type Allocation = Cost & { missing: number; levels: [string, number][] };

/** Independent collection alternatives from the current inventory, not additive steps.
 * Absent cards are explicitly hypothetical new registrations; uncertain observations
 * are never treated as unowned. Beam DP preserves cheap-XP and few-missing alternatives.
 */
export function collectionCandidates(request: GrowthComparisonRequest, valid: GrowthCard[], owned: Map<string, OwnedCard>): CollectionCandidate[] {
  const { master, target } = request;
  const validIds = new Set(valid.map(c => c.id));
  const catalog = new Map(master.cards.map(c => [c.id, c]));
  const initial = new Map(valid.map(c => [c.id, owned.get(c.id)!.awakening!]));
  const objective = master.books.filter(b => b.effects.some(e => e.target === target) &&
    b.cardIds.every(id => catalog.has(id) && (!owned.has(id) || validIds.has(id))));
  const scoreBook = (book: GrowthBook, levels: Map<string, number>) => {
    if (!book.cardIds.every(id => levels.has(id))) return 0;
    const sum = book.cardIds.reduce((n, id) => n + levels.get(id)!, 0);
    return book.effects.reduce((n, e) => n + (e.target === target && sum >= e.threshold && book.cardIds.length >= e.requiredCount ? e.value : 0), 0);
  };
  const before = new Map(objective.map(b => [b.id, scoreBook(b, initial)]));
  const cost = (card: GrowthCard, to: number) => card.steps.slice(initial.get(card.id) ?? 0, to)
    .reduce((n, s) => ({ xp: n.xp + s.xp, silver: n.silver + s.silver, copies: n.copies + s.copies }), { xp: 0, silver: 0, copies: 0 });
  const found = new Map<string, CollectionCandidate>();
  for (const book of objective) {
    const sum = book.cardIds.reduce((n, id) => n + (initial.get(id) ?? 0), 0);
    const absent = book.cardIds.some(id => !initial.has(id));
    const pending = [...new Set(book.effects.filter(e => e.target === target && (absent || e.threshold > sum))
      .map(e => Math.max(0, e.threshold - sum)))].sort((a, b) => a - b);
    const thresholds = pending.slice(0, 1);
    if (!thresholds.length) continue;
    const limit = Math.max(...thresholds);
    let dp = new Map<number, Allocation[]>([[0, [{ xp: 0, silver: 0, copies: 0, missing: 0, levels: [] }]]]);
    for (const id of book.cardIds) {
      const card = catalog.get(id)!, from = initial.get(id) ?? 0;
      const next = new Map<number, Allocation[]>();
      for (const [added, allocations] of dp) for (const allocation of allocations) for (let to = from; to <= card.steps.length; to++) {
        const total = added + to - from;
        if (total > limit) break;
        const c = cost(card, to);
        const missing = Math.max(0, c.copies - (initial.has(id) ? owned.get(id)!.extraCopies! : 0)) + (initial.has(id) ? 0 : 1);
        const candidate = { xp: allocation.xp + c.xp, silver: allocation.silver + c.silver, copies: allocation.copies + c.copies,
          missing: allocation.missing + missing, levels: to > from || !initial.has(id) ? [...allocation.levels, [id, to] as [string, number]] : allocation.levels };
        const list = next.get(total) ?? [];
        list.push(candidate); next.set(total, list);
      }
      // Bound work while keeping both scarce-card and experience alternatives.
      for (const [added, list] of next) {
        const byXp = [...list].sort((a, b) => a.xp - b.xp || a.missing - b.missing || a.silver - b.silver).slice(0, 4);
        const byMissing = [...list].sort((a, b) => a.missing - b.missing || a.xp - b.xp || a.silver - b.silver).slice(0, 4);
        const unique = new Map([...byXp, ...byMissing].map(a => [JSON.stringify(a.levels), a]));
        next.set(added, [...unique.values()]);
      }
      dp = next;
    }
    for (const threshold of thresholds) for (const allocation of dp.get(threshold) ?? []) {
      const levels = new Map(initial);
      for (const [id, to] of allocation.levels) levels.set(id, to);
      // Shared-card growth must not jump over another book's intermediate reward.
      // Registration may legitimately unlock multiple already-reached thresholds.
      if (objective.some(b => {
        const from = b.cardIds.reduce((n, id) => n + (initial.get(id) ?? 0), 0);
        const to = b.cardIds.reduce((n, id) => n + (levels.get(id) ?? 0), 0);
        return new Set(b.effects.filter(e => e.target === target && e.threshold > from && e.threshold <= to)
          .map(e => e.threshold)).size > 1;
      })) continue;
      const changes = objective.map(b => ({ id: b.id, name: b.name, gain: scoreBook(b, levels) - before.get(b.id)!,
        conditional: b.cardIds.some(id => !initial.has(id)) })).filter(b => b.gain > 0);
      const gain = changes.reduce((n, b) => n + b.gain, 0);
      if (!gain) continue;
      const key = JSON.stringify([...allocation.levels].sort(([a], [b]) => a.localeCompare(b)));
      if (found.has(key)) continue;
      const cards = allocation.levels.map(([id, to]) => {
        const card = catalog.get(id)!, c = cost(card, to), absent = !initial.has(id);
        return { ...c, id, name: card.name, rarity: card.rarity, from: initial.get(id) ?? 0, to, absent,
          missing: Math.max(0, c.copies - (absent ? 0 : owned.get(id)!.extraCopies!)) + (absent ? 1 : 0) };
      });
      found.set(key, { key, xp: allocation.xp, silver: allocation.silver, copies: allocation.copies, gain,
        efficiency: allocation.xp ? gain * 100 / allocation.xp : null,
        missingCopies: allocation.missing, xpShortfall: Math.max(0, allocation.xp - request.xp),
        conditional: changes.some(b => b.conditional), cards, books: changes.map(b => b.name), bookIds: changes.map(b => b.id) });
    }
  }
  const ranked = [...found.values()].sort((a, b) => {
    // Zero XP positive effects first; use full precision, not the displayed ratio.
    if (a.xp === 0 || b.xp === 0) {
      if (a.xp !== b.xp) return a.xp === 0 ? -1 : 1;
    } else {
      const ratio = b.gain * a.xp - a.gain * b.xp;
      if (ratio) return ratio;
    }
    return a.missingCopies - b.missingCopies || a.xp - b.xp || a.silver - b.silver || b.gain - a.gain || a.key.localeCompare(b.key);
  });
  // Avoid filling the list with equivalent or strictly more expensive allocations
  // of the same effects. Keep XP vs missing-copy tradeoffs as separate choices.
  const distinct: CollectionCandidate[] = [];
  for (const candidate of ranked) {
    const sameEffects = (other: CollectionCandidate) => other.gain === candidate.gain &&
      other.conditional === candidate.conditional && other.books.join('\0') === candidate.books.join('\0');
    if (distinct.some(other => sameEffects(other) && other.xp <= candidate.xp &&
      other.silver <= candidate.silver && other.missingCopies <= candidate.missingCopies)) continue;
    distinct.push(candidate);
  }
  return distinct;
}
