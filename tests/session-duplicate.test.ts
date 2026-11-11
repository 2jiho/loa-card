import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  collectFastDuplicateItems,
  hasCollectedNameCandidate,
  rankSlowDuplicateCandidates,
} from '../src/features/card-scanner/session/session-duplicate';
import type {NameAttempt} from '../src/features/card-scanner/recognition/name-diagnostics';

const catalog = [
  {id: 'a', name: '카멘', rarity: 1},
  {id: 'b', name: '베히모스', rarity: 1},
];

function attempt(text: string, confidence: number, candidates: {id: string; name: string; score: number}[]): NameAttempt {
  return {text, confidence, engine: 'paddle', variant: 'identity', reason: 'test', candidates};
}

test('fast duplicate collection accepts exact owned names even with low OCR confidence', () => {
  const item = {nameAttempts: [attempt('카멘', 10, [{id: 'a', name: '카멘', score: 1}])]};
  const collected = new Set(['a']);
  assert.deepEqual([...collectFastDuplicateItems([item], catalog, collected)], [item]);
});

test('fast duplicate collection accepts a clear fuzzy spelling of an owned card', () => {
  const item = {nameAttempts: [attempt('베히모쓰', 70, [
    {id: 'b', name: '베히모스', score: .9},
    {id: 'a', name: '카멘', score: .6},
  ])], };
  assert.deepEqual([...collectFastDuplicateItems([item], catalog, new Set(['b']))], [item]);
});

test('fast duplicate collection does not use an uncollected or weak candidate', () => {
  const uncollected = {nameAttempts: [attempt('새 카드', 90, [{id: 'c', name: '새 카드', score: 1}])]};
  const weak = {nameAttempts: [attempt('베히모쓰', 70, [
    {id: 'b', name: '베히모스', score: .8},
    {id: 'a', name: '카멘', score: .7},
  ])]};
  assert.deepEqual([...collectFastDuplicateItems([uncollected, weak], catalog, new Set(['a', 'b']))], []);
});

test('fast duplicate collection preserves an existing target set', () => {
  const existing = {nameAttempts: []};
  const target = new Set([existing]);
  assert.equal(collectFastDuplicateItems([existing], catalog, new Set(), target), target);
  assert.deepEqual([...target], [existing]);
});

test('slow candidates put short texts first, then score and confidence', () => {
  const short = {nameAttempts: [attempt('카멘', 50, [{id: 'a', name: '카멘', score: .8}])]};
  const longHigh = {nameAttempts: [attempt('피요르긴을 휘두르는 바훈투르', 60, [
    {id: 'a', name: '카멘', score: .9},
  ])]};
  const longLow = {nameAttempts: [attempt('다른 긴 이름', 90, [
    {id: 'a', name: '카멘', score: .7},
  ])]};
  const noMatch = {nameAttempts: [attempt('없는 카드', 99, [{id: 'z', name: '다른 카드', score: 1}])]};
  const ranked = rankSlowDuplicateCandidates([longLow, noMatch, longHigh, short], new Set(['a']));
  assert.deepEqual(ranked.map(({item}) => item), [short, longHigh, longLow]);
  assert.equal(ranked[0].textLength, 2);
});

test('slow candidates with the same score are ordered by confidence', () => {
  const low = {nameAttempts: [attempt('긴 이름 하나', 50, [{id: 'a', name: '카멘', score: .8}])]};
  const high = {nameAttempts: [attempt('긴 이름 둘', 90, [{id: 'a', name: '카멘', score: .8}])]};
  assert.deepEqual(rankSlowDuplicateCandidates([low, high], new Set(['a'])).map(({item}) => item), [high, low]);
});

test('hasCollectedNameCandidate checks any candidate id', () => {
  assert.equal(hasCollectedNameCandidate({nameAttempts: [attempt('x', 1, [
    {id: 'z', name: 'z', score: 1}, {id: 'a', name: '카멘', score: .5},
  ])]}, new Set(['a'])), true);
  assert.equal(hasCollectedNameCandidate({nameAttempts: []}, new Set(['a'])), false);
});
