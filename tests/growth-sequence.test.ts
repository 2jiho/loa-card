import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareGrowthCandidates } from '../src/features/growth/optimizer';
import type { GrowthCard, GrowthBook, GrowthMaster, OwnedCard } from '../src/features/growth/optimizer';

const card = (id: string, xp = 10): GrowthCard => ({ id, name: id, rarity: 0,
  steps: [{ xp, silver: xp, copies: 1 }, { xp: xp * 2, silver: xp * 2, copies: 2 }] });
const book = (id: string, cardIds: string[], threshold: number, value: number): GrowthBook => ({ id, name: id, cardIds,
  effects: [{ target: 'demon', threshold, value, requiredCount: cardIds.length }] });
const owned = (id: string, extraCopies = 3): OwnedCard => ({ id, awakening: 0, extraCopies, review: [], countReliable: true });
const master = (cards: GrowthCard[], books: GrowthBook[]): GrowthMaster => ({ version: 'test', targets: [{ id: 'demon', name: '악마' }], cards, books });
const run = (master: GrowthMaster, cards: OwnedCard[], xp: number) => compareGrowthCandidates({ master, cards, xp, target: 'demon' }).collectionCandidates;

test('intermediate rewards rank on their own efficiency even when the final bundle is better', () => {
  const staged = book('staged', ['a'], 1, 1);
  staged.effects.push({ target: 'demon', threshold: 2, value: 100, requiredCount: 1 });
  const m = master([card('a'), card('b', 5)], [staged, book('other', ['b'], 1, 2)]);
  const steps = run(m, [owned('a'), owned('b')], 100);
  assert.deepEqual(steps.map(s => s.books[0]), ['other', 'staged', 'staged']);
  assert.deepEqual(steps.map(s => s.xp), [5, 10, 20]);
  assert.deepEqual(steps.slice(1).map(s => [s.milestones[0].from, s.milestones[0].to]), [[0, 1], [1, 2]]);
});

test('a shared-card recommendation cannot jump over two rewards in another book', () => {
  const staged = book('staged', ['a'], 1, 1);
  staged.effects.push({ target: 'demon', threshold: 2, value: 1, requiredCount: 1 });
  const m = master([card('a')], [staged, book('shared', ['a'], 2, 100)]);
  const steps = run(m, [owned('a')], 100);
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map(s => s.cards[0].to), [1, 2]);
  assert.deepEqual(steps.map(s => s.gain), [1, 101]);
});

test('Field Boss II shows the 28 and 35 milestones with optimal incremental XP allocations', () => {
  const real: GrowthMaster = JSON.parse(readFileSync(new URL('../public/growth/master.json', import.meta.url), 'utf8'));
  const b = real.books.find(b => b.id === '170')!;
  const m = { ...real, books: [b], cards: real.cards.filter(c => b.cardIds.includes(c.id)) };
  const cards = m.cards.map(c => {
    const awakening = c.id === '3200154' ? 1 : c.id === '3200182' ? 3 : 2;
    return { ...owned(c.id, 15 - awakening * (awakening + 1) / 2), awakening };
  });
  const steps = compareGrowthCandidates({ master: m, cards, xp: 491550, target: '125' }).collectionCandidates;
  assert.deepEqual(steps.map(s => [s.milestones[0].from, s.milestones[0].to, s.xp, s.gain]),
    [[14, 28, 370000, 7], [28, 35, 343000, 7]]);
  assert(steps[0].cards.every(c => c.to === 4));
  assert(steps[1].cards.every(c => c.from === 4 && c.to === 5));
  assert.deepEqual(steps.map(s => s.available.copies), [48, 35]);
  assert.deepEqual(steps.map(s => s.status), ['ready', 'xp-needed']);
  const blocked = compareGrowthCandidates({ master: m, cards, xp: 0, target: '125' }).collectionCandidates;
  assert.deepEqual(blocked.map(s => s.available.xp), [370000, 713000]);
  assert(blocked.every(s => s.available.usedXp === 0));
});

test('missing-card upgrade keeps its rank but spends no resources and later owned cards can run', () => {
  const m = master([card('a'), card('b'), card('c')], [book('a', ['a'], 1, 10), book('b', ['b'], 1, 5), book('c', ['c'], 1, 100)]);
  const steps = run(m, [owned('a'), owned('b'), owned('c', 0)], 15);
  assert.deepEqual(steps.map(s => s.books[0]), ['c', 'a', 'b']);
  assert.deepEqual(steps.map(s => s.status), ['cards-needed', 'ready', 'xp-needed']);
  assert.deepEqual(steps.map(s => s.available.usedXp), [0, 10, 10]);
  assert.deepEqual(steps.map(s => s.available.gained), [0, 10, 10]);
  assert.deepEqual(steps.map(s => s.available.remainingXp), [15, 5, 5]);
  assert.deepEqual(steps.map(s => s.available.xpShortfall), [0, 0, 5]);
  assert.deepEqual(steps.map(s => s.missingCopies), [1, 0, 0]);
  assert.deepEqual(steps.map(s => s.prerequisiteMissingCopies), [0, 1, 1]);
  assert.deepEqual(steps.map(s => s.cumulativeXp), [10, 20, 30]);
  assert.deepEqual(steps.map(s => s.remainingXp), [5, 0, 0]);
  assert.deepEqual(steps.map(s => s.xpShortfall), [0, 5, 15]);
});

