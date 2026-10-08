import test from 'node:test';
import assert from 'node:assert/strict';
import { compareGrowthCandidates } from '../src/features/growth/optimizer';
import type { GrowthMaster, GrowthComparisonRequest, OwnedCard } from '../src/features/growth/optimizer';

const master: GrowthMaster = {
  version: 'test', targets: [{ id: 'demon', name: '악마' }, { id: 'human', name: '인간' }],
  cards: ['a', 'b'].map(id => ({ id, name: id, rarity: 0, steps: [{ xp: 10, silver: 20, copies: 1 }] })),
  books: ['a', 'b'].map((id, i) => ({ id, name: id, cardIds: [id], effects: [{ threshold: 1, requiredCount: 1, target: 'demon', value: i ? 2 : 10 }] })),
};
const owned = (id: string, extraCopies = 0): OwnedCard => ({ id, awakening: 0, extraCopies, review: [], countReliable: true });
const request = (overrides: Partial<GrowthComparisonRequest> = {}): GrowthComparisonRequest => ({ master, cards: [owned('a'), owned('b', 1)], xp: 20, target: 'demon', ...overrides });

test('a more efficient missing-card bundle ranks before an immediately available one without changing execution', () => {
  const r = compareGrowthCandidates(request());
  assert.equal(r.collectionCandidates[0].cards[0].id, 'a');
  assert.equal(r.collectionCandidates[0].missingCopies, 1);
  assert.equal(r.collectionCandidates[0].conditional, false);
  assert.equal(r.collectionCandidates[1].missingCopies, 0);
  assert.deepEqual(r.collectionCandidates.filter(c => c.status === 'ready').flatMap(c => c.available.cards.map(u => u.id)), ['b']);
  assert.equal(r.collectionCandidates.at(-1)!.available.gained, 2);
});

test('absent card needs registration plus awakening copies and remains explicitly hypothetical', () => {
  const r = compareGrowthCandidates(request({ cards: [owned('b', 1)] }));
  const candidate = r.collectionCandidates.find(c => c.cards.some(card => card.id === 'a'))!;
  assert.equal(candidate.missingCopies, 2);
  assert.equal(candidate.copies, 1);
  assert.equal(candidate.conditional, true);
  assert.equal(candidate.cards[0].absent, true);
  assert.equal(r.collectionCandidates.at(-1)!.available.gained, 2);
});

test('registration alone can complete an effect and uses no XP', () => {
  const m = structuredClone(master);
  m.books = [{ id: 'ab', name: 'ab', cardIds: ['a', 'b'], effects: [{ target: 'demon', requiredCount: 2, threshold: 1, value: 6 }] }];
  const r = compareGrowthCandidates(request({ master: m, cards: [{ ...owned('a'), awakening: 1 }] }));
  const c = r.collectionCandidates[0];
  assert.equal(c.xp, 0); assert.equal(c.efficiency, null); assert.equal(c.missingCopies, 1);
  assert.deepEqual(c.cards.map(card => [card.id, card.to]), [['b', 0]]);
  assert.equal(c.gain, 6); assert.equal(c.available.gained, 0);
});

test('unreliable or duplicate observations are excluded, never treated as missing', () => {
  for (const patch of [{ awakening: null }, { extraCopies: null }, { review: ['count'] }, { countReliable: false }]) {
    const r = compareGrowthCandidates(request({ cards: [{ ...owned('a'), ...patch }, owned('b', 1)] }));
    assert(r.collectionCandidates.every(c => c.cards.every(card => card.id !== 'a')));
  }
  const r = compareGrowthCandidates(request({ cards: [owned('a'), owned('a'), owned('b', 1)] }));
  assert(r.collectionCandidates.every(c => c.cards.every(card => card.id !== 'a')));
});

