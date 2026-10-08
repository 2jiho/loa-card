import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { GrowthMaster, OwnedCard } from '../src/features/growth/optimizer';
import { statCollectionPlans } from '../src/features/growth/stat-collection';

const owned = (id: string): OwnedCard => ({ id, awakening: 0, extraCopies: 0, review: [], countReliable: true });
const master: GrowthMaster = {
  version: 'test', targets: [], stats: [{ id: '3', name: '힘' }, { id: '16', name: '특화' }],
  cards: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, rarity: 0, steps: [{ xp: 10, silver: 10, copies: 1 }] })),
  books: [
    { id: 'ab', name: 'ab', cardIds: ['a', 'b'], effects: [], collectionEffects: [{ requiredCount: 2, stats: [{ stat: '3', value: 2 }] }] },
    { id: 'b', name: 'b', cardIds: ['b'], effects: [], collectionEffects: [{ requiredCount: 1, stats: [{ stat: '3', value: 3 }, { stat: '16', value: 100 }] }] },
    { id: 'cd', name: 'cd', cardIds: ['c', 'd'], effects: [], collectionEffects: [{ requiredCount: 2, stats: [{ stat: '3', value: 4 }] }] },
  ],
};

test('ranks combined selected-stat gain per new registration, without awakening or spare copies', () => {
  const cards = [owned('a')], snapshot = JSON.stringify(cards);
  const p = statCollectionPlans(master, cards, '3');
  assert.deepEqual(p.candidates[0].cards.map(c => c.id), ['b']);
  assert.equal(p.candidates[0].gain, 5); assert.equal(p.candidates[0].efficiency, 5);
  assert.equal(p.candidates[0].books.length, 2);
  assert.equal(p.candidates[1].gain, 4); assert.equal(p.candidates[1].efficiency, 2);
  assert.equal(p.stat!.current, 0); assert.equal(p.stat!.maximum, 9);
  assert.equal(JSON.stringify(cards), snapshot);
});

test('subset requirements recommend only the remaining needed registrations', () => {
  const m = structuredClone(master);
  m.books = [{ id: 'abc', name: 'abc', cardIds: ['a', 'b', 'c'], effects: [], collectionEffects: [{ requiredCount: 2, stats: [{ stat: '3', value: 2 }] }] }];
  const p = statCollectionPlans(m, [owned('a')], '3');
  assert.deepEqual(p.candidates.map(c => c.cards.map(x => x.id)), [['b'], ['c']]);
  assert(p.candidates.every(c => c.gain === 2));
  const done = statCollectionPlans(m, [owned('a'), owned('b')], '3');
  assert.equal(done.candidates.length, 0); assert.equal(done.stat!.current, done.stat!.maximum);
});

test('multiple collection thresholds reward only newly crossed effects', () => {
  const m = structuredClone(master);
  m.books = [{ id: 'abc', name: 'abc', cardIds: ['a', 'b', 'c'], effects: [], collectionEffects: [1, 2, 3].map(requiredCount => ({ requiredCount, stats: [{ stat: '3', value: requiredCount }] })) }];
  const p = statCollectionPlans(m, [owned('a')], '3');
  assert.equal(p.stat!.current, 1);
  assert.equal(p.candidates[0].gain, 5); assert.equal(p.candidates[0].cards.length, 2);
  assert.equal(p.candidates.find(c => c.cards.length === 1)!.gain, 2);
});

test('unreliable or duplicate rows are excluded instead of being called missing cards', () => {
  for (const cards of [[owned('a'), { ...owned('b'), review: ['name'] }], [owned('a'), owned('b'), owned('b')]]) {
    const p = statCollectionPlans(master, cards, '3');
    assert.deepEqual(p.excluded, ['ab', 'b']);
    assert(p.candidates.every(c => c.cards.every(card => card.id !== 'b')));
  }
});

test('production maximum collection gives no more recommendations for any stat', () => {
  const real: GrowthMaster = JSON.parse(readFileSync(new URL('../public/growth/master.json', import.meta.url), 'utf8'));
  const cards = real.cards.map(c => owned(c.id));
  for (const stat of real.stats!) {
    const p = statCollectionPlans(real, cards, stat.id);
    assert.equal(p.candidates.length, 0);
    assert.equal(p.stat!.current, p.stat!.maximum);
    assert.equal(p.excluded.length, 0);
  }
});
