import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { growthDisplayRows } from '../src/features/growth/growth-display';
import { compareGrowthCandidates, type GrowthMaster } from '../src/features/growth/optimizer';
import { completeGrowth, undoGrowth } from '../src/features/growth/complete-growth';
import type { ScannerState } from '../src/features/card-scanner/scanner';

const master: GrowthMaster = { version: 'test', targets: [{ id: 'd', name: '악마' }],
  cards: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, name: id, rarity: 0,
    steps: [{ xp: [10, 20, 1000, 40][i], silver: 10, copies: 1 }, { xp: 30, silver: 20, copies: 2 }] })),
  books: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, cardIds: [id], effects: [
    { target: 'd', threshold: 1, requiredCount: 1, value: id === 'c' ? 100000 : id === 'd' ? 1 : 100 },
    ...(id === 'a' ? [{ target: 'd', threshold: 2, requiredCount: 1, value: 100 }] : []),
  ] })) };
function initial(xp = 100): ScannerState {
  return { status: '완료', percent: 100, sampled: 1, stable: 1, expected: 3, capacity: 450,
    located: true, unreadable: 0, queued: 0, droppedFrames: 0, unidentified: [],
    growthPoints: { current: xp, maximum: 999999 }, cards: ['a', 'b', 'd'].map(id => ({
      id, name: id, awakening: 0, extraCopies: 3, countReliable: true, review: [],
      confidence: 99, image: '', time: 1, observations: 2, captureOrder: 1,
    })) };
}
const plan = (state: ScannerState, m = master) => compareGrowthCandidates({ master: m,
  cards: state.cards, xp: state.growthPoints!.current, target: 'd' }).collectionCandidates;

test('repeated cards merge through intervening executable stages, preserving efficiency ranks and input', () => {
  const sequence = plan(initial()), before = structuredClone(sequence), rows = growthDisplayRows(sequence);
  assert.deepEqual(sequence.map(s => s.books[0]), ['c', 'a', 'b', 'a', 'd']);
  assert.deepEqual(rows.map(row => row.rank), [1, 2, 5]);
  assert.equal(rows[0].step, sequence[0]);
  assert.equal(rows[2].step, sequence[4]);
  assert.deepEqual(rows[1].stages.map(s => s.rank), [2, 3, 4]);
  assert.deepEqual(rows[1].step.available.cards.map(c => [c.id, c.from, c.to]), [['a', 0, 2], ['b', 0, 1]]);
  assert.equal(rows[1].step.available.xp, 60);
  assert.equal(rows[1].step.available.gain, 300);
  assert.equal(rows[1].step.available.remainingXp, 40);
  assert.deepEqual(sequence, before);
});

test('budget boundary never merges unaffordable future stages and skips missing cards', () => {
  for (const xp of [0, 29, 30, 59, 60, 100]) {
    const sequence = plan(initial(xp)), rows = growthDisplayRows(sequence);
    assert.deepEqual(rows.filter(r => r.step.status !== 'ready').map(r => r.step), sequence.filter(s => s.status !== 'ready'));
    const ready = rows.filter(r => r.step.status === 'ready');
    const ids = ready.flatMap(r => r.step.available.cards.map(c => c.id));
    assert.equal(new Set(ids).size, ids.length);
    assert(ready.reduce((n, r) => n + r.step.available.xp, 0) <= xp);
    if (xp === 59) assert.equal(ready[0].step.available.cards[0].to, 1);
    if (xp === 60) assert.equal(ready[0].step.available.cards[0].to, 2);
  }
});

test('unavailable interleaved rows remain visible and never enter a bundle', () => {
  const m = structuredClone(master); m.books[2].effects[0].value = 4000;
  const sequence = plan(initial(), m), rows = growthDisplayRows(sequence);
  assert.deepEqual(sequence.map(s => s.books[0]), ['a', 'b', 'c', 'a', 'd']);
  assert.deepEqual(rows.map(r => r.rank), [1, 3, 5]);
  assert.deepEqual(rows[0].stages.map(s => s.rank), [1, 2, 4]);
  assert.equal(rows[1].step, sequence[2]);
  assert.equal(rows[0].step.available.xp, 60);
});

test('bundle completion equals individual completions and is atomic, stale-safe, undoable', () => {
  const before = initial(), rows = growthDisplayRows(plan(before));
  const bundle = rows[1].step;
  let sequential = before;
  for (let i = 0; i < 3; i++) sequential = completeGrowth(sequential, master, plan(sequential).find(s => s.status === 'ready')!);
  const after = completeGrowth(before, master, bundle);
  assert.deepEqual(after.cards, sequential.cards);
  assert.deepEqual(after.growthPoints, sequential.growthPoints);
  assert.equal(after.growthHistory!.length, 1);
  assert.throws(() => completeGrowth(after, master, bundle));
  assert.throws(() => completeGrowth(before, master, rows[2].step));
  const stale = structuredClone(before); stale.growthPoints!.current--;
  assert.throws(() => completeGrowth(stale, master, bundle));
  const undone = undoGrowth(structuredClone(after));
  assert.deepEqual(undone.cards, before.cards);
  assert.deepEqual(undone.growthPoints, before.growthPoints);
  assert.equal(undone.growthHistory!.length, 0);
});

test('zero-cost repeated stages remain completable without spending XP', () => {
  const m = structuredClone(master); m.cards[0].steps.forEach(s => { s.xp = 0; });
  const before = initial(0), rows = growthDisplayRows(plan(before, m));
  const step = rows.find(r => r.step.status === 'ready')!.step;
  assert.equal(step.efficiency, null);
  assert.equal(step.available.cards[0].to, 2);
  assert.equal(completeGrowth(before, m, step).growthPoints!.current, 0);
});

test('inconsistent card transitions fail back to original stages', () => {
  const sequence = plan(initial()); sequence[3].available.cards[0].from = 0;
  assert.deepEqual(growthDisplayRows(sequence).map(row => row.step), sequence);
});

test('real catalog bundles preserve per-card costs, intermediate stages and the execution ledger', () => {
  const m: GrowthMaster = JSON.parse(readFileSync(new URL('../public/growth/master.json', import.meta.url), 'utf8'));
  const state = initial(500000);
  state.cards = m.cards.map(c => ({ ...state.cards[0], id: c.id, name: c.name, extraCopies: 15 }));
  const sequence = compareGrowthCandidates({ master: m, cards: state.cards, xp: state.growthPoints!.current,
    target: m.targets[0].id }).collectionCandidates;
  const rows = growthDisplayRows(sequence), ready = rows.filter(r => r.step.status === 'ready');
  assert(ready.length > 0);
  assert.deepEqual(rows.flatMap(r => r.stages).sort((a, b) => a.rank - b.rank).map(s => s.step), sequence);
  const ids = ready.flatMap(r => r.step.available.cards.map(c => c.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const { step } of ready) {
    for (const card of step.available.cards) {
      const costs = m.cards.find(c => c.id === card.id)!.steps.slice(card.from, card.to);
      assert.equal(card.xp, costs.reduce((n, c) => n + c.xp, 0));
      assert.equal(card.copies, costs.reduce((n, c) => n + c.copies, 0));
    }
  }
  assert.equal(ready.reduce((n, r) => n + r.step.available.xp, 0), sequence.filter(s => s.status === 'ready').at(-1)!.available.usedXp);
  completeGrowth(state, m, ready[0].step);
});