test('available copies are subtracted, overlapping selected effects counted once, other targets ignored', () => {
  const m = structuredClone(master);
  m.cards[0].steps.push({ xp: 20, silver: 40, copies: 2 });
  m.books[0].effects[0].threshold = 2;
  m.books.push({ id: 'overlap', name: 'overlap', cardIds: ['a'], effects: [{ target: 'demon', requiredCount: 1, threshold: 2, value: 4 }, { target: 'human', requiredCount: 1, threshold: 2, value: 100 }] });
  const cards = [{ ...owned('a', 1), awakening: 1 }, owned('b')];
  const r = compareGrowthCandidates(request({ master: m, cards, xp: 5 }));
  const c = r.collectionCandidates.find(c => c.cards.some(card => card.id === 'a'))!;
  assert.equal(c.xp, 20); assert.equal(c.missingCopies, 1); assert.equal(c.copies, 2);
  assert.equal(c.xpShortfall, 15); assert.equal(c.gain, 14); assert.equal(c.books.length, 2);
  assert.equal(cards[0].awakening, 1); assert.equal(cards[0].extraCopies, 1);
});

test('candidate totals agree with card rows and already complete effects give no recommendations', () => {
  const r = compareGrowthCandidates(request());
  for (const c of r.collectionCandidates) {
    for (const property of ['xp', 'silver', 'copies'] as const) assert.equal(c[property], c.cards.reduce((n, card) => n + card[property], 0));
    assert.equal(c.missingCopies, c.cards.reduce((n, card) => n + card.missing, 0));
  }
  assert.equal(compareGrowthCandidates(request({ cards: ['a', 'b'].map(id => ({ ...owned(id), awakening: 1 })) })).collectionCandidates.length, 0);
});

test('equivalent allocations of the same effects do not crowd out other books', () => {
  const m = structuredClone(master);
  m.books = [{ id: 'ab', name: 'ab', cardIds: ['a', 'b'], effects: [{ target: 'demon', threshold: 1, requiredCount: 2, value: 10 }] }];
  const r = compareGrowthCandidates(request({ master: m, cards: [owned('a', 1), owned('b', 1)] }));
  assert.equal(r.collectionCandidates.length, 1);
  assert.equal(r.collectionCandidates[0].missingCopies, 0);
});

test('all books retain candidates through their maximum milestone beyond twelve results and available budgets', () => {
  const m = structuredClone(master);
  m.cards = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, name: `c${i}`, rarity: 0,
    steps: [{ xp: 10, silver: 20, copies: 1 }, { xp: 20, silver: 40, copies: 2 }] }));
  m.books = m.cards.map(c => ({ id: c.id, name: c.name, cardIds: [c.id], effects: [1, 2].map(threshold => ({ threshold, requiredCount: 1, target: 'demon', value: threshold })) }));
  const r = compareGrowthCandidates(request({ master: m, cards: m.cards.map(c => owned(c.id)), xp: 0 }));
  assert.equal(r.collectionCandidates.length, 28);
  for (const card of m.cards) {
    const maximum = r.collectionCandidates.find(c => c.cards.some(u => u.id === card.id && u.to === 2));
    assert(maximum); assert.equal(maximum.gain, 2);
    assert.equal(maximum.available.missingCopies, 3); assert.equal(maximum.available.xpShortfall, 30);
  }
});

test('sequence carries cumulative XP shortfalls while retaining future collection steps', () => {
  const input = request();
  const zero = compareGrowthCandidates({ ...input, xp: 0 }).collectionCandidates;
  const rich = compareGrowthCandidates({ ...input, xp: 1000000 }).collectionCandidates;
  assert.deepEqual(zero.map(c => c.key), rich.map(c => c.key));
  assert.deepEqual(zero.map(c => [c.gain, c.xp, c.efficiency, c.missingCopies]), rich.map(c => [c.gain, c.xp, c.efficiency, c.missingCopies]));
  assert(zero.every(c => c.xpShortfall === c.cumulativeXp));
  assert(rich.every(c => c.xpShortfall === 0));
  assert.deepEqual(rich.map(c => c.status), ['cards-needed', 'ready']);
  assert.deepEqual(zero.map(c => c.status), ['cards-needed', 'xp-needed']);
  for (const xp of [-1, NaN, Infinity, 0.5]) assert.throws(() => compareGrowthCandidates({ ...input, xp }));
});
