import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canClassifyFinalDuplicates, finalDuplicateIdentity, exactDuplicateFromAttempts, fuzzyDuplicateFromAttempts} from '../src/features/card-scanner/session/final-duplicate';
import type {CatalogName} from '../src/features/card-scanner/recognition/card-dictionary';
import type {NameAttempt} from '../src/features/card-scanner/recognition/name-diagnostics';

const cards: CatalogName[] = [
  {id: 'saika', name: '사이카', rarity: 3},
  {id: 'chaos', name: '혼돈의 사이카', rarity: 3},
  {id: 'gehenna', name: '악몽의 게헤나', rarity: 3},
  {id: 'other', name: '다른 카드', rarity: 3},
];
const reading = (id: string, name: string, confidence = 80, exact = true) => ({card: {id, name}, exact, ocrConfidence: confidence});

test('an exact already-collected name is a duplicate only when every longer competitor is collected', () => {
  assert.equal(finalDuplicateIdentity(reading('saika', '사이카'), cards, new Set(['saika', 'chaos'])), 'saika');
  assert.equal(finalDuplicateIdentity(reading('saika', '사이카'), cards, new Set(['saika'])), null,
    'the longer uncollected competitor could be the missing card');
  assert.equal(finalDuplicateIdentity(reading('gehenna', '악몽의 게헤나'), cards, new Set(['gehenna'])), 'gehenna');
});

test('exact OCR attempts can be duplicates without another OCR call', () => {
  const attempt = (text: string, confidence: number, id: string, name: string): NameAttempt => ({
    text, confidence, engine: 'paddle', variant: 'identity', reason: 'test',
    candidates: [{id, name, score: 1}],
  });
  const all = new Set(['saika', 'chaos', 'gehenna', 'other']);
  assert.equal(exactDuplicateFromAttempts([attempt('사이카', 80, 'saika', '사이카')], cards, all), 'saika');
  assert.equal(exactDuplicateFromAttempts([attempt('사이', 80, 'saika', '사이카')], cards, all), null);
  assert.equal(exactDuplicateFromAttempts([attempt('사이카', 59, 'saika', '사이카')], cards, all), null);
  assert.equal(exactDuplicateFromAttempts([attempt('사이카', 59, 'saika', '사이카')], cards, all,
    {exactTextBypassesConfidence: true}), 'saika');
  assert.equal(exactDuplicateFromAttempts([attempt('사이카', 80, 'saika', '사이카')], cards, new Set(['saika'])), null);
});

test('a full-inventory scan may relax the longer-name check for an owned exact card', () => {
  assert.equal(finalDuplicateIdentity(reading('saika', '사이카'), cards, new Set(['saika']), {requireCollectedCompetitors: false}), 'saika');
  const attempt = (text: string, confidence: number, id: string, name: string): NameAttempt => ({
    text, confidence, engine: 'paddle', variant: 'identity', reason: 'test',
    candidates: [{id, name, score: 1}],
  });
  assert.equal(exactDuplicateFromAttempts([attempt('사이카', 80, 'saika', '사이카')], cards, new Set(['saika']),
    {requireCollectedCompetitors: false}), 'saika');
});

test('non-exact, low-confidence, missing, or uncollected readings are never duplicates', () => {
  const all = new Set(['saika', 'chaos', 'gehenna', 'other']);
  assert.equal(finalDuplicateIdentity(reading('saika', '사이카', 80, false), cards, all), null);
  assert.equal(finalDuplicateIdentity(reading('saika', '사이카', 59.9), cards, all), null);
  assert.equal(finalDuplicateIdentity(reading('saika', '사이카', NaN), cards, all), null);
  assert.equal(finalDuplicateIdentity(reading('missing', '없는 카드'), cards, all), null);
  assert.equal(finalDuplicateIdentity(null, cards, all), null);
  assert.equal(finalDuplicateIdentity(reading('other', '다른 카드'), cards, all), 'other');
});

test('a full inventory may classify a close spelling of an owned card as a duplicate', () => {
  const attempt = (text: string, score: number, second: number, id = 'saika', name = '사이카'): NameAttempt => ({
    text, confidence: 20, engine: 'paddle', variant: 'identity', reason: 'test',
    candidates: [{id, name, score}, {id: 'other', name: '다른 카드', score: second}],
  });
  const owned = new Set(['saika', 'other']);
  assert.equal(fuzzyDuplicateFromAttempts([attempt('사이카', .9, .3)], owned), 'saika');
  assert.equal(fuzzyDuplicateFromAttempts([attempt('사이카', .9, .8)], owned), null, 'close runner-up');
  assert.equal(fuzzyDuplicateFromAttempts([attempt('사이카', .8, .1)], owned), null, 'below score floor');
  assert.equal(fuzzyDuplicateFromAttempts([attempt('사', .9, .3)], owned), null, 'too short');
  assert.equal(fuzzyDuplicateFromAttempts([attempt('사이카', .9, .3)], new Set(['other'])), null, 'top not owned');
});

test('final duplicate classification accepts a full inventory or a pinned recognition-needed gap', () => {
  assert.equal(canClassifyFinalDuplicates(384, 384, 384, 0), true);
  assert.equal(canClassifyFinalDuplicates(383, 383, 384, 1), true);
  assert.equal(canClassifyFinalDuplicates(383, 383, 384, 0), false);
  assert.equal(canClassifyFinalDuplicates(383, 383, 384, 2), false);
  assert.equal(canClassifyFinalDuplicates(384, 383, 384, 1), false, 'duplicate IDs are not a full inventory');
  assert.equal(canClassifyFinalDuplicates(0, 0, null, 0), false);
  assert.equal(canClassifyFinalDuplicates(0, 0, 0, 0), false);
});