test('efficient but unaffordable combinations rank before affordable ones at every budget', () => {
  const m = master([card('a', 20), card('b', 5)], [book('a', ['a'], 1, 100), book('b', ['b'], 1, 1)]);
  const steps = run(m, [owned('a'), owned('b')], 5);
  assert.deepEqual(steps.map(s => s.books[0]), ['a', 'b']);
  assert.deepEqual(steps.map(s => s.status), ['xp-needed', 'ready']);
  assert.equal(steps[0].available.usedXp, 0);
  assert.equal(steps[1].available.usedXp, 5);
  assert.equal(steps[1].available.gained, 1);
  assert.equal(steps[1].xpShortfall, 20);
  for (const xp of [0, 20, 25, 1000]) {
    assert.deepEqual(run(m, [owned('a'), owned('b')], xp).map(s => [s.key, s.xp, s.gain]), steps.map(s => [s.key, s.xp, s.gain]));
  }
});

test('same combination upgrades from its previous milestone using only incremental copies and XP', () => {
  const m = master([card('a')], [book('first', ['a'], 1, 10), book('last', ['a'], 2, 5)]);
  const inventory = [owned('a')], snapshot = structuredClone(inventory);
  const steps = run(m, inventory, 29);
  assert.deepEqual(steps.map(s => [s.cards[0].from, s.cards[0].to, s.xp, s.copies, s.gain]), [[0, 1, 10, 1, 10], [1, 2, 20, 2, 5]]);
  assert.equal(steps[1].cumulativeXp, 30);
  assert.equal(steps[1].cumulativeGain, 15);
  assert.equal(steps[1].xpShortfall, 1);
  assert.deepEqual(inventory, snapshot);
  assert(run(m, inventory, 30).every(s => s.status === 'ready'));
});

test('shared card growth is reused across books and changes the next efficiency ranking', () => {
  const cards = [card('a'), card('b'), card('c'), card('d')].map(c => ({ ...c, steps: c.steps.slice(0, 1) }));
  const m = master(cards, [book('ab', ['a', 'b'], 2, 20), book('ac', ['a', 'c'], 2, 8), book('d', ['d'], 1, 6)]);
  const steps = run(m, cards.map(c => owned(c.id, 1)), 100);
  assert.deepEqual(steps.map(s => s.books[0]), ['ab', 'ac', 'd']);
  assert.deepEqual(steps[1].cards.map(c => c.id), ['c']);
  assert.equal(steps[1].xp, 10);
  assert.equal(steps.at(-1)!.cumulativeXp, 40);
  assert.equal(steps.at(-1)!.cumulativeGain, 34);
});

test('previously consumed copies cannot be reused for the next milestone', () => {
  const m = master([card('a')], [book('first', ['a'], 1, 10), book('last', ['a'], 2, 5)]);
  const steps = run(m, [owned('a', 2)], 100);
  assert.equal(steps[0].status, 'ready');
  assert.equal(steps[1].status, 'cards-needed');
  assert.equal(steps[1].missingCopies, 1);
});

test('hypothetical registration occurs once and prerequisite shortages stay blocked', () => {
  const m = master([card('a'), card('b')], [book('first', ['a', 'b'], 1, 10), book('last', ['a', 'b'], 2, 5)]);
  m.cards[0].steps = [];
  const steps = run(m, [owned('b')], 100);
  assert.equal(steps[0].missingCopies, 1);
  assert.equal(steps[0].cards.find(c => c.id === 'a')!.absent, true);
  assert.equal(steps[1].missingCopies, 0);
  assert.equal(steps[1].prerequisiteMissingCopies, 1);
  assert.equal(steps[1].status, 'cards-needed');
  assert.equal(steps[1].conditional, true);
  assert.equal(steps[1].cards.some(c => c.id === 'a'), false);
  assert.equal(steps[1].available.cards.find(c => c.id === 'a')!.absent, true);
  assert.equal(steps[1].available.missingCopies, 1);
  assert.equal(steps[1].available.usedXp, 0);
  assert.equal(steps[1].available.xp, 30);
});

test('later shared-book upgrade restores skipped prerequisites and credits only actually completed effects', () => {
  const cards = [card('a'), card('b'), card('c')].map(c => ({ ...c, steps: c.steps.slice(0, 1) }));
  const m = master(cards, [book('ab', ['a', 'b'], 2, 20), book('ac', ['a', 'c'], 2, 8)]);
  const inventory = [owned('a', 1), owned('b', 0), owned('c', 1)];
  const steps = run(m, inventory, 20);
  assert.deepEqual(steps.map(s => s.books), [['ab'], ['ac']]);
  assert.deepEqual(steps.map(s => s.status), ['cards-needed', 'ready']);
  assert.equal(steps[1].xp, 10);
  assert.equal(steps[1].available.xp, 20);
  assert.equal(steps[1].available.gained, 8);
  assert.equal(steps[1].available.usedXp, 20);
  assert.deepEqual(steps[1].available.cards.map(c => [c.id, c.from, c.to]), [['a', 0, 1], ['c', 0, 1]]);
  const tight = run(m, inventory, 15);
  assert.equal(tight[1].status, 'xp-needed');
  assert.equal(tight[1].available.xpShortfall, 5);
  assert.equal(tight[1].available.usedXp, 0);
});

