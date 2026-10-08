import type { GrowthMaster } from './optimizer';

const primary = ['3', '4', '5'];
export const primaryStatLabel = '힘/민첩/지능';

/** Group only when every collection reward gives all three the same value.
 * Keep the source stats independent; the representative value is never summed.
 */
export function primaryStatsAreGrouped(master: GrowthMaster) {
  return primary.every(id => master.stats?.some(s => s.id === id)) && master.books.every(b =>
    (b.collectionEffects ?? []).every(e => {
      const values = primary.map(id => e.stats.filter(s => s.stat === id).reduce((n, s) => n + s.value, 0));
      return values.every(value => value === values[0]);
    }));
}

export function displayStats<T extends { id: string; name: string }>(master: GrowthMaster, stats: T[]) {
  const grouped = primaryStatsAreGrouped(master);
  return stats.filter(s => !grouped || (s.id !== '4' && s.id !== '5')).map(s => ({ ...s,
    name: grouped && s.id === '3' ? primaryStatLabel : s.name, grouped: grouped && s.id === '3' }));
}

export function collectionStatText(master: GrowthMaster, values: { stat: string; value: number }[]) {
  return displayStats(master, values.map(s => ({ id: s.stat, value: s.value, name: master.stats?.find(t => t.id === s.stat)?.name ?? s.stat })))
    .map(s => `${s.name}${s.grouped ? ' 각' : ''} +${s.value}`).join(', ');
}
