import { currentBookProgress, trustedInventory } from './optimizer';
import type { GrowthMaster, OwnedCard } from './optimizer';

/** Independent collection alternatives. An absent row is a hypothetical missing
 * registration, not evidence that historical collection effects were never earned.
 */
export function statCollectionPlans(master: GrowthMaster, cards: OwnedCard[], stat: string) {
  const { owned, valid } = trustedInventory(master, cards);
  const registered = new Set(valid.map(c => c.id));
  const catalog = new Map(master.cards.map(c => [c.id, c]));
  const relevant = master.books.filter(b => b.collectionEffects?.some(e => e.stats.some(s => s.stat === stat && s.value > 0)));
  const excluded = relevant.filter(b => b.cardIds.some(id => owned.has(id) && !registered.has(id)));
  const excludedIds = new Set(excluded.map(b => b.id));
  const books = relevant.filter(b => !excludedIds.has(b.id));
  const count = (ids: string[], added: Set<string>) => ids.filter(id => registered.has(id) || added.has(id)).length;
  const effectValue = (values: { stat: string; value: number }[]) => values.filter(s => s.stat === stat).reduce((n, s) => n + s.value, 0);
  const unique = new Map<string, string[]>();
  let limited = false;
  for (const book of books) {
    const missing = book.cardIds.filter(id => !registered.has(id) && catalog.has(id));
    const confirmed = count(book.cardIds, new Set());
    for (const effect of book.collectionEffects ?? []) {
      if (effectValue(effect.stats) <= 0 || effect.requiredCount <= confirmed) continue;
      const needed = effect.requiredCount - confirmed;
      if (needed > missing.length) continue;
      // Some collection effects require only a subset (e.g. 6 of 7 cards).
      let enumerated = 0;
      const choose = (at: number, selected: string[]) => {
        if (selected.length === needed) {
          if (enumerated >= 512) { limited = true; return; }
          enumerated++;
          const ids = [...selected].sort(); unique.set(JSON.stringify(ids), ids); return;
        }
        for (let i = at; i <= missing.length - (needed - selected.length); i++) {
          choose(i + 1, [...selected, missing[i]]);
          if (limited && enumerated >= 512) break;
        }
      };
      choose(0, []);
    }
  }
  const candidates = [...unique].map(([key, ids]) => {
    const added = new Set(ids);
    const unlocked = books.flatMap(book => {
      const beforeCount = count(book.cardIds, new Set()), afterCount = count(book.cardIds, added);
      const gain = (book.collectionEffects ?? []).reduce((n, e) => n +
        (beforeCount < e.requiredCount && afterCount >= e.requiredCount ? effectValue(e.stats) : 0), 0);
      return gain > 0 ? [{ id: book.id, name: book.name, gain }] : [];
    });
    const gain = unlocked.reduce((n, b) => n + b.gain, 0);
    return { key, cards: ids.map(id => ({ id, name: catalog.get(id)!.name, rarity: catalog.get(id)!.rarity })),
      gain, efficiency: gain / ids.length, books: unlocked };
  }).filter(c => c.gain > 0).sort((a, b) => b.gain * a.cards.length - a.gain * b.cards.length ||
    a.cards.length - b.cards.length || b.gain - a.gain || a.key.localeCompare(b.key));
  return { stat: currentBookProgress(master, cards).stats.find(s => s.id === stat), candidates,
    excluded: excluded.map(b => b.name), limited };
}
