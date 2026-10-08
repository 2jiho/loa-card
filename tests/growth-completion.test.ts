import test from 'node:test';
import assert from 'node:assert/strict';
import { completeGrowth, undoGrowth } from '../src/features/growth/complete-growth';
import { compareGrowthCandidates, currentBookProgress } from '../src/features/growth/optimizer';
import type { GrowthMaster } from '../src/features/growth/optimizer';
import type { ScannerState } from '../src/features/card-scanner/scanner';
import { consensus } from '../src/features/card-scanner/consensus';

const master: GrowthMaster = { version: 'test', targets: [{ id: 'd', name: '악마' }],
  cards: ['a', 'b'].map(id => ({ id, name: id, rarity: 0,
    steps: [{ xp: 10, silver: 10, copies: 1 }, { xp: 20, silver: 20, copies: 2 }] })),
  books: [{ id: 'a', name: '도감 A', cardIds: ['a'], effects: [
    { target: 'd', threshold: 1, requiredCount: 1, value: 10 },
    { target: 'd', threshold: 2, requiredCount: 1, value: 10 },
  ] }] };
const initial = (): ScannerState => ({ status: '완료', percent: 100, sampled: 1, stable: 1,
  expected: 2, capacity: 450, located: true, unreadable: 0, queued: 0, droppedFrames: 0, unidentified: [],
  growthPoints: { current: 50, maximum: 999 }, cards: ['a', 'b'].map(id => ({
    id, name: id, awakening: 0, extraCopies: 3, countReliable: true, review: [],
    confidence: 99, image: 'scan', time: 1, observations: 2, captureOrder: 1,
  })) });
const steps = (state: ScannerState) => compareGrowthCandidates({ master, cards: state.cards,
  xp: state.growthPoints!.current, target: 'd' }).collectionCandidates;

test('completion updates cards, XP and effects atomically without changing original input', () => {
  const before = initial(), snapshot = structuredClone(before);
  const after = completeGrowth(before, master, steps(before)[0]);
  assert.deepEqual(before, snapshot);
  assert.equal(after.cards[0].awakening, 1); assert.equal(after.cards[0].extraCopies, 2);
  assert.equal(after.cards[1], before.cards[1]);
  assert.equal(after.growthPoints!.current, 40); assert.equal(after.growthPointsEstimated, true);
  assert.equal(currentBookProgress(master, after.cards).targets[0].current, 10);
  assert.equal(after.growthHistory!.length, 1);
  assert.equal(steps(after)[0].available.cards[0].from, 1);
});

test('later rows cannot consume hypothetical prior upgrades, and double completion rejects', () => {
  const before = initial(), plan = steps(before);
  assert.throws(() => completeGrowth(before, master, plan[1]));
  const after = completeGrowth(before, master, plan[0]);
  assert.throws(() => completeGrowth(after, master, plan[0]));
});

test('undo restores exact card observations and XP through multiple completions and reload', () => {
  const before = initial();
  const one = completeGrowth(before, master, steps(before)[0]);
  const two = completeGrowth(one, master, steps(one)[0]);
  const reloaded = structuredClone(two);
  const undone = undoGrowth(reloaded);
  assert.deepEqual(undone, one);
  const restored = undoGrowth(undone);
  assert.deepEqual(restored.cards, before.cards);
  assert.deepEqual(restored.growthPoints, before.growthPoints);
  assert.equal(restored.growthPointsEstimated, false); assert.equal(restored.growthHistory!.length, 0);
  assert.equal(undoGrowth(before), before);
});

test('stale XP, missing or unreliable cards, invalid costs cannot partially apply', () => {
  const before = initial(), plan = steps(before)[0];
  for (const change of [
    (s: ScannerState) => { s.growthPoints = null; },
    (s: ScannerState) => { s.growthPoints!.current = 5; },
    (s: ScannerState) => { s.growthPoints!.current = 49; },
    (s: ScannerState) => { s.cards[0].countReliable = false; },
    (s: ScannerState) => { s.cards[0].extraCopies = 0; },
    (s: ScannerState) => { s.cards.shift(); },
    (s: ScannerState) => { s.cards.push({ ...s.cards[0] }); },
  ]) {
    const state = structuredClone(before); change(state); const copy = structuredClone(state);
    assert.throws(() => completeGrowth(state, master, plan)); assert.deepEqual(state, copy);
  }
  const bad = structuredClone(plan); bad.available.cards[0].copies = 0;
  assert.throws(() => completeGrowth(before, master, bad));
});

test('unavailable steps cannot be confirmed', () => {
  const before = initial();
  for (const status of ['cards-needed', 'xp-needed'] as const) {
    const step = steps(before)[0]; step.status = status;
    assert.throws(() => completeGrowth(before, master, step));
  }
});

test('fresh reliable scan replaces completed values instead of being locked by completion', () => {
  const before = initial(), after = completeGrowth(before, master, steps(before)[0]);
  const fresh = { ...before.cards[0], captureOrder: 2, awakening: 2, extraCopies: 0 };
  const merged = consensus([after.cards[0], fresh]);
  assert.equal(merged.awakening, 2); assert.equal(merged.extraCopies, 0);
  assert.deepEqual(merged.review, []); assert(!merged.manual?.length);
});

test('a better final reward still allows completing and undoing each intermediate milestone', () => {
  const m = structuredClone(master);
  m.books[0].effects[1].value = 100;
  const before = initial();
  const next = (s: ScannerState) => compareGrowthCandidates({ master: m, cards: s.cards,
    xp: s.growthPoints!.current, target: 'd' }).collectionCandidates[0];
  const first = next(before);
  assert.equal(first.available.cards[0].to, 1);
  const one = completeGrowth(before, m, first);
  assert.equal(one.growthPoints!.current, 40);
  const second = next(one);
  assert.deepEqual(second.milestones.map(m => [m.from, m.to]), [[1, 2]]);
  const two = completeGrowth(one, m, second);
  assert.equal(two.growthPoints!.current, 20);
  assert.equal(currentBookProgress(m, two.cards).targets[0].current, 110);
  assert.deepEqual(undoGrowth(two), one);
});
