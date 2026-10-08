import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareGrowthCandidates, currentBookProgress, trustedInventory } from '../src/features/growth/optimizer';
import type { GrowthMaster, GrowthComparisonRequest, OwnedCard } from '../src/features/growth/optimizer';

const master: GrowthMaster = {
  version: 'test', targets: [{ id: 'demon', name: '악마' }, { id: 'human', name: '인간' }],
  cards: ['a', 'b', 'c'].map(id => ({ id, name: id, rarity: 0, steps: [
    { copies: 1, xp: 10, silver: 20 }, { copies: 2, xp: 20, silver: 30 },
  ] })),
  books: [
    { id: 'ab', name: 'ab', cardIds: ['a', 'b'], effects: [{ threshold: 2, requiredCount: 2, target: 'demon', value: 6 }, { threshold: 4, requiredCount: 2, target: 'demon', value: 7 }] },
    { id: 'ac', name: 'ac', cardIds: ['a', 'c'], effects: [{ threshold: 2, requiredCount: 2, target: 'human', value: 10 }] },
  ],
};
const owned = (id: string, awakening = 0, extraCopies = 3): OwnedCard => ({ id, awakening, extraCopies, review: [], countReliable: true });
test('invalid or duplicate observations cannot supply growth resources', () => {
  for (const bad of [{ awakening: null }, { extraCopies: null }, { review: ['count'] }, { countReliable: false }, { awakening: 1, extraCopies: 3 }]) {
    assert.deepEqual(trustedInventory(master, [owned('a'), { ...owned('b'), ...bad }]).valid.map(c => c.id), ['a']);
  }
  assert.deepEqual(trustedInventory(master, [owned('a'), owned('a'), owned('b')]).valid.map(c => c.id), ['b']);
});
test('invalid experience and unknown targets reject the request', () => {
  const request: GrowthComparisonRequest = { master, cards: [], xp: 0, target: 'demon' };
  for (const patch of [{ xp: -1 }, { xp: NaN }, { xp: Infinity }, { xp: 0.5 }, { target: 'bogus' }]) {
    assert.throws(() => compareGrowthCandidates({ ...request, ...patch }));
  }
});
const real: GrowthMaster = JSON.parse(readFileSync(new URL('../public/growth/master.json', import.meta.url), 'utf8'));
test('production master covers every catalog card and references only valid IDs', () => {
  const catalog = JSON.parse(readFileSync(new URL('../public/scanner/cards.json', import.meta.url), 'utf8')).cards;
  assert.deepEqual(new Set(real.cards.map(c => c.id)), new Set(catalog.map((c: { id: string }) => c.id)));
  const ids = new Set(real.cards.map(c => c.id)), targets = new Set(real.targets.map(t => t.id));
  assert.equal(real.books.length, 259);
  for (const b of real.books) {
    assert(b.cardIds.every(id => ids.has(id))); assert.equal(new Set(b.cardIds).size, b.cardIds.length);
    for (const e of b.effects) { assert(targets.has(e.target)); assert(e.value > 0); assert(e.threshold >= 0); assert(e.requiredCount <= b.cardIds.length); }
  }
});
test('sourced legendary costs and Totoyk additive damage milestones', () => {
  const legendary = real.cards.find(c => c.id === '3200001')!;
  assert.deepEqual(legendary.steps.map(s => s.xp), [29000, 43000, 65000, 97000, 194000]);
  assert.deepEqual(legendary.steps.map(s => s.silver), [48500, 74500, 112500, 165500, 316000]);
  const book = real.books.find(b => b.id === '7')!;
  assert.deepEqual(book.effects.map(e => [e.threshold, e.target, e.value]), [[20, '126', 6], [40, '126', 7], [50, '126', 7]]);
});
test('current book effects use only confirmed awakening totals', () => {
  const cards = [owned('a', 1, 2), owned('b', 1, 2), owned('c', 0, 3)];
  const progress = currentBookProgress(master, cards);
  assert.deepEqual(progress.targets.map(t => [t.id, t.current]), [['demon', 6], ['human', 0]]);
  assert.equal(progress.books[0].sum, 2);
  assert.deepEqual(progress.books[0].effects.map(e => e.active), [true, false]);
  assert.equal(progress.activeEffects, 1);
});

test('unregistered and unreadable cards are distinguished without inventing awakening totals', () => {
  for (const cards of [[owned('a', 1, 2)], [owned('a'), owned('b'), owned('b')]]) {
    const progress = currentBookProgress(master, cards);
    assert.equal(progress.books[0].sum, null);
    assert.equal(progress.books[0].effects[0].active, null);
    const ambiguous = cards.length > 1;
    assert.equal(progress.targets[0].unknownBooks, ambiguous ? 1 : 0);
    assert.deepEqual(progress.books[0].unregistered, ambiguous ? [] : ['b']);
    assert.deepEqual(progress.books[0].unreadable, ambiguous ? ['b'] : []);
    assert.equal(progress.targets[0].current, 0);
  }
});

test('all production effects include collection stats and count a grouped stat reward once', () => {
  const cards = real.cards.map(c => owned(c.id, c.steps.length, 0));
  const progress = currentBookProgress(real, cards);
  assert.equal(progress.totalEffects, 1036);
  assert.equal(progress.activeEffects, 1036);
  assert(progress.stats.find(s => s.name === '힘')!.current > 0);
  for (const s of progress.stats) { assert.equal(s.current, s.maximum); assert.equal(s.unknownBooks, 0); }
  for (const t of progress.targets) assert.equal(t.current, t.maximum);
  const t = progress.books.find(b => b.id === '7')!;
  assert.deepEqual(t.collectionEffects, [{ requiredCount: 10, stats: [{ stat: '16', value: 2 }], active: true }]);
  const partial = currentBookProgress(real, cards.filter(c => c.id !== t.cardIds[0]));
  assert.equal(partial.books.find(b => b.id === '7')!.collectionEffects[0].active, null);
  const specialty = partial.stats.find(s => s.id === '16')!;
  assert(specialty.current < specialty.maximum); assert.equal(specialty.unknownBooks, 0);
  assert.equal(specialty.maximum, progress.stats.find(s => s.id === '16')!.maximum);
  const empty = currentBookProgress(real, []);
  for (const s of empty.stats) { assert.equal(s.current, 0); assert.equal(s.maximum, progress.stats.find(full => full.id === s.id)!.maximum); }
});

test('actual read failures remain flagged alongside unregistered cards', () => {
  const m = structuredClone(master);
  m.stats = [{ id: '3', name: '힘' }];
  m.books[0].cardIds.push('c');
  m.books[0].collectionEffects = [{ requiredCount: 3, stats: [{ stat: '3', value: 5 }] }];
  for (const bad of [{ awakening: null }, { extraCopies: null }, { review: ['장수 확인'] }, { countReliable: false }]) {
    const p = currentBookProgress(m, [owned('a'), { ...owned('b'), ...bad }]);
    assert.deepEqual(p.books[0].unregistered, ['c']);
    assert.deepEqual(p.books[0].unreadable, ['b']);
    assert.equal(p.targets[0].unknownBooks, 1);
    assert.equal(p.stats[0].unknownBooks, 1);
    assert.equal(p.stats[0].current, 0);
  }
});
