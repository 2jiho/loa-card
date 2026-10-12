import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growthInput, resultCardsKey } from '../src/features/live-results';
import { currentBookProgress } from '../src/features/growth/optimizer';
import type { GrowthMaster } from '../src/features/growth/optimizer';
import type { ScannedCard } from '../src/features/card-scanner/recognizer';

const card: ScannedCard = { id: 'a', name: 'A', awakening: 0, extraCopies: 0, countReliable: true,
  review: [], image: '', confidence: 1, observations: 1, time: 0 };

test('progress, screenshots and duplicate observations do not trigger result calculations', () => {
  assert.equal(resultCardsKey([card]), resultCardsKey([{ ...card, image: 'new', time: 5, observations: 20, confidence: .99 }]));
  for (const change of [{ awakening: 1 }, { extraCopies: null }, { extraCopies: 1 },
    { countReliable: false }, { review: ['장수 확인'] }, { id: 'b' }, { name: 'B' }]) {
    assert.notEqual(resultCardsKey([card]), resultCardsKey([{ ...card, ...change }]));
  }
});

test('partial growth inventories preserve unknowns and never count missing cards as unregistered', () => {
  const master: GrowthMaster = { version: 'test', targets: [], cards: ['a','b'].map(id => ({ id, name: id, rarity: 0, steps: [] })),
    books: [{ id: 'book', name: 'Book', cardIds: ['a','b'], effects: [], collectionEffects: [{ requiredCount: 2, stats: [{ stat: '3', value: 2 }] }] }] };
  const input = [card];
  const partial = growthInput(input, master.cards, false);
  assert.equal(partial[0], card);
  assert.deepEqual(partial[1], { id: 'b', awakening: null, extraCopies: null, countReliable: false, review: ['미스캔'] });
  const book = currentBookProgress(master, partial).books[0];
  assert.deepEqual(book.unregistered, []);
  assert.deepEqual(book.unreadable, ['b']);
  assert.equal(currentBookProgress(master, partial).activeEffects, 0);
  assert.equal(growthInput(input, master.cards, true), input);
  const filled = growthInput([card, { ...card, id: 'b' }], master.cards, false);
  assert.equal(currentBookProgress(master, filled).activeEffects, 1);
  assert.equal(input.length, 1);
});