test('skipped earlier awakening is not granted free to a later milestone of the same card', () => {
  const m = master([card('a')], [book('first', ['a'], 1, 10), book('last', ['a'], 2, 5)]);
  const steps = run(m, [owned('a', 0)], 100);
  assert.equal(steps[1].xp, 20);
  assert.equal(steps[1].available.xp, 30);
  assert.equal(steps[1].available.missingCopies, 3);
  assert.equal(steps[1].available.cards[0].from, 0);
  assert.equal(steps[1].available.gain, 15);
  assert.equal(steps[1].available.gained, 0);
});

test('uncertain and duplicate inventory is excluded throughout sequential simulation', () => {
  const m = master([card('a'), card('b')], [book('a', ['a'], 1, 100), book('b', ['b'], 1, 1)]);
  for (const cards of [[{ ...owned('a'), countReliable: false }, owned('b')], [owned('a'), owned('a'), owned('b')]]) {
    assert.deepEqual(run(m, cards, 100).flatMap(s => s.cards.map(c => c.id)), ['b']);
  }
});

test('zero XP upgrades are finite and ready even with no budget', () => {
  const m = master([card('a', 0)], [book('a', ['a'], 1, 2)]);
  const steps = run(m, [owned('a')], 0);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].efficiency, null);
  assert.equal(steps[0].status, 'ready');
});

const fullMaster: GrowthMaster = JSON.parse(readFileSync(new URL('../public/growth/master.json', import.meta.url), 'utf8'));
for (const target of fullMaster.targets) test(`full catalog conserves costs and reaches every ${target.name} effect once`, () => {
  const m = fullMaster;
  const inventory = m.cards.map(c => owned(c.id, c.steps.reduce((n, s) => n + s.copies, 0)));
  const steps = compareGrowthCandidates({ master: m, cards: inventory, xp: 100000, target: target.id }).collectionCandidates;
  const catalog = new Map(m.cards.map(c => [c.id, c]));
  const levels = new Map(inventory.map(c => [c.id, 0]));
  let totalXp = 0, totalGain = 0;
  const score = () => m.books.reduce((n, b) => n + b.effects.filter(e => e.target === target.id && b.cardIds.length >= e.requiredCount &&
    b.cardIds.reduce((s, id) => s + levels.get(id)!, 0) >= e.threshold).reduce((s, e) => s + e.value, 0), 0);
  const baseline = score();
  const actualLevels = new Map(levels);
  const copies = new Map(inventory.map(c => [c.id, c.extraCopies!]));
  let spent = 0;
  for (const step of steps) {
    const before = score();
    for (const c of step.cards) {
      assert.equal(c.from, levels.get(c.id));
      const costs = catalog.get(c.id)!.steps.slice(c.from, c.to);
      assert.equal(c.xp, costs.reduce((n, s) => n + s.xp, 0));
      assert.equal(c.copies, costs.reduce((n, s) => n + s.copies, 0));
      levels.set(c.id, c.to);
    }
    assert.equal(step.gain, score() - before);
    totalXp += step.xp; totalGain += step.gain;
    assert.equal(step.cumulativeXp, totalXp);
    assert.equal(step.cumulativeGain, totalGain);
    const a = step.available;
    assert.equal(step.status, a.xp <= 100000 - spent ? 'ready' : 'xp-needed');
    for (const c of a.cards) {
      assert.equal(c.from, actualLevels.get(c.id));
      assert.equal(c.xp, catalog.get(c.id)!.steps.slice(c.from, c.to).reduce((n, s) => n + s.xp, 0));
    }
    assert.equal(a.xp, a.cards.reduce((n, c) => n + c.xp, 0));
    if (step.status === 'ready') {
      spent += a.xp;
      for (const c of a.cards) {
        assert(copies.get(c.id)! >= c.copies);
        copies.set(c.id, copies.get(c.id)! - c.copies);
        actualLevels.set(c.id, c.to);
      }
    }
    assert.equal(a.usedXp, spent);
    assert.equal(a.remainingXp, 100000 - spent);
    const actualScore = m.books.reduce((n, b) => n + b.effects.filter(e => e.target === target.id && b.cardIds.length >= e.requiredCount &&
      b.cardIds.reduce((s, id) => s + actualLevels.get(id)!, 0) >= e.threshold).reduce((s, e) => s + e.value, 0), 0);
    assert.equal(a.gained, actualScore - baseline);
  }
  const maximum = m.books.reduce((n, b) => n + b.effects.filter(e => e.target === target.id).reduce((s, e) => s + e.value, 0), 0);
  assert.equal(totalGain + baseline, maximum);
});
